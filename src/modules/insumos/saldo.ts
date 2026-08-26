import { and, eq, gte, sql } from 'drizzle-orm'
import { type DB, db } from '@/db/client'
import { type MovimientoInsumo, insumos, movimientosInsumo } from '@/db/schema'

/**
 * El saldo de insumos — RN-INS-01 y RN-INS-02.
 *
 * ── Por qué esto no es un SELECT seguido de un UPDATE ───────────────────────
 *
 * Es el mismo problema que resolvió M2 en `stock/saldo.ts`, y se repite acá
 * porque la planta también consume desde más de un lugar: el cierre de
 * producción descuenta (M4) y el mostrador ajusta un conteo físico, las dos
 * contra el mismo saldo.
 *
 * El camino ingenuo tiene una carrera de manual:
 *
 *     1. SELECT saldo        → 10
 *     2. ¿alcanza para 8?    → sí
 *     3. UPDATE saldo = 10-8 → 2
 *
 * Dos procesos que leen 10 a la vez consumen 16 de 10.
 *
 * Y el CHECK NO los frena. Es lo que más engaña de este bug: el paso 3 escribe
 * un valor ABSOLUTO calculado sobre una lectura vieja, no un delta. Nunca
 * intenta escribir un número negativo, así que `saldo >= 0` se cumple
 * perfectamente y el saldo queda mal sin que nada proteste.
 *
 * En M2 eso se midió: 20 descuentos concurrentes, 20 éxitos, el libro sumando
 * −150 y cero errores. Un inventario que miente en silencio.
 *
 * El CHECK protege contra un valor negativo; el WHERE, contra una actualización
 * perdida. Son dos problemas distintos y hacen falta las dos defensas.
 *
 * Acá la decisión y el efecto son la misma operación: Postgres serializa los
 * UPDATE sobre la misma fila, así que entre «alcanza» y «descontado» no hay
 * ventana.
 */

/** `db` o una transacción abierta. M4 va a necesitar consumir dentro de la suya. */
type Transaccion = Parameters<Parameters<DB['transaction']>[0]>[0]
export type Ejecutor = DB | Transaccion

/**
 * La conversión de una compra que llegó por peso — RN-INS-02.
 *
 * Los dos campos viajan juntos y se guardan juntos: sin la equivalencia, «doce
 * kilos» no se puede auditar después, porque no hay forma de saber si un
 * descuadre vino de la balanza o del número que se usó para convertir.
 */
export interface Conversion {
  kilos: number
  /** Unidades por kilo, al momento de convertir. Se COPIA, no se referencia. */
  equivalencia: number
}

export interface Salida {
  insumoId: string
  /** Positiva, en unidades: cuánto sacar. */
  cantidad: number
  /**
   * No existe `venta`, y no es un olvido: `RN-INS-01`. Un insumo no se despacha
   * a un cliente — desaparece cuando se convierte en producto. El enum de la
   * base tampoco lo tiene.
   */
  tipo: 'produccion' | 'descarte' | 'ajuste'
  motivo?: string | undefined
  causa?: MovimientoInsumo['causa']
  documentoId?: string | undefined
  registradoPor: string | null
}

export interface Entrada {
  insumoId: string
  /** Positiva, en UNIDADES — ya convertida si vino por peso. */
  cantidad: number
  tipo: 'compra' | 'ajuste'
  motivo?: string | undefined
  /** Solo cuando la compra llegó en kilos. Queda registrada en el movimiento. */
  conversion?: Conversion | undefined
  documentoId?: string | undefined
  registradoPor: string | null
}

export type Resultado =
  | { ok: true; saldo: number; movimientoId: number }
  /** No alcanzaba. Es una respuesta, no un error. */
  | { ok: false; disponible: number }

/**
 * Saca unidades de un insumo.
 *
 * Devuelve `{ ok: false }` cuando no había suficiente — **no lanza**. Que no
 * alcance es un estado normal: la planta se queda sin tapas y hay que decirlo
 * con el número real, no con una excepción.
 *
 * **Un intento fallido no deja movimiento.** El libro cuenta lo que pasó, y un
 * intento que no descontó nada no pasó.
 */
export async function descontar(salida: Salida, ejecutor: Ejecutor = db): Promise<Resultado> {
  exigirCantidadPositiva(salida.cantidad)

  return enTransaccion(ejecutor, async (tx) => {
    // El WHERE es la validación. Si no se cumple no se actualiza nada, y no hay
    // ninguna ventana entre comprobar y descontar.
    const actualizados = await tx
      .update(insumos)
      .set({ saldo: sql`${insumos.saldo} - ${salida.cantidad}` })
      .where(and(eq(insumos.id, salida.insumoId), gte(insumos.saldo, salida.cantidad)))
      .returning({ saldo: insumos.saldo })

    const actualizado = actualizados[0]
    if (!actualizado) {
      return { ok: false as const, disponible: await saldoDe(salida.insumoId, tx) }
    }

    // El movimiento va en la MISMA transacción que el saldo. Si el saldo baja y
    // el movimiento no queda, el libro deja de explicar el saldo.
    const [movimiento] = await tx
      .insert(movimientosInsumo)
      .values({
        insumoId: salida.insumoId,
        cantidad: -salida.cantidad,
        tipo: salida.tipo,
        motivo: salida.motivo ?? null,
        causa: salida.causa ?? null,
        documentoId: salida.documentoId ?? null,
        registradoPor: salida.registradoPor,
      })
      .returning({ id: movimientosInsumo.id })

    return { ok: true as const, saldo: actualizado.saldo, movimientoId: movimiento!.id }
  })
}

/**
 * Mete unidades a un insumo: una compra, o un ajuste que da de más.
 *
 * No lleva `WHERE` de saldo — sumar siempre se puede. Pero sí va en la misma
 * transacción que su movimiento, por la misma razón que la salida.
 */
export async function ingresar(entrada: Entrada, ejecutor: Ejecutor = db): Promise<Resultado> {
  exigirCantidadPositiva(entrada.cantidad)

  return enTransaccion(ejecutor, async (tx) => {
    const [actualizado] = await tx
      .update(insumos)
      .set({ saldo: sql`${insumos.saldo} + ${entrada.cantidad}` })
      .where(eq(insumos.id, entrada.insumoId))
      .returning({ saldo: insumos.saldo })

    if (!actualizado) return { ok: false as const, disponible: 0 }

    const [movimiento] = await tx
      .insert(movimientosInsumo)
      .values({
        insumoId: entrada.insumoId,
        cantidad: entrada.cantidad,
        tipo: entrada.tipo,
        motivo: entrada.motivo ?? null,
        // Los dos campos o ninguno. Un CHECK de la base lo exige además de esto:
        // el servicio explica el error, la base impide el dato.
        kilos: entrada.conversion ? String(entrada.conversion.kilos) : null,
        equivalencia: entrada.conversion ? String(entrada.conversion.equivalencia) : null,
        documentoId: entrada.documentoId ?? null,
        registradoPor: entrada.registradoPor,
      })
      .returning({ id: movimientosInsumo.id })

    return { ok: true as const, saldo: actualizado.saldo, movimientoId: movimiento!.id }
  })
}

export async function saldoDe(insumoId: string, ejecutor: Ejecutor = db): Promise<number> {
  const [insumo] = await ejecutor
    .select({ saldo: insumos.saldo })
    .from(insumos)
    .where(eq(insumos.id, insumoId))

  return insumo?.saldo ?? 0
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
