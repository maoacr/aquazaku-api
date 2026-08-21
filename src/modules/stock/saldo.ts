import { and, eq, gte, sql } from 'drizzle-orm'
import { type DB, db } from '@/db/client'
import { type MovimientoStock, lotes, movimientosStock } from '@/db/schema'

/**
 * El saldo de stock — RN-STK-02 y RN-STK-03.
 *
 * ── Por qué esto no es un SELECT seguido de un UPDATE ───────────────────────
 *
 * El mostrador vende y la preparación de pedidos descuenta, las dos contra el
 * mismo saldo y al mismo tiempo (RN-STK-01). Que haya una sola bodega no
 * elimina la concurrencia: la concentra.
 *
 * El camino ingenuo tiene una carrera de manual:
 *
 *     1. SELECT cantidad_disponible  → 10
 *     2. ¿alcanza para 8? → sí
 *     3. UPDATE cantidad = 10 - 8    → 2
 *
 * Dos procesos que leen 10 a la vez venden 16 de 10.
 *
 * Y el CHECK NO los frena. Es lo que más engaña de este bug: el paso 3 escribe
 * un valor ABSOLUTO calculado sobre una lectura vieja (`10 - 8 = 2`), no un
 * delta. Nunca intenta escribir un número negativo, así que
 * `cantidad_disponible >= 0` se cumple perfectamente y el saldo queda mal sin
 * que nada proteste.
 *
 * Verificado: implementando esta versión a propósito, 20 descuentos de 10 sobre
 * un lote de 100 dieron 20 éxitos —vendió 200 de 100— con el saldo en 90 y el
 * libro sumando -150. Cero errores. Un inventario que miente en silencio.
 *
 * El CHECK protege contra un valor negativo, no contra una actualización
 * perdida. Son dos problemas distintos y hacen falta las dos defensas.
 *
 * Acá la decisión y el efecto son la misma operación. Postgres serializa los
 * UPDATE sobre la misma fila, así que entre "alcanza" y "descontado" no hay
 * ventana.
 */

/** `db` o una transacción abierta. M6 va a necesitar descontar dentro de la suya. */
type Transaccion = Parameters<Parameters<DB['transaction']>[0]>[0]
export type Ejecutor = DB | Transaccion

export interface Salida {
  loteId: string
  /** Positiva: cuánto sacar. */
  cantidad: number
  tipo: 'venta' | 'descarte'
  motivo?: string | undefined
  causa?: MovimientoStock['causa']
  documentoId?: string | undefined
  registradoPor: string | null
}

export interface Entrada {
  loteId: string
  /** Positiva: cuánto entra. */
  cantidad: number
  tipo: 'ajuste' | 'devolucion' | 'produccion'
  motivo?: string | undefined
  documentoId?: string | undefined
  registradoPor: string | null
}

export type Resultado =
  | { ok: true; saldo: number; movimientoId: number }
  /** No alcanzaba. Es una respuesta, no un error. */
  | { ok: false; disponible: number }

/**
 * Saca producto de un lote.
 *
 * Devuelve `{ ok: false }` cuando no había suficiente — **no lanza**. Que el
 * stock no alcance es un estado normal del negocio, no una excepción: la ruta
 * lo traduce a `STOCK_INSUFICIENTE` con el saldo real, para que quien esté del
 * otro lado sepa cuánto hay.
 */
export async function descontar(salida: Salida, ejecutor: Ejecutor = db): Promise<Resultado> {
  exigirCantidadPositiva(salida.cantidad)

  return enTransaccion(ejecutor, async (tx) => {
    // El WHERE es la validación. Si no se cumple, no se actualiza nada y no hay
    // ninguna ventana entre comprobar y descontar.
    const actualizados = await tx
      .update(lotes)
      .set({ cantidadDisponible: sql`${lotes.cantidadDisponible} - ${salida.cantidad}` })
      .where(and(eq(lotes.id, salida.loteId), gte(lotes.cantidadDisponible, salida.cantidad)))
      .returning({ saldo: lotes.cantidadDisponible })

    const actualizado = actualizados[0]
    if (!actualizado) {
      return { ok: false as const, disponible: await saldoDe(salida.loteId, tx) }
    }

    // El movimiento va en la MISMA transacción que el saldo. Si el saldo baja y
    // el movimiento no queda, el libro deja de explicar el saldo — la primera
    // forma de descuadre, y la más difícil de rastrear meses después.
    const [movimiento] = await tx
      .insert(movimientosStock)
      .values({
        loteId: salida.loteId,
        cantidad: -salida.cantidad,
        tipo: salida.tipo,
        motivo: salida.motivo ?? null,
        causa: salida.causa ?? null,
        documentoId: salida.documentoId ?? null,
        registradoPor: salida.registradoPor,
      })
      .returning({ id: movimientosStock.id })

    return { ok: true as const, saldo: actualizado.saldo, movimientoId: movimiento!.id }
  })
}

/**
 * Devuelve producto a un lote — RN-STK-05: una devolución sana vuelve al MISMO
 * lote, para no perder su vencimiento ni su trazabilidad.
 *
 * No lleva `WHERE` de saldo: sumar siempre se puede. Pero sí va en la misma
 * transacción que su movimiento, por la misma razón que la salida.
 */
export async function ingresar(entrada: Entrada, ejecutor: Ejecutor = db): Promise<Resultado> {
  exigirCantidadPositiva(entrada.cantidad)

  return enTransaccion(ejecutor, async (tx) => {
    const [actualizado] = await tx
      .update(lotes)
      .set({ cantidadDisponible: sql`${lotes.cantidadDisponible} + ${entrada.cantidad}` })
      .where(eq(lotes.id, entrada.loteId))
      .returning({ saldo: lotes.cantidadDisponible })

    if (!actualizado) return { ok: false as const, disponible: 0 }

    const [movimiento] = await tx
      .insert(movimientosStock)
      .values({
        loteId: entrada.loteId,
        cantidad: entrada.cantidad,
        tipo: entrada.tipo,
        motivo: entrada.motivo ?? null,
        documentoId: entrada.documentoId ?? null,
        registradoPor: entrada.registradoPor,
      })
      .returning({ id: movimientosStock.id })

    return { ok: true as const, saldo: actualizado.saldo, movimientoId: movimiento!.id }
  })
}

export async function saldoDe(loteId: string, ejecutor: Ejecutor = db): Promise<number> {
  const [lote] = await ejecutor
    .select({ saldo: lotes.cantidadDisponible })
    .from(lotes)
    .where(eq(lotes.id, loteId))

  return lote?.saldo ?? 0
}

/**
 * Una cantidad cero o negativa es un error de programación, no un caso de
 * negocio: `descontar(-5)` sería un ingreso disfrazado, y el libro registraría
 * una salida que en realidad sumó.
 */
function exigirCantidadPositiva(cantidad: number): void {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error(`la cantidad tiene que ser un entero positivo, llegó ${cantidad}`)
  }
}

/** Abre transacción solo si el ejecutor no es ya una. */
function enTransaccion<T>(ejecutor: Ejecutor, fn: (tx: Ejecutor) => Promise<T>): Promise<T> {
  return 'transaction' in ejecutor ? ejecutor.transaction((tx) => fn(tx)) : fn(ejecutor)
}
