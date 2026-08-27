import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { cobros, ventas } from '@/db/schema'
// `Ejecutor` es `db` o una transacción abierta. M2 lo dejó exportado con un
// comentario que decía «M6 va a necesitar descontar dentro de la suya» — y acá
// está el caso: el chequeo de crédito lee la deuda DENTRO de la transacción de
// la venta, o leería un estado viejo.
import type { Ejecutor } from '@/modules/stock/saldo'

/**
 * La deuda de un cliente — RN-CLI-03 y RN-VEN-07.
 *
 * ```
 * deuda = ventas a crédito CONFIRMADAS − cobros
 * ```
 *
 * ── Por qué se deriva y no se materializa ───────────────────────────────────
 *
 * El stock y los insumos SÍ tienen columna de saldo, y por una razón concreta:
 * hay que descontarlos atómicamente, y un saldo derivado no se puede decrementar
 * con un `UPDATE … WHERE saldo >= n`.
 *
 * Acá no hay nada que descontar. Dos cobros simultáneos **suman**, no compiten
 * por la última unidad. Materializarlo agregaría una columna que puede quedar
 * desincronizada del libro sin ganar nada.
 *
 * ── Las ventas anuladas no cuentan ──────────────────────────────────────────
 *
 * Anular revierte todos los efectos (RN-VEN-03), y la deuda es uno de ellos. La
 * venta no desaparece —cambia de estado— así que el filtro por estado es lo que
 * hace que la reversión ocurra sin tocar ninguna otra tabla.
 */
export async function deudaDe(clienteId: string, ejecutor: Ejecutor = db): Promise<string> {
  const [fila] = await ejecutor
    .select({
      vendido: sql<string>`coalesce(sum(${ventas.total}) filter (
        where ${ventas.medioDePago} = 'credito' and ${ventas.estado} = 'confirmada'
      ), 0)`,
    })
    .from(ventas)
    .where(eq(ventas.clienteId, clienteId))

  const [pagado] = await ejecutor
    .select({ total: sql<string>`coalesce(sum(${cobros.monto}), 0)` })
    .from(cobros)
    .where(eq(cobros.clienteId, clienteId))

  /*
   * La resta se hace en centavos enteros. Sumar `numeric` en Postgres es exacto,
   * pero al pasar por JavaScript los dos números se vuelven `string` y restarlos
   * como floats reintroduce el problema que M6 evita en todo el módulo.
   */
  const centavos = Math.round(Number(fila?.vendido ?? 0) * 100) -
    Math.round(Number(pagado?.total ?? 0) * 100)

  return (centavos / 100).toFixed(2)
}

/** Cuántas ventas a crédito sin anular tiene un cliente. Para la ficha. */
export async function ventasACreditoDe(clienteId: string, ejecutor: Ejecutor = db) {
  return ejecutor
    .select()
    .from(ventas)
    .where(
      and(
        eq(ventas.clienteId, clienteId),
        eq(ventas.medioDePago, 'credito'),
        eq(ventas.estado, 'confirmada'),
      ),
    )
    .orderBy(ventas.createdAt)
}
