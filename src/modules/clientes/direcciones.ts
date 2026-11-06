import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Direccion, bases, direcciones, movimientosBase } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'
import { paraGuardar } from '@/modules/geografia/nombres'
import { basesPrestadasEn } from '@/modules/retornables/bases'
import { direccionLegible } from './direccion-legible'
import type { Transaccion } from '@/modules/stock/saldo'
import { clientePorId } from './service'

/**
 * Las direcciones de un cliente — RN-CLI-07.
 *
 * `Cliente 1—N Dirección`. Una base prestada se asigna a una dirección concreta,
 * no al cliente: sin eso no se puede contestar «¿a cuál de sus tres locales voy
 * a buscar la base #0913?», y el préstamo deja de ser reclamable.
 *
 * **Sin `ruta_id`**: las rutas son M8.
 */

export interface DatosDeDireccion {
  etiqueta: string

  /*
   * ── Todo lo demás es opcional, y es una decisión ─────────────────────────
   *
   * Aquazaku reparte en Campo de la Cruz y en pueblos vecinos. La nomenclatura
   * `CL 45 A # 12 B - 34` es urbana: hay direcciones que son «Vereda La Peña,
   * casa de tabla azul» y no se dejan descomponer.
   *
   * Exigir la estructura bloquearía el registro de un cliente REAL, y el
   * operador inventaría `CL 1 # 1-1` para poder guardar — perdiendo el dato y
   * ensuciando la base.
   */
  viaTipo?: string
  viaNumero?: string
  viaLetra?: string
  placaNumero?: string
  placaLetra?: string
  placaSegundo?: string
  placaLetraFinal?: string
  complemento?: string
  municipio?: string
  departamento?: string
  direccion?: string
  indicaciones?: string
  latitud?: number
  longitud?: number
}

/** Los campos de texto, para limpiarlos de una y no de a uno. */
const TEXTOS = [
  'viaTipo',
  'viaNumero',
  'viaLetra',
  'placaNumero',
  'placaLetra',
  'placaSegundo',
  'placaLetraFinal',
  'complemento',
  'municipio',
  'departamento',
  'direccion',
  'indicaciones',
] as const

/**
 * Agregar una dirección a un cliente.
 *
 * ── El `tx` no es una comodidad ─────────────────────────────────────────────
 *
 * El alta puede traer la dirección en el mismo pedido, y entonces cliente y
 * dirección tienen que entrar en una sola transacción: una dirección que no
 * ubica no puede dejar un cliente a medio cargar. Quien atiende creería que
 * quedó registrado y no sabría qué le falta.
 *
 * Cuando viene un `tx`, el cliente **lo acaba de crear esa misma transacción**
 * y todavía no es visible desde afuera — por eso no se vuelve a comprobar que
 * exista. Existe por construcción, y consultarlo con `db` daría «no existe».
 */
export async function agregarDireccion(
  clienteId: string,
  datos: DatosDeDireccion,
  tx?: Transaccion,
): Promise<Direccion> {
  if (!tx) await clientePorId(clienteId)

  const { etiqueta, limpios, coordenadas } = normalizar(datos)

  const [creada] = await (tx ?? db)
    .insert(direcciones)
    .values({ clienteId, etiqueta, ...limpios, ...coordenadas })
    .returning()

  return creada!
}

/**
 * Las reglas que comparten el alta y la edición.
 *
 * Duplicadas, la edición podría aceptar una dirección que el alta rechaza —y
 * nadie lo notaría hasta que alguien edite una y la deje sin nada que la
 * ubique.
 */
