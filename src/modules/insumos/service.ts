import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Insumo, insumos, movimientosInsumo } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'
import type { Ejecutor } from '@/modules/stock/saldo'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { type Resultado, descontar, ingresar } from '@/modules/insumos/saldo'

/**
 * Insumos de empaque — M3, RN-INS-01 a 04.
 *
 * El servicio explica los errores; los invariantes viven en la base
 * ([ADR-0006](/decisiones/0006-invariantes-en-la-base/)). Un ajuste sin motivo
 * que entre por un script tiene que fallar aunque nunca pase por acá.
 */

/** Un insumo con lo que hace falta para decidir si hay que pedir más. */
export interface InsumoListado extends Insumo {
  /** `true` cuando el saldo cayó AL mínimo o por debajo — RN-INS-03. */
  bajoMinimo: boolean
}

export async function listarInsumos(incluirInactivos = false): Promise<InsumoListado[]> {
  const filas = await db.select().from(insumos).orderBy(asc(insumos.nombre))

  return filas
    .filter((i) => incluirInactivos || i.activo)
    .map((i) => ({
      ...i,
      // «Al mínimo o por debajo», no «por debajo». Avisar un paso después es
      // avisar cuando ya se consumió la reserva que el mínimo representaba.
      bajoMinimo: i.saldo <= i.minimo,
    }))
}

export async function buscarInsumo(
  id: string,
  ejecutor: Ejecutor = db,
): Promise<Insumo | undefined> {
  const [insumo] = await ejecutor.select().from(insumos).where(eq(insumos.id, id))
  return insumo
}

/*
 * Recibe el ejecutor porque `registrarEntrada` puede correr DENTRO de la
 * transacción de una compra a proveedor. Consultar con `db` desde ahí adentro
 * pide una conexión que la transacción ya tiene tomada: en tests, donde el pool
 * es de una sola conexión, eso es un deadlock —no un error—, y se manifiesta
 * como un test que nunca termina.
 */
async function exigirInsumo(id: string, ejecutor: Ejecutor = db): Promise<Insumo> {
  const [insumo] = await ejecutor.select().from(insumos).where(eq(insumos.id, id))
  if (!insumo) throw new ErrorDeNegocio('INSUMO_NO_ENCONTRADO', 404, 'no existe ese insumo')
  return insumo
}

export async function crearInsumo(
  datos: {
    codigo: string
    nombre: string
    minimo: number
    equivalenciaPorKilo?: number | undefined
  },
  contexto: ContextoDeAuditoria,
): Promise<Insumo> {
  return db.transaction(async (tx) => {
  const [creado] = await tx
    .insert(insumos)
    .values({
      codigo: datos.codigo,
      nombre: datos.nombre,
      minimo: datos.minimo,
      equivalenciaPorKilo:
        datos.equivalenciaPorKilo === undefined ? null : String(datos.equivalenciaPorKilo),
    })
    .returning()

    await emit(
      {
        ...contexto,
        action: 'insumos:ajustar',
        resource: 'insumos',
        resourceId: creado!.id,
        result: 'ok',
        payload: {
          operacion: 'alta',
          resourceId: creado!.id,
          codigo: creado!.codigo,
          nombre: creado!.nombre,
          minimo: creado!.minimo,
          equivalenciaPorKilo: creado!.equivalenciaPorKilo,
        },
      },
      tx,
    )

    return creado!
  })
}

export async function editarInsumo(
  id: string,
  cambios: {
    nombre?: string | undefined
    minimo?: number | undefined
    equivalenciaPorKilo?: number | undefined
    activo?: boolean | undefined
  },
  contexto: ContextoDeAuditoria,
): Promise<Insumo> {
  return db.transaction(async (tx) => {
  const previo = await exigirInsumo(id, tx)

  const [actualizado] = await tx
    .update(insumos)
    .set({
      ...(cambios.nombre !== undefined && { nombre: cambios.nombre }),
      ...(cambios.minimo !== undefined && { minimo: cambios.minimo }),
      ...(cambios.activo !== undefined && { activo: cambios.activo }),
      /*
       * Cambiar la equivalencia NO reescribe la historia: cada movimiento
       * guarda la que se usó ese día. Acá solo cambia la que se va a proponer
       * de acá en adelante.
       */
      ...(cambios.equivalenciaPorKilo !== undefined && {
        equivalenciaPorKilo: String(cambios.equivalenciaPorKilo),
      }),
    })
    .where(eq(insumos.id, id))
    .returning()

    /*
     * `cambios` lleva lo que VINO en el request, no los cuatro campos del
     * esquema: la edición es parcial, y un payload completo haría ver como que
     * se tocó todo cuando se movió solo el mínimo.
     */
    await emit(
      {
        ...contexto,
        action: 'insumos:ajustar',
        resource: 'insumos',
        resourceId: id,
        result: 'ok',
        payload: {
          operacion: 'editar',
          resourceId: id,
          codigo: previo.codigo,
          cambios,
        },
      },
      tx,
    )

    return actualizado!
  })
}

