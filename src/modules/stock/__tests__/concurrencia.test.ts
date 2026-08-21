import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { lotes, movimientosStock, productos } from '@/db/schema'
import { descontar, ingresar } from '@/modules/stock/saldo'
import { poolConcurrente, resetDb } from '@/test/db'

/**
 * La compuerta de M2.
 *
 * La carrera **no aparece en desarrollo**, donde todo corre secuencial. Aparece
 * el primer sábado con dos personas vendiendo, como un inventario que no cuadra
 * y sin forma de saber cuándo empezó a desviarse.
 *
 * Estos tests corren sobre un pool con conexiones REALES en paralelo: el pool de
 * la aplicación usa `max: 1` en tests, y sobre una sola conexión los descuentos
 * simultáneos se encolan y el test pasaría sin probar nada.
 */

const CONEXIONES = 10

let pool: ReturnType<typeof poolConcurrente>
let loteId: string

async function sembrarLote(cantidad: number): Promise<string> {
  const [producto] = await db
    .insert(productos)
    .values({
      codigo: 'P20U_600ML',
      nombre: 'Paca de 20 bolsas de 600 ml',
      presentacion: 'paca',
      contenidoMl: 600,
      unidades: 20,
      precioResidencial: '12000.00',
      precioComercial: '11000.00',
      precioMinimo: '9000.00',
    })
    .returning({ id: productos.id })

  const [lote] = await db
    .insert(lotes)
    .values({
      productoId: producto!.id,
      codigo: '2026-08-22-L1',
      fechaEmpaque: '2026-08-22',
      fechaVencimiento: '2026-09-21',
      cantidadInicial: cantidad,
      cantidadDisponible: cantidad,
    })
    .returning({ id: lotes.id })

  return lote!.id
}

beforeEach(async () => {
  await resetDb()
  loteId = await sembrarLote(100)
  pool = poolConcurrente(CONEXIONES)
})

afterEach(async () => {
  await pool.cerrar()
})

afterAll(async () => {
  await closeDb()
})

describe('el saldo bajo concurrencia real — RN-STK-03', () => {
  it('20 descuentos de 10 sobre un lote de 100: exactamente 10 tienen éxito', async () => {
    const intentos = Array.from({ length: 20 }, () =>
      descontar(
        { loteId, cantidad: 10, tipo: 'venta', registradoPor: null },
        pool.db,
      ),
    )

    const resultados = await Promise.all(intentos)
    const exitosos = resultados.filter((r) => r.ok)

    expect(exitosos).toHaveLength(10)

    const [lote] = await db.select().from(lotes).where(eq(lotes.id, loteId))
    expect(lote?.cantidadDisponible).toBe(0)
  })

  it('el libro tiene exactamente un movimiento por descuento exitoso', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        descontar({ loteId, cantidad: 10, tipo: 'venta', registradoPor: null }, pool.db),
      ),
    )

    const movimientos = await db.select().from(movimientosStock)

    // Ni de más (movimiento sin efecto) ni de menos (saldo sin explicación).
    expect(movimientos).toHaveLength(10)
    expect(movimientos.every((m) => m.cantidad === -10)).toBe(true)
  })

  it('la suma del libro explica el saldo, sin importar el orden', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        descontar({ loteId, cantidad: i % 2 === 0 ? 7 : 3, tipo: 'venta', registradoPor: null }, pool.db),
      ),
    )

    const movimientos = await db.select().from(movimientosStock).where(eq(movimientosStock.loteId, loteId))
    const [lote] = await db.select().from(lotes).where(eq(lotes.id, loteId))

    const movido = movimientos.reduce((total, m) => total + m.cantidad, 0)
    expect(lote!.cantidadDisponible).toBe(100 + movido)
  })

  it('nunca deja el saldo negativo, con cantidades desparejas', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        descontar({ loteId, cantidad: (i % 7) + 1, tipo: 'venta', registradoPor: null }, pool.db),
      ),
    )

    const [lote] = await db.select().from(lotes).where(eq(lotes.id, loteId))
    expect(lote!.cantidadDisponible).toBeGreaterThanOrEqual(0)
  })

  it('entradas y salidas simultáneas cuadran', async () => {
    await Promise.all([
      ...Array.from({ length: 15 }, () =>
        descontar({ loteId, cantidad: 10, tipo: 'venta', registradoPor: null }, pool.db),
      ),
      ...Array.from({ length: 5 }, () =>
        ingresar({ loteId, cantidad: 10, tipo: 'devolucion', registradoPor: null }, pool.db),
      ),
    ])

    const movimientos = await db.select().from(movimientosStock)
    const [lote] = await db.select().from(lotes).where(eq(lotes.id, loteId))

    const movido = movimientos.reduce((total, m) => total + m.cantidad, 0)
    expect(lote!.cantidadDisponible).toBe(100 + movido)
    expect(lote!.cantidadDisponible).toBeGreaterThanOrEqual(0)
  })
})

describe('quedarse sin stock es una respuesta, no un error', () => {
  it('no lanza: devuelve ok:false con lo que había', async () => {
    await descontar({ loteId, cantidad: 100, tipo: 'venta', registradoPor: null })

    const resultado = await descontar({ loteId, cantidad: 1, tipo: 'venta', registradoPor: null })

    expect(resultado.ok).toBe(false)
    if (!resultado.ok) expect(resultado.disponible).toBe(0)
  })

  it('un intento fallido no deja movimiento: el libro solo cuenta lo que pasó', async () => {
    await descontar({ loteId, cantidad: 200, tipo: 'venta', registradoPor: null })

    expect(await db.select().from(movimientosStock)).toHaveLength(0)
  })

  it('un intento fallido no toca el saldo', async () => {
    await descontar({ loteId, cantidad: 200, tipo: 'venta', registradoPor: null })

    const [lote] = await db.select().from(lotes).where(eq(lotes.id, loteId))
    expect(lote?.cantidadDisponible).toBe(100)
  })

  it('pedir exactamente lo que hay funciona', async () => {
    const resultado = await descontar({ loteId, cantidad: 100, tipo: 'venta', registradoPor: null })

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(0)
  })
})

describe('una cantidad no positiva es un error de programación', () => {
  it.each([0, -5, 1.5])('rechaza descontar %s', async (cantidad) => {
    await expect(
      descontar({ loteId, cantidad, tipo: 'venta', registradoPor: null }),
    ).rejects.toThrow(/entero positivo/)
  })

  it('rechaza ingresar una cantidad negativa: sería una salida disfrazada', async () => {
    await expect(
      ingresar({ loteId, cantidad: -10, tipo: 'ajuste', motivo: 'x', registradoPor: null }),
    ).rejects.toThrow(/entero positivo/)
  })
})
