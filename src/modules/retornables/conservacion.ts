import { eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { movimientosBotellon } from '@/db/schema'
import type { Ejecutor } from '@/modules/stock/saldo'

/**
 * La ley de conservación del parque de botellones — RN-ENV-02.
 *
 * ```
 * Σ(saldos de todos los tenedores)  =  Σ compras + Σ ajustes − Σ descartes
 * ```
 *
 * ── Por qué el ajuste está del lado derecho ────────────────────────────────
 *
 * La primera versión de esta función no lo contaba, y era un error: un ajuste
 * escribe UNA sola fila —es la operación que reconoce que el parque tenía otra
 * cantidad de la que el libro decía— así que dejarlo afuera habría roto la
 * igualdad **para siempre** después del primer ajuste.
 *
 * Una alarma que suena siempre deja de ser una alarma. Y peor: la próxima
 * transferencia a medias se escondería detrás del ruido.
 *
 * Contándolo, la igualdad detecta **exactamente una cosa**: transferencias
 * desbalanceadas. Que es lo único que no debería poder pasar.
 *
 * ── Por qué esta igualdad es el invariante del módulo ───────────────────────
 *
 * El botellón **no tiene identificador individual** (`RN-ENV-01`). Eso significa
 * que un botellón que se pierde no deja hueco en ninguna tabla: no hay una fila
 * que quede huérfana, ni un ID que no aparezca en ningún lado.
 *
 * Lo único que cambia es que la suma deja de cerrar. **Esta igualdad es la única
 * alarma que existe.**
 *
 * El dominio no lo deja a criterio de quien implemente:
 *
 * > «Este invariante es un test. Escribilo temprano, corrélo seguido, y hacelo
 * > fallar ruidosamente.»
 *
 * ── No es una validación previa ─────────────────────────────────────────────
 *
 * Esto NO se llama antes de escribir para decidir si se permite algo. Se corre
 * **después**, y lo que verifica es que el código de arriba no haya escrito una
 * transferencia a medias.
 *
 * Un `UPDATE … WHERE saldo >= n` protege contra vender lo que no hay; esto
 * protege contra otra cosa: contra que una entrega escriba la fila del cliente y
 * no la de la bodega. Son dos problemas distintos y hacen falta las dos
 * defensas.
 */

export interface Conservacion {
  /** Lo que suman todos los tenedores: la bodega más cada cliente. */
  enPoderDeAlguien: number
  /** Compras más ajustes, menos descartes: el total que el parque declara tener. */
  registrados: number
  cuadra: boolean
  /** Cuántos faltan (negativo) o sobran (positivo). Cero cuando cuadra. */
  diferencia: number
}

export async function verificarConservacion(ejecutor: Ejecutor = db): Promise<Conservacion> {
  /*
   * Los saldos y el total salen de la MISMA tabla, y eso es a propósito: si
   * salieran de dos lugares, un desajuste podría ser una diferencia entre las
   * dos fuentes en vez de un botellón perdido.
   *
   * Acá la única forma de que no cierre es que falte —o sobre— una fila.
   */
  const [fila] = await ejecutor
    .select({
      total: sql<string>`coalesce(sum(${movimientosBotellon.cantidad}), 0)`,
      entradas: sql<string>`coalesce(sum(${movimientosBotellon.cantidad}) filter (
        where ${movimientosBotellon.tipo} in ('compra', 'descarte', 'ajuste')
      ), 0)`,
    })
    .from(movimientosBotellon)

  const enPoderDeAlguien = Number(fila?.total ?? 0)
  const registrados = Number(fila?.entradas ?? 0)

  return {
    enPoderDeAlguien,
    registrados,
    cuadra: enPoderDeAlguien === registrados,
    diferencia: enPoderDeAlguien - registrados,
  }
}

/** Cuántos botellones tiene un cliente en su poder — RN-ENV-04. Derivado. */
export async function botellonesDe(clienteId: string, ejecutor: Ejecutor = db): Promise<number> {
  const [fila] = await ejecutor
    .select({ saldo: sql<string>`coalesce(sum(${movimientosBotellon.cantidad}), 0)` })
    .from(movimientosBotellon)
    .where(eq(movimientosBotellon.clienteId, clienteId))

  return Number(fila?.saldo ?? 0)
}

/** Cuántos hay en la bodega de la empresa. `cliente_id` en `NULL`. */
export async function botellonesEnBodega(ejecutor: Ejecutor = db): Promise<number> {
  const [fila] = await ejecutor
    .select({ saldo: sql<string>`coalesce(sum(${movimientosBotellon.cantidad}), 0)` })
    .from(movimientosBotellon)
    .where(isNull(movimientosBotellon.clienteId))

  return Number(fila?.saldo ?? 0)
}
