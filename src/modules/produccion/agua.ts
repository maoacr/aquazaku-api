import { eq, sql } from 'drizzle-orm'
import { type DB, db } from '@/db/client'
import { type MovimientoAgua, movimientosAgua } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'

/**
 * El balance del agua — RN-PRD-06, y la reconciliación de RN-PRD-14.
 *
 * ═══ De los cuatro términos, tres son exactos ═══════════════════════════════
 *
 * ```
 * AGUA PROCESADA (4.000 L)          ← balance CERRADO
 *   + procesamiento del día           caudal × tiempo   ✅ medido
 *   − consumo de envasado             pacas y botellones ✅ calculado
 *
 * AGUA CRUDA (13.000 L)             ← un término SIN medir
 *   + ingreso de la red municipal     ❌ NO HAY MEDIDOR
 *   − crudo consumido                 procesamiento ÷ 0,70 ✅ derivado
 * ```
 *
 * El único que no se puede medir es el ingreso de la red: no hay medidor ni
 * regleta. Y eso **no se disimula con una estimación** — se registra el hecho,
 * y el saldo se recalibra después contra la banda observada, con motivo.
 */

/** Capacidad de cada saldo, en litros — RN-PRD-02. */
export const CAPACIDAD = {
  /** El almacenamiento de agua cruda. */
  crudo: 13_000,
  /** Los dos tanques de 2.000 L, que se operan en paralelo — RN-PRD-21. */
  procesado: 4_000,
} as const

export type Tanque = keyof typeof CAPACIDAD

/** Los cinco niveles que el ojo distingue — RN-PRD-11. */
export const NIVELES = ['vacio', 'un_cuarto', 'medio', 'tres_cuartos', 'lleno'] as const
export type Nivel = (typeof NIVELES)[number]

/**
 * La fracción nominal de cada nivel.
 *
 * Las BANDAS salen de partir al medio la distancia entre niveles vecinos: cada
 * una es su valor nominal ± 1/8 de la capacidad. Para el tanque de 13.000 L eso
 * da `MEDIO → 4.875 – 8.125 L`, que es exactamente el ejemplo de RN-PRD-15.
 *
 * No es una elección estética: si las bandas no se tocaran, habría saldos que no
 * caen en ninguna y el sistema no sabría qué decir de ellos.
 */
const FRACCION: Record<Nivel, number> = {
  vacio: 0,
  un_cuarto: 0.25,
  medio: 0.5,
  tres_cuartos: 0.75,
  lleno: 1,
}

/** Media banda: la mitad de la distancia entre dos niveles vecinos. */
const MEDIA_BANDA = 0.125

export interface Banda {
  nivel: Nivel
  /** Litros. Los extremos se recortan a la capacidad real del tanque. */
  desde: number
  hasta: number
}

/**
 * El rango de litros que representa un nivel observado.
 *
 * «Medio tanque» de 13.000 L es un rango de 3.250 litros. Ese ancho ES el dato:
 * decir «6.500 L» sería inventar una precisión que el ojo no tiene.
 */
export function bandaDe(tanque: Tanque, nivel: Nivel): Banda {
  const capacidad = CAPACIDAD[tanque]
  const centro = FRACCION[nivel] * capacidad
  const media = MEDIA_BANDA * capacidad

  return {
    nivel,
    desde: Math.max(0, Math.round(centro - media)),
    hasta: Math.min(capacidad, Math.round(centro + media)),
  }
}

export interface SaldoDeAgua {
  tanque: Tanque
  /** Lo que dice el libro. **Este manda** — RN-PRD-14. */
  litros: number
  capacidad: number
  /** El nivel al que corresponde ese saldo, para poder compararlo con el ojo. */
  nivelCalculado: Nivel
}

/**
 * El saldo de un tanque, derivado del libro.
 *
 * Se deriva y no se materializa —a diferencia del stock y los insumos— por una
 * razón: acá NO hay concurrencia. El agua la mueve el cierre de producción, que
 * es uno por día, y los ingresos y ajustes son manuales y esporádicos. La
 * columna de saldo existe donde hace falta descontar atómicamente, y acá no.
 */
export async function saldoDe(tanque: Tanque, ejecutor: DB = db): Promise<SaldoDeAgua> {
  const [fila] = await ejecutor
    .select({ total: sql<string>`coalesce(sum(${movimientosAgua.litros}), 0)` })
    .from(movimientosAgua)
    .where(eq(movimientosAgua.tanque, tanque))

  const litros = Number(fila?.total ?? 0)

  return {
    tanque,
    litros,
    capacidad: CAPACIDAD[tanque],
    nivelCalculado: nivelDe(tanque, litros),
  }
}

export async function saldosDeAgua(): Promise<SaldoDeAgua[]> {
  return Promise.all([saldoDe('crudo'), saldoDe('procesado')])
}

/** A qué nivel corresponde un saldo. El inverso de `bandaDe`. */
export function nivelDe(tanque: Tanque, litros: number): Nivel {
  const fraccion = litros / CAPACIDAD[tanque]

  // Se recorre de mayor a menor y se corta en la primera banda que lo contiene.
  for (const nivel of [...NIVELES].reverse()) {
    if (fraccion >= FRACCION[nivel] - MEDIA_BANDA) return nivel
  }
  return 'vacio'
}