function normalizar(datos: DatosDeDireccion): {
  etiqueta: string
  limpios: Record<string, string | null>
  coordenadas: Record<string, string>
} {
  const etiqueta = datos.etiqueta.trim()

  if (etiqueta.length === 0) {
    throw new ErrorDeNegocio(
      'DIRECCION_SIN_ETIQUETA',
      422,
      'la dirección necesita cómo la llaman: «la casa», «el depósito». Es lo que el operador va a buscar en una lista',
    )
  }

  /*
   * Un campo con espacios no es un campo: se guarda como `null` para que la
   * invariante de la base lo cuente como ausente. Guardar `'  '` haría que una
   * dirección vacía pasara el CHECK diciendo que tiene municipio.
   */
  const limpios: Record<string, string | null> = {}
  for (const campo of TEXTOS) {
    const valor = datos[campo]?.trim()
    if (!valor || valor.length === 0) {
      limpios[campo] = null
      continue
    }

    /*
     * Municipio y departamento van en MINÚSCULA. Así dos filas que dicen lo
     * mismo son iguales, y buscar «suan» encuentra «Suan». La ortografía buena
     * se recupera del catálogo del DANE al mostrarlas.
     */
    limpios[campo] =
      campo === 'municipio' || campo === 'departamento' ? paraGuardar(valor) : valor
  }

  /*
   * ── Qué cuenta como «ubica» ───────────────────────────────────────────────
   *
   * La MISMA lista que el CHECK `direcciones_ubicable` de la migración 0014.
   * No es «cualquier campo lleno»: un municipio solo no ubica nada — a «Suan»
   * no se le puede entregar agua.
   *
   * Esta lista y la del CHECK tienen que decir lo mismo. Antes no lo decían: el
   * servicio aceptaba una dirección con solo municipio y la base la rechazaba,
   * así que el operador veía un error de constraint sin explicación. Lo
   * encontró un test, no una lectura.
   */
  const UBICAN = ['viaTipo', 'viaNumero', 'placaNumero', 'direccion', 'indicaciones'] as const

  const ubicable =
    UBICAN.some((campo) => limpios[campo] !== null) || typeof datos.latitud === 'number'

  /*
   * ── La invariante, explicada ──────────────────────────────────────────────
   *
   * El CHECK de la base es la garantía; esto es el mensaje. Sin él, una
   * dirección vacía llega como un error de constraint que nadie puede leer, y
   * quien la escribió no sabe qué le falta (ADR-0006).
   */
  if (!ubicable) {
    throw new ErrorDeNegocio(
      'DIRECCION_NO_UBICABLE',
      422,
      'la dirección no dice dónde queda. Alcanza con cualquiera de estas: la nomenclatura, una línea escrita a mano, indicaciones para llegar, o el punto en el mapa',
    )
  }

  return {
    etiqueta,
    limpios,
    /*
     * Las coordenadas van de a dos o no van: media coordenada no ubica nada, y
     * la base lo vuelve a exigir con un CHECK.
     */
    coordenadas:
      typeof datos.latitud === 'number' && typeof datos.longitud === 'number'
        ? { latitud: String(datos.latitud), longitud: String(datos.longitud) }
        : {},
  }
}

/**
 * La dirección, más cómo se escribe.
 *
 * `legible` viaja con el dato porque la función que la arma vive en `api` y
 * `web` no puede importarla. Si cada pantalla la compusiera, en tres meses
 * habría tres formatos — y quien maneja el camión los leería como direcciones
 * distintas.
 */
export type DireccionLegible = Direccion & { legible: string }

/**
 * Una dirección del listado de la ficha, con lo que tiene prestado.
 *
 * ── Por qué es un tipo aparte de `DireccionLegible` ─────────────────────────
 *
 * El conteo pertenece al LISTADO, no a toda dirección. `editarDireccion`
 * devuelve una dirección sola y editarla no mueve ninguna base: darle el campo
 * la obligaría a contar algo que nadie le preguntó, o —peor— a devolver un cero
 * de relleno que la pantalla leería como «no tiene ninguna».
 */
export type DireccionConBases = DireccionLegible & {
  /**
   * Cuántas bases hay prestadas en esta puerta.
   *
   * Viaja con la dirección porque el modal de la baja lo necesita ANTES de
   * confirmar: la operación devuelve esas bases al parque, y preguntar
   * «¿seguro?» sin decir qué se mueve es pedirle a alguien que decida a ciegas.
   *
   * Y viaja en la misma consulta, agrupado: pedirlo por dirección serían N
   * peticiones para pintar una lista de tres.
   */
  basesPrestadas: number
}

