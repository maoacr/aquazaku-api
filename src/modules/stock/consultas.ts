import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { lotes } from '@/db/schema'
import type { Ejecutor } from './saldo'

/**
 * Consultas de solo lectura sobre el stock.
 *
 * Viven aparte del servicio a propósito: son lo que otros módulos necesitan
 * saber del stock sin poder moverlo. `productos` importa `saldoTotalDe` para
 * cumplir RN-CAT-02, y no debería poder descontar nada al hacerlo.
 */

/**
 * Cuántas unidades de un producto hay en total, sumando todos sus lotes.
 *
 * Cuenta también las de lotes **vencidos**: están físicamente en la bodega y
 * hay que descartarlas antes de dar el producto por terminado. Para vender, la
 * pregunta es otra y la contesta `asignarFifo`.
 */
export async function saldoTotalDe(productoId: string, ejecutor: Ejecutor = db): Promise<number> {
  const [fila] = await ejecutor
    .select({ total: sql<number>`coalesce(sum(${lotes.cantidadDisponible}), 0)::int` })
    .from(lotes)
    .where(eq(lotes.productoId, productoId))

  return fila?.total ?? 0
}

/** Lotes de un producto que todavía tienen unidades, del más próximo a vencer. */
export async function lotesConSaldoDe(productoId: string, ejecutor: Ejecutor = db) {
  return ejecutor
    .select({
      id: lotes.id,
      codigo: lotes.codigo,
      saldo: lotes.cantidadDisponible,
      fechaEmpaque: lotes.fechaEmpaque,
      fechaVencimiento: lotes.fechaVencimiento,
    })
    .from(lotes)
    .where(and(eq(lotes.productoId, productoId), gt(lotes.cantidadDisponible, 0)))
    .orderBy(lotes.fechaVencimiento)
}
