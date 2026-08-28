import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Insumo, insumos, movimientosInsumo } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
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

export async function buscarInsumo(id: string): Promise<Insumo | undefined> {
  const [insumo] = await db.select().from(insumos).where(eq(insumos.id, id))
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

export async function crearInsumo(datos: {
  codigo: string
  nombre: string
  minimo: number
  equivalenciaPorKilo?: number | undefined
}): Promise<Insumo> {
  const [creado] = await db
    .insert(insumos)
    .values({
      codigo: datos.codigo,
      nombre: datos.nombre,
      minimo: datos.minimo,
      equivalenciaPorKilo:
        datos.equivalenciaPorKilo === undefined ? null : String(datos.equivalenciaPorKilo),
    })
    .returning()

  return creado!
}

export async function editarInsumo(
  id: string,
  cambios: {
    nombre?: string | undefined
    minimo?: number | undefined
    equivalenciaPorKilo?: number | undefined
    activo?: boolean | undefined
  },
): Promise<Insumo> {
  await exigirInsumo(id)

  const [actualizado] = await db
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

  return actualizado!
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
  registradoPor: string | null,
): Promise<Resultado> {
  await exigirInsumo(insumoId)

  if (!motivoEsSuficiente(datos.motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `el motivo necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: un ajuste que nadie pueda explicar dentro de tres meses no sirve como registro`,
    )
  }

  const comun = { insumoId, tipo: 'ajuste' as const, motivo: datos.motivo, registradoPor }

  return datos.diferencia > 0
    ? ingresar({ ...comun, cantidad: datos.diferencia }, db)
    : descontar({ ...comun, cantidad: -datos.diferencia }, db)
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
  registradoPor: string | null,
): Promise<Resultado> {
  await exigirInsumo(insumoId)

  if (datos.causa === 'otro' && !motivoEsSuficiente(datos.observaciones ?? '')) {
    throw new ErrorDeNegocio(
      'OBSERVACIONES_REQUERIDAS',
      422,
      `con causa "otro" hay que explicar qué pasó, en al menos ${LARGO_MINIMO_MOTIVO} caracteres`,
    )
  }

  return descontar(
    {
      insumoId,
      cantidad: datos.cantidad,
      tipo: 'descarte',
      causa: datos.causa,
      // Las observaciones viajan como motivo: el libro tiene un solo campo de
      // texto libre, y en un descarte lo que explica es la observación.
      motivo: datos.observaciones,
      registradoPor,
    },
    db,
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