export async function direccionesDe(
  clienteId: string,
  soloActivas = true,
): Promise<DireccionConBases[]> {
  const condiciones = [eq(direcciones.clienteId, clienteId)]
  if (soloActivas) condiciones.push(eq(direcciones.activa, true))

  const filas = await db
    .select({
      direccion: direcciones,
      /*
       * `count` sobre la columna de la base y no `count(*)`: con `leftJoin`, una
       * dirección sin bases trae una fila con todo en `null`, y `count(*)` la
       * contaría como una.
       */
      basesPrestadas: sql<number>`count(${bases.id})::int`,
    })
    .from(direcciones)
    .leftJoin(bases, eq(bases.direccionId, direcciones.id))
    .where(and(...condiciones))
    .groupBy(direcciones.id)
    .orderBy(direcciones.createdAt)

  return filas.map(({ direccion, basesPrestadas }) => ({
    ...direccion,
    legible: direccionLegible(direccion),
    basesPrestadas,
  }))
}

/**
 * Editar una dirección — M14.
 *
 * ── Se reemplaza entera, no campo por campo ─────────────────────────────────
 *
 * El formulario manda todo lo que tiene, y lo que el operador borró llega
 * ausente. Con un merge parcial, vaciar un campo sería imposible: mandar
 * «municipio: nada» se interpretaría como «no lo toques», y el dato viejo
 * quedaría para siempre.
 *
 * La invariante se revalida: una edición puede dejar la dirección sin nada que
 * la ubique, igual que un alta.
 */
export async function editarDireccion(
  id: string,
  datos: DatosDeDireccion,
): Promise<DireccionLegible> {
  const [existe] = await db.select().from(direcciones).where(eq(direcciones.id, id))

  if (!existe) {
    throw new ErrorDeNegocio('DIRECCION_NO_ENCONTRADA', 404, 'esa dirección no existe')
  }

  const { etiqueta, limpios, coordenadas } = normalizar(datos)

  const [actualizada] = await db
    .update(direcciones)
    .set({ etiqueta, ...limpios, ...coordenadas })
    .where(eq(direcciones.id, id))
    .returning()

  return { ...actualizada!, legible: direccionLegible(actualizada!) }
}

/**
 * El resultado de dar de baja una dirección — RN-CLI-07 + RN-BAS-04.
 *
 * `basesDevueltas` es el número que el modal de `web/` muestra antes de
 * confirmar. Sale de la misma consulta que ejecuta la devolución: con dos
 * consultas distintas, la pantalla puede decir «ninguna» mientras la
 * transacción devuelve tres.
 */
export interface ResultadoDeBajaDeDireccion {
  direccion: Direccion
  basesDevueltas: number
}

/**
 * Dar de baja una dirección devolviendo sus bases al parque — RN-CLI-07 +
 * RN-BAS-04.
 *
 * ── Una dirección no se borra: se desactiva ─────────────────────────────────
 *
 * El historial de la base la necesita en pie. Borrarla dejaría los préstamos
 * viejos sin a dónde ir a reclamarlos, y `historialDe` no podría traducir a
 * palabras dónde estuvo la base en marzo.
 *
 * ── Pero desactivarla NO alcanzaba ──────────────────────────────────────────
 *
 * Esto era un `UPDATE direcciones SET activa = false` y nada más. La base se
 * quedaba con el `direccion_id` de una puerta que ya no existe: no volvía al
 * parque, no la contaba `disponibilidadDeBases` —que cuenta `direccion_id IS
 * NULL`—, y no dejaba movimiento de retorno.
 *
 * O sea: el sistema avisaba que no alcanzaban las bases teniéndolas en la
 * bodega, y había que retornarlas a mano después. Ese retorno manual llegaba
 * con la fecha del arreglo y sin el motivo real, así que el historial de la
 * base tenía un hueco justo donde cambió de manos.
 *
 * ── Siempre vuelve al parque ────────────────────────────────────────────────
 *
 * Reubicar la base en otra dirección del mismo cliente es un préstamo nuevo y
 * se hace apretando «prestar». Si la baja intentara adivinar el destino,
 * resolvería con una suposición el único momento en que el operador tiene la
 * base en la mano.
 *
 * ── El motivo es obligatorio, como en todo lo que mueve un activo ───────────
 *
 * Mismo piso que descartar una base o anular una venta: la operación mueve algo
 * del poder del cliente al parque, y eso tiene que quedar explicado.
 */