export interface Reconciliacion {
  tanque: Tanque
  /** Lo que dice el libro. */
  litrosCalculados: number
  nivelCalculado: Nivel
  /** Lo que vio el operario. */
  nivelObservado: Nivel
  banda: Banda
  /** `true` cuando el saldo cae dentro de la banda observada. */
  cuadra: boolean
  /**
   * Cuántos litros habría que ajustar para caer en el CENTRO de la banda.
   *
   * Es una sugerencia, no una corrección automática: quien ajusta tiene que
   * poder cambiarla y siempre tiene que dar un motivo.
   */
  ajusteSugerido: number
}

/**
 * Compara el saldo calculado contra lo que se vio — RN-PRD-14.
 *
 * ── El saldo calculado MANDA; la lectura reconcilia ─────────────────────────
 *
 * Esta función **nunca escribe**. Devuelve si cuadra y cuánto se separa, y nada
 * más. Si el saldo cae dentro de la banda observada, no hay nada que hacer: el
 * libro y el ojo dicen lo mismo dentro de lo que el ojo puede afirmar.
 *
 * Si cae afuera, se marca la discrepancia y se ofrece un ajuste **con motivo**.
 *
 * :::caution
 * Sobrescribir el saldo con la lectura sería el error obvio y es el peor: «medio
 * tanque» de 13.000 L es un rango de 3.250 litros. Reemplazar un número
 * calculado por el centro de ese rango PIERDE información y encima parece más
 * preciso — exactamente lo que RN-PRD-15 prohíbe.
 * :::
 */
export async function reconciliar(
  tanque: Tanque,
  nivelObservado: Nivel,
): Promise<Reconciliacion> {
  const saldo = await saldoDe(tanque)
  const banda = bandaDe(tanque, nivelObservado)
  const cuadra = saldo.litros >= banda.desde && saldo.litros <= banda.hasta

  return {
    tanque,
    litrosCalculados: saldo.litros,
    nivelCalculado: saldo.nivelCalculado,
    nivelObservado,
    banda,
    cuadra,
    ajusteSugerido: cuadra ? 0 : Math.round((banda.desde + banda.hasta) / 2 - saldo.litros),
  }
}

/**
 * Registra que llegó agua de la red — **sin cantidad**.
 *
 * ── El hueco se declara como hueco ──────────────────────────────────────────
 *
 * No hay medidor ni regleta (RN-PRD-11), así que este movimiento va en CERO
 * litros y lo único que afirma es el HECHO: llegó agua y se llenó el tanque.
 *
 * La tentación es pedir «cuántos litros entraron» y dejar que alguien lo
 * complete a ojo. Eso convierte un hueco CONOCIDO en un número que parece
 * medido: el día que el saldo no cuadre, nadie va a saber si el problema fue el
 * consumo, la merma o esa estimación.
 *
 * El saldo sube después, con un ajuste explícito y con motivo, hasta la banda
 * observada. Así queda claro cuál número es medido y cuál es estimado.
 */
export async function registrarIngreso(
  tanque: Tanque,
  registradoPor: string | null,
): Promise<MovimientoAgua> {
  const [movimiento] = await db
    .insert(movimientosAgua)
    .values({ tanque, litros: 0, tipo: 'ingreso_red', registradoPor })
    .returning()

  return movimiento!
}

/**
 * Ajusta el saldo de un tanque. Con motivo, siempre.
 *
 * Es el único camino por el que el saldo del agua se mueve fuera de un cierre —
 * y por eso exige explicación: un ajuste que nadie pueda entender dentro de tres
 * meses no sirve como registro.
 */
export async function ajustarAgua(
  tanque: Tanque,
  litros: number,
  motivo: string,
  registradoPor: string | null,
): Promise<SaldoDeAgua> {
  if (!Number.isInteger(litros) || litros === 0) {
    throw new ErrorDeNegocio(
      'AJUSTE_INVALIDO',
      422,
      'un ajuste de cero no ajusta nada: la diferencia va con signo, positivo si sobra y negativo si falta',
    )
  }

  if (!motivoEsSuficiente(motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `el motivo necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: un ajuste que nadie pueda explicar dentro de tres meses no sirve como registro`,
    )
  }

  const saldoPrevio = await saldoDe(tanque)
  if (saldoPrevio.litros + litros < 0) {
    throw new ErrorDeNegocio(
      'SALDO_NEGATIVO',
      422,
      `el ajuste dejaría el tanque en ${saldoPrevio.litros + litros} litros, y un tanque no puede tener menos que nada`,
    )
  }

  if (saldoPrevio.litros + litros > CAPACIDAD[tanque]) {
    // No es un capricho: un saldo por encima de la capacidad significa que el
    // libro perdió el rastro de una salida, y taparlo con un ajuste al alza
    // esconde el problema en vez de resolverlo.
    throw new ErrorDeNegocio(
      'SOBRE_CAPACIDAD',
      422,
      `el ajuste dejaría ${saldoPrevio.litros + litros} litros en un tanque de ${CAPACIDAD[tanque]}. Si de verdad hay esa cantidad, falta registrar una salida antes`,
    )
  }

  await db
    .insert(movimientosAgua)
    .values({ tanque, litros, tipo: 'ajuste', motivo, registradoPor })

  return saldoDe(tanque)
}

/** El libro de un tanque, del más nuevo al más viejo. */
export async function movimientosDe(tanque: Tanque): Promise<MovimientoAgua[]> {
  return db
    .select()
    .from(movimientosAgua)
    .where(eq(movimientosAgua.tanque, tanque))
    .orderBy(movimientosAgua.id)
}
