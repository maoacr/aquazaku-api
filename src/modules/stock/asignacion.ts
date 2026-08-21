import { and, asc, eq, gt, gte, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { lotes, movimientosStock } from '@/db/schema'
import type { Ejecutor } from './saldo'

/**
 * FIFO y bloqueo de vencidos — RN-STK-08.
 *
 * Las dos reglas se resuelven en la misma consulta, y eso no es una casualidad
 * feliz: "sacar primero lo que vence antes" y "no sacar lo vencido" son la misma
 * pregunta ordenada por fecha.
 *
 * El bloqueo de vencidos **no es un job nocturno**. Un lote vence solo, y a la
 * mañana siguiente simplemente deja de aparecer en esta consulta. Un job que
 * marca vencidos puede no correr, correr tarde o fallar a la mitad; una
 * condición del WHERE no puede.
 */

export interface Asignacion {
  loteId: string
  codigo: string
  cantidad: number
  fechaVencimiento: string
}

export type ResultadoDeAsignacion =
  | { ok: true; asignaciones: Asignacion[] }
  /** No había suficiente producto vendible. Es una respuesta, no un error. */
  | { ok: false; disponible: number }

/**
 * Reserva `cantidad` del producto, tomando primero los lotes que vencen antes.
 *
 * ── Por qué bloquea las filas ───────────────────────────────────────────────
 *
 * Una salida puede abarcar varios lotes, y entre elegirlos y descontarlos otro
 * proceso podría vaciar uno. `FOR UPDATE` los reserva mientras dura la
 * transacción.
 *
 * El orden del bloqueo es siempre el mismo —por fecha de vencimiento, que es
 * también el índice— así que dos salidas simultáneas del mismo producto piden
 * los lotes en idéntico orden y no pueden quedar trabadas esperándose. Un
 * bloqueo en orden inconsistente es la receta clásica del deadlock.
 *
 * `hoy` se recibe, no se calcula acá: un `new Date()` adentro haría imposible
 * testear el borde del vencimiento sin esperar a mañana.
 */
export async function asignarFifo(
  productoId: string,
  cantidad: number,
  hoy: string,
  ejecutor: Ejecutor = db,
): Promise<ResultadoDeAsignacion> {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error(`la cantidad tiene que ser un entero positivo, llegó ${cantidad}`)
  }

  const disponibles = await ejecutor
    .select({
      id: lotes.id,
      codigo: lotes.codigo,
      saldo: lotes.cantidadDisponible,
      fechaVencimiento: lotes.fechaVencimiento,
    })
    .from(lotes)
    .where(
      and(
        eq(lotes.productoId, productoId),
        gt(lotes.cantidadDisponible, 0),
        // Un lote que vence HOY todavía sirve: vence al terminar el día.
        gte(lotes.fechaVencimiento, hoy),
      ),
    )
    .orderBy(asc(lotes.fechaVencimiento))
    .for('update')

  const total = disponibles.reduce((suma, l) => suma + l.saldo, 0)
  if (total < cantidad) return { ok: false, disponible: total }

  const asignaciones: Asignacion[] = []
  let porCubrir = cantidad

  for (const lote of disponibles) {
    if (porCubrir === 0) break

    const deEsteLote = Math.min(lote.saldo, porCubrir)
    asignaciones.push({
      loteId: lote.id,
      codigo: lote.codigo,
      cantidad: deEsteLote,
      fechaVencimiento: lote.fechaVencimiento,
    })
    porCubrir -= deEsteLote
  }

  return { ok: true, asignaciones }
}

/**
 * Descuenta una salida repartida en varios lotes, dentro de una transacción.
 *
 * Cada lote genera **su propio movimiento** con su `lote_id`. Es lo que hace
 * posible responder a un recall: "esta venta salió del lote X, esos clientes
 * son los afectados". Un movimiento único por el total perdería esa traza.
 */
export async function sacarConFifo(
  entrada: {
    productoId: string
    cantidad: number
    hoy: string
    tipo: 'venta' | 'descarte'
    causa?: (typeof movimientosStock.$inferInsert)['causa']
    documentoId?: string | undefined
    registradoPor: string | null
  },
  ejecutor: Ejecutor = db,
): Promise<ResultadoDeAsignacion> {
  const correr = async (tx: Ejecutor): Promise<ResultadoDeAsignacion> => {
    const plan = await asignarFifo(entrada.productoId, entrada.cantidad, entrada.hoy, tx)
    if (!plan.ok) return plan

    for (const asignacion of plan.asignaciones) {
      await tx
        .update(lotes)
        .set({ cantidadDisponible: sql`${lotes.cantidadDisponible} - ${asignacion.cantidad}` })
        .where(eq(lotes.id, asignacion.loteId))

      await tx.insert(movimientosStock).values({
        loteId: asignacion.loteId,
        cantidad: -asignacion.cantidad,
        tipo: entrada.tipo,
        causa: entrada.causa ?? null,
        documentoId: entrada.documentoId ?? null,
        registradoPor: entrada.registradoPor,
      })
    }

    return plan
  }

  return 'transaction' in ejecutor ? ejecutor.transaction((tx) => correr(tx)) : correr(ejecutor)
}

/**
 * Lotes vencidos que **todavía tienen producto**.
 *
 * Vencido NO es descartado: el producto sigue físicamente en la bodega
 * ocupando lugar. Restarlo solo porque venció sería perder la cuenta de algo
 * que existe. Descartarlo es un acto de alguien, no una consecuencia del
 * calendario (RN-STK-05).
 *
 * Esta consulta es la que alimenta el aviso de "hay producto para descartar".
 */
export async function lotesVencidosConSaldo(hoy: string, ejecutor: Ejecutor = db) {
  return ejecutor
    .select({
      id: lotes.id,
      productoId: lotes.productoId,
      codigo: lotes.codigo,
      saldo: lotes.cantidadDisponible,
      fechaVencimiento: lotes.fechaVencimiento,
    })
    .from(lotes)
    .where(and(gt(lotes.cantidadDisponible, 0), sql`${lotes.fechaVencimiento} < ${hoy}`))
    .orderBy(asc(lotes.fechaVencimiento))
}