export async function desactivarDireccionConReversion(
  id: string,
  motivo: string,
  contexto: ContextoDeAuditoria,
): Promise<ResultadoDeBajaDeDireccion> {
  if (!motivoEsSuficiente(motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `dar de baja una dirección necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres de explicación: puede devolver bases al parque, y alguien va a tener que reconstruir por qué`,
    )
  }

  const explicacion = motivo.trim()

  return db.transaction(async (tx) => {
    const [direccion] = await tx.select().from(direcciones).where(eq(direcciones.id, id))

    if (!direccion) {
      throw new ErrorDeNegocio('DIRECCION_NO_ENCONTRADA', 404, 'esa dirección no existe')
    }

    /*
     * Sin este guardia, dar de baja dos veces escribiría una segunda fila en la
     * bitácora por una baja que ya había pasado —y el conteo de bases vendría
     * en cero, que se lee como «no tenía ninguna»—.
     */
    if (!direccion.activa) {
      throw new ErrorDeNegocio(
        'DIRECCION_YA_INACTIVA',
        422,
        'esa dirección ya estaba dada de baja',
      )
    }

    const prestadas = await basesPrestadasEn(id, tx)

    /*
     * El update y la fila del libro van juntos por base: si la mitad escribe y
     * la otra no, el libro dice que volvió y la base sigue prestada.
     *
     * El `direccionId` del movimiento es de dónde VOLVIÓ. Esa es la mitad del
     * historial que el retorno manual perdía — `retornarBase` lo aprendió por
     * el mismo camino.
     */
    for (const base of prestadas) {
      await tx.update(bases).set({ direccionId: null }).where(eq(bases.id, base.id))

      await tx.insert(movimientosBase).values({
        baseId: base.id,
        tipo: 'retorno',
        direccionId: id,
        motivo: explicacion,
        registradoPor: contexto.userId,
      })
    }

    /*
     * La dirección se baja al final, después de los retornos: si la transacción
     * rebota, la dirección sigue activa y el operador puede intentar de nuevo
     * sin tener que reactivarla para darla de baja.
     */
    const [actualizada] = await tx
      .update(direcciones)
      .set({ activa: false })
      .where(eq(direcciones.id, id))
      .returning()

    /*
     * `clientes:dar_de_baja_direccion` y no el `clientes:editar` del permiso:
     * editar una ficha corrige un dato, esto devuelve activos al parque. Son
     * hechos distintos y la bitácora tiene que poder separarlos.
     *
     * La `etiqueta` va en el payload porque tres meses después la dirección
     * está inactiva y nadie la va a encontrar en una lista — «se dio de baja el
     * depósito y volvió 1 base» se lee de la fila, sin cruzar nada.
     *
     * Y va DENTRO de la transacción: si la fila falla, los retornos se revierten
     * con ella — ADR-0007.
     */
    await emit(
      {
        ...contexto,
        action: 'clientes:dar_de_baja_direccion',
        resource: 'clientes',
        resourceId: id,
        result: 'ok',
        payload: {
          resourceId: id,
          clienteId: direccion.clienteId,
          etiqueta: direccion.etiqueta,
          motivo: explicacion,
          basesDevueltas: prestadas.length,
        },
      },
      tx,
    )

    return { direccion: actualizada!, basesDevueltas: prestadas.length }
  })
}
