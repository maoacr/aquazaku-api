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

/**
 * Qué día es HOY, visto desde la planta — el gemelo en JS de `diaEnLaPlanta`.
 *
 * ── El bug que esto evita ───────────────────────────────────────────────────
 *
 * Cinco rutas leían el reloj con `new Date().toISOString().slice(0, 10)`.
 * `toISOString()` es UTC **siempre**, sin importar en qué zona corra el proceso:
 *
 * | A las 19:30 del 31-ago en la planta | Devolvía |
 * | --- | --- |
 * | `new Date().toISOString().slice(0, 10)` | **2026-09-01** ✗ |
 * | El día que es en Campo de la Cruz       | 2026-08-31 ✓ |
 *
 * Y ese string no se muestra: se COMPARA. Decide si un código de descuento
 * sigue vigente, si un lote ya venció, y cuántos días lleva un cliente sin
 * comprar. Un código que vencía el 31 se rechazaba desde las 19:00 del 31, con
 * el cliente en el mostrador y el cupón en la mano.
 *
 * Es el mismo error que `diaEnLaPlanta` corrigió del lado de SQL, en el lado
 * que faltaba: el reloj.
 *
 * ── Por qué `en-CA` ─────────────────────────────────────────────────────────
 *
 * Es el locale que formatea en `AAAA-MM-DD`, que es como se compara contra un
 * `date` de Postgres. Armarlo a mano con `getFullYear` y amigos daría la fecha
 * del PROCESO, que es justo lo que este helper existe para no usar.
 */
export function hoyEnLaPlanta(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_DE_LA_PLANTA }).format(new Date())
}
