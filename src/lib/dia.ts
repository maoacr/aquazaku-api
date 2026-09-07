import { type SQL, sql } from 'drizzle-orm'

/**
 * El día de Aquazaku es un día de Campo de la Cruz.
 *
 * ── El bug que esto evita ───────────────────────────────────────────────────
 *
 * `columna::date` sobre un `timestamptz` usa la zona horaria de la SESIÓN de
 * Postgres. Y esa zona depende de dónde corra la base, no de dónde esté la
 * planta:
 *
 * | Venta del 31-ago a las 19:30 en la planta | Se cuenta el |
 * | --- | --- |
 * | Base en `America/Bogota` (la de desarrollo) | 31 de agosto ✓ |
 * | Base en UTC (Supabase, y el CI) | **1 de septiembre** ✗ |
 *
 * Colombia es UTC−5, así que **todo lo que pasa después de las 19:00 cae en el
 * día siguiente**. A fin de mes, en el mes siguiente: la venta del último día de
 * agosto aparece en el reporte de septiembre.
 *
 * Y no falla ruidosamente. Los totales cierran, cada venta está en algún lado, y
 * el descuadre solo se ve conciliando contra el banco — que es exactamente el
 * trabajo que el módulo del contador vino a evitar.
 *
 * Lo encontró el CI, no una lectura: en desarrollo la base está en
 * `America/Bogota` y el bug es invisible.
 *
 * ── Por qué la zona va fija y no configurable ───────────────────────────────
 *
 * Aquazaku es una planta, en un pueblo, con un horario. Una zona configurable
 * sería una perilla que nadie va a mover y que puede quedar mal puesta.
 */

/**
 * La zona de la planta. Se escribe una vez para que no haya dos lugares del
 * sistema que discrepen sobre qué día es hoy.
 */
export const ZONA_DE_LA_PLANTA = 'America/Bogota'

/**
 * El día calendario de un instante, visto desde la planta.
 *
 * Da lo mismo en qué zona corra el servidor: por eso es determinista y por eso
 * el reporte de agosto dice lo mismo hoy que en diciembre — que es
 * [RN-CON-02](/dominio/contador/).
 */
export function diaEnLaPlanta(columna: unknown): SQL {
  return sql`((${columna}) AT TIME ZONE 'America/Bogota')::date`
}
