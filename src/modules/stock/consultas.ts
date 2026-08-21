import { and, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { lotes, movimientosStock, productos, users } from '@/db/schema'
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

/**
 * Cuánto hay de cada producto, y cuánto de eso no se puede vender.
 *
 * Las tres cifras se calculan en la misma consulta a propósito: pedir el total
 * por un lado y lo vencido por otro deja una ventana en la que un descarte
 * puede colarse entre las dos, y la pantalla mostraría números que no suman.
 */
export async function resumenDeStock(hoy: string, ejecutor: Ejecutor = db) {
  return ejecutor
    .select({
      productoId: productos.id,
      codigo: productos.codigo,
      nombre: productos.nombre,
      activo: productos.activo,
      total: sql<number>`coalesce(sum(${lotes.cantidadDisponible}), 0)::int`,
      vendible: sql<number>`coalesce(sum(${lotes.cantidadDisponible}) filter (
        where ${lotes.fechaVencimiento} >= ${hoy}
      ), 0)::int`,
      vencido: sql<number>`coalesce(sum(${lotes.cantidadDisponible}) filter (
        where ${lotes.fechaVencimiento} < ${hoy}
      ), 0)::int`,
    })
    .from(productos)
    // LEFT JOIN: un producto sin lotes tiene que aparecer en cero, no
    // desaparecer del listado. Un producto que no figura se lee como "no
    // existe", no como "no hay".
    .leftJoin(lotes, eq(lotes.productoId, productos.id))
    .groupBy(productos.id, productos.codigo, productos.nombre, productos.activo)
    .orderBy(productos.codigo)
}

export interface FiltrosDeMovimientos {
  loteId?: string | undefined
  tipo?: (typeof movimientosStock.$inferSelect)['tipo'] | undefined
  cursor?: number | undefined
  limite: number
}

/**
 * El libro, paginado por cursor.
 *
 * Por cursor y no por offset, igual que la auditoría: con offset, un movimiento
 * nuevo entre dos páginas corre todo el resto un lugar y hace que una fila
 * aparezca dos veces o ninguna.
 */
export async function listarMovimientos(filtros: FiltrosDeMovimientos, ejecutor: Ejecutor = db) {
  const condiciones = [
    filtros.loteId ? eq(movimientosStock.loteId, filtros.loteId) : undefined,
    filtros.tipo ? eq(movimientosStock.tipo, filtros.tipo) : undefined,
    filtros.cursor !== undefined ? lt(movimientosStock.id, filtros.cursor) : undefined,
  ].filter((c) => c !== undefined)

  const filas = await ejecutor
    .select({
      id: movimientosStock.id,
      loteId: movimientosStock.loteId,
      loteCodigo: lotes.codigo,
      productoCodigo: productos.codigo,
      cantidad: movimientosStock.cantidad,
      tipo: movimientosStock.tipo,
      motivo: movimientosStock.motivo,
      causa: movimientosStock.causa,
      documentoId: movimientosStock.documentoId,
      registradoPor: movimientosStock.registradoPor,
      // `null` significa que la cuenta se borró y el movimiento sobrevivió.
      registradoPorNombre: users.name,
      createdAt: movimientosStock.createdAt,
    })
    .from(movimientosStock)
    .innerJoin(lotes, eq(lotes.id, movimientosStock.loteId))
    .innerJoin(productos, eq(productos.id, lotes.productoId))
    .leftJoin(users, eq(users.id, movimientosStock.registradoPor))
    .where(condiciones.length > 0 ? and(...condiciones) : undefined)
    .orderBy(desc(movimientosStock.id))
    // Una de más para saber si hay página siguiente sin contar la tabla entera.
    .limit(filtros.limite + 1)

  const hayMas = filas.length > filtros.limite
  const pagina = hayMas ? filas.slice(0, filtros.limite) : filas

  return {
    filas: pagina,
    siguienteCursor: hayMas ? (pagina.at(-1)?.id ?? null) : null,
  }
}