/**
 * Registra una compra: en unidades, o en kilos.
 *
 * ── Por qué una compra en kilos puede ser rechazada ──────────────────────────
 *
 * Cuántas unidades trae un kilo es una **medición de planta** y es distinta para
 * cada insumo — el grosor de la bolsa varía. Es la
 * [pregunta 37](/empezar/pendientes/), y todavía no se hizo.
 *
 * Mientras el insumo no tenga equivalencia, esto **falla y dice qué medir**, en
 * vez de estimar. Y esa es la decisión: una equivalencia inventada descuadra el
 * inventario **en silencio**, y el descuadre se descubre semanas después sin
 * forma de saber cuándo empezó. Un error ruidoso hoy vale más que un número
 * plausible que miente.
 *
 * La conversión se registra ENTERA en el movimiento —los kilos, la
 * equivalencia usada y las unidades resultantes— porque sin eso un descuadre es
 * imposible de reconstruir: no se sabe si se pesó mal, si la equivalencia
 * estaba vieja o si faltaron bolsas de verdad.
 */
export async function registrarEntrada(
  insumoId: string,
  datos: {
    cantidad?: number | undefined
    kilos?: number | undefined
    documentoId?: string | undefined
  },
  registradoPor: string | null,
  /*
   * Se recibe el ejecutor para que una compra a proveedor pueda escribir el
   * documento y esta entrada en LA MISMA transacción — M9, RN-PRO-05. Sin eso
   * habría que reimplementar la conversión kilo→unidad acá, y sería la segunda
   * copia de una regla que ya vive en un solo lugar.
   */
  ejecutor: Ejecutor = db,
): Promise<Resultado> {
  const insumo = await exigirInsumo(insumoId, ejecutor)

  if (datos.kilos === undefined) {
    return ingresar(
      {
        insumoId,
        cantidad: datos.cantidad!,
        tipo: 'compra',
        documentoId: datos.documentoId,
        registradoPor,
      },
      ejecutor,
    )
  }

  if (insumo.equivalenciaPorKilo === null) {
    throw new ErrorDeNegocio(
      'SIN_EQUIVALENCIA',
      422,
      `no sabemos cuántas unidades trae un kilo de ${insumo.nombre}, así que no podemos convertir la compra. Hay que pesar un paquete y contarlo, y cargar ese número en el insumo. Mientras tanto se puede registrar la entrada en unidades.`,
    )
  }

  const equivalencia = Number(insumo.equivalenciaPorKilo)
  const unidades = Math.round(datos.kilos * equivalencia)

  if (unidades < 1) {
    throw new ErrorDeNegocio(
      'CONVERSION_VACIA',
      422,
      `${datos.kilos} kg de ${insumo.nombre} no llega a una unidad con la equivalencia cargada`,
    )
  }

  return ingresar(
    {
      insumoId,
      cantidad: unidades,
      tipo: 'compra',
      conversion: { kilos: datos.kilos, equivalencia },
      documentoId: datos.documentoId,
      registradoPor,
    },
    ejecutor,
  )
}

/**
 * Ajusta el saldo contra un conteo físico — la diferencia va con signo.
 *
 * El motivo es obligatorio y lo exige un `CHECK`, además de este servicio: un
 * ajuste que nadie pueda explicar dentro de tres meses no sirve como registro.
 */
export async function ajustarInsumo(
  insumoId: string,
  datos: { diferencia: number; motivo: string },
  contexto: ContextoDeAuditoria,
): Promise<Resultado> {
  if (!motivoEsSuficiente(datos.motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `el motivo necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: un ajuste que nadie pueda explicar dentro de tres meses no sirve como registro`,
    )
  }

  return db.transaction(async (tx) => {
    const insumo = await exigirInsumo(insumoId, tx)
    const comun = {
      insumoId,
      tipo: 'ajuste' as const,
      motivo: datos.motivo,
      registradoPor: contexto.userId,
    }

    const resultado =
      datos.diferencia > 0
        ? await ingresar({ ...comun, cantidad: datos.diferencia }, tx)
        : await descontar({ ...comun, cantidad: -datos.diferencia }, tx)

    await auditarMovimiento(
      contexto,
      {
        operacion: 'ajuste',
        resourceId: insumoId,
        codigo: insumo.codigo,
        diferencia: datos.diferencia,
        motivo: datos.motivo,
      },
      resultado,
      tx,
    )

    return resultado
  })
}

/**
 * Descarta unidades que se rompieron o se mojaron.
 *
 * La causa es obligatoria (misma regla que RN-STK-06): sin clasificar, no se
 * descarta. Con causa `otro` hace falta explicar, porque `otro` no dice nada.
 */
export async function descartarInsumo(
  insumoId: string,
  datos: {
    cantidad: number
    causa: 'falla_produccion' | 'mal_manejo_cliente' | 'vencido' | 'otro'
    observaciones?: string | undefined
  },
  contexto: ContextoDeAuditoria,
): Promise<Resultado> {
  if (datos.causa === 'otro' && !motivoEsSuficiente(datos.observaciones ?? '')) {
    throw new ErrorDeNegocio(
      'OBSERVACIONES_REQUERIDAS',
      422,
      `con causa "otro" hay que explicar qué pasó, en al menos ${LARGO_MINIMO_MOTIVO} caracteres`,
    )
  }

  return db.transaction(async (tx) => {
    const insumo = await exigirInsumo(insumoId, tx)

    const resultado = await descontar(
      {
        insumoId,
        cantidad: datos.cantidad,
        tipo: 'descarte',
        causa: datos.causa,
        // Las observaciones viajan como motivo: el libro tiene un solo campo de
        // texto libre, y en un descarte lo que explica es la observación.
        motivo: datos.observaciones,
        registradoPor: contexto.userId,
      },
      tx,
    )

    await auditarMovimiento(
      contexto,
      {
        operacion: 'descarte',
        resourceId: insumoId,
        codigo: insumo.codigo,
        cantidad: datos.cantidad,
        causa: datos.causa,
        observaciones: datos.observaciones ?? null,
      },
      resultado,
      tx,
    )

    return resultado
  })
}

/**
 * La entrada de la RUTA de insumos — la que deja fila en la bitácora.
 *
 * `registrarEntrada` queda como primitiva y sin auditoría porque la comparte
 * `proveedores/compras.ts`, que la llama DENTRO de la transacción de la compra.
 * Si el emit viviera ahí, cada compra con insumos dejaría una fila
 * `insumos:ajustar` además de su `compras:crear`: dos filas para un solo hecho
 * de negocio, y la bitácora contaría entradas que nadie registró a mano.
 *
 * Dos funciones con nombres distintos dicen esa diferencia mejor que un
 * contexto opcional — que además sería el defecto que el guardián vigila: una
 * llamada que se olvida el contexto y no audita en silencio.
 */
export async function registrarEntradaAuditada(
  insumoId: string,
  datos: { cantidad?: number | undefined; kilos?: number | undefined; documentoId?: string | undefined },
  contexto: ContextoDeAuditoria,
): Promise<Resultado> {
  return db.transaction(async (tx) => {
    const insumo = await exigirInsumo(insumoId, tx)
    const resultado = await registrarEntrada(insumoId, datos, contexto.userId, tx)

    await auditarMovimiento(
      contexto,
      {
        operacion: 'entrada',
        resourceId: insumoId,
        codigo: insumo.codigo,
        /* Unidades O kilos, nunca las dos: van las dos claves y una es `null`,
         * para que la fila diga en qué se recibió. */
        cantidad: datos.cantidad ?? null,
        kilos: datos.kilos ?? null,
      },
      resultado,
      tx,
    )

    return resultado
  })
}

/**
 * Escribe la fila de un movimiento de saldo, se haya movido o no.
 *
 * `descontar` responde `{ ok: false, disponible }` en vez de lanzar: que no
 * alcance es un estado normal de la planta, no un error. Por eso ese intento no
 * pasa por el manejador de errores, y sin esta rama quedaría SIN RASTRO.
 *
 * Queda como `denied` con lo pedido y lo que de verdad había: «intentó
 * descartar 900 de las 500 que hay» es justo el patrón que una bitácora existe
 * para poder mostrar.
 */
async function auditarMovimiento(
  contexto: ContextoDeAuditoria,
  payload: Record<string, unknown>,
  resultado: Resultado,
  ejecutor: Ejecutor,
): Promise<void> {
  await emit(
    {
      ...contexto,
      action: 'insumos:ajustar',
      resource: 'insumos',
      resourceId: String(payload.resourceId),
      result: resultado.ok ? 'ok' : 'denied',
      payload: resultado.ok
        ? { ...payload, saldo: resultado.saldo }
        : { ...payload, disponible: resultado.disponible },
    },
    ejecutor,
  )
}

export async function movimientosDe(insumoId: string) {
  await exigirInsumo(insumoId)

  return db
    .select()
    .from(movimientosInsumo)
    .where(eq(movimientosInsumo.insumoId, insumoId))
    .orderBy(asc(movimientosInsumo.id))
}
