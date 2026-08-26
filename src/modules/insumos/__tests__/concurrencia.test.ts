import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { insumos, movimientosInsumo } from '@/db/schema'
import { descontar, ingresar } from '@/modules/insumos/saldo'
import { poolConcurrente, resetDb } from '@/test/db'

/**
 * La compuerta de M3.
 *
 * La carrera **no aparece en desarrollo**, donde todo corre secuencial. Aparece
 * el día que el cierre de producción descuenta mientras alguien registra un
 * conteo físico, como un inventario que no cuadra y sin forma de saber cuándo
 * empezó a desviarse.
 *
 * Y acá se descubre tarde de la peor manera: la planta cree que le quedan tapas
 * y se entera de que no cuando ya está envasando.
 *
 * Estos tests corren sobre un pool con conexiones REALES en paralelo: el pool
 * de la aplicación usa `max: 1` en tests, y sobre una sola conexión los
 * descuentos simultáneos se encolan — el test pasaría sin probar nada.
 */

const CONEXIONES = 10

let pool: ReturnType<typeof poolConcurrente>
let insumoId: string

async function sembrarInsumo(saldo: number): Promise<string> {
  const [insumo] = await db
    .insert(insumos)
    .values({
      codigo: 'TAPA_20L',
      nombre: 'Tapa para botellón de 20 L',
      minimo: 200,
      saldo,
    })
    .returning({ id: insumos.id })

  return insumo!.id
}

beforeEach(async () => {
  await resetDb()
  insumoId = await sembrarInsumo(100)
  pool = poolConcurrente(CONEXIONES)
})

afterEach(async () => {
  await pool.cerrar()
})

afterAll(async () => {
  await closeDb()
})

describe('el saldo de insumos bajo concurrencia real', () => {
  it('20 descuentos de 10 sobre un saldo de 100: exactamente 10 tienen éxito', async () => {
    const intentos = Array.from({ length: 20 }, () =>
      descontar({ insumoId, cantidad: 10, tipo: 'produccion', registradoPor: null }, pool.db),
    )

    const resultados = await Promise.all(intentos)

    expect(resultados.filter((r) => r.ok)).toHaveLength(10)

    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, insumoId))
    expect(insumo?.saldo).toBe(0)
  })

  /**
   * Un intento fallido NO deja movimiento.
   *
   * El libro cuenta lo que pasó, y un intento que no descontó nada no pasó. Con
   * movimientos de más, la suma del libro dejaría de explicar el saldo — que es
   * exactamente lo que el libro existe para poder hacer.
   */
  it('el libro tiene exactamente un movimiento por descuento exitoso', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        descontar({ insumoId, cantidad: 10, tipo: 'produccion', registradoPor: null }, pool.db),
      ),
    )

    const movimientos = await db.select().from(movimientosInsumo)

    expect(movimientos).toHaveLength(10)
    expect(movimientos.every((m) => m.cantidad === -10)).toBe(true)
  })

  it('la suma del libro explica el saldo, sin importar el orden', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        descontar(
          { insumoId, cantidad: i % 2 === 0 ? 7 : 3, tipo: 'produccion', registradoPor: null },
          pool.db,
        ),
      ),
    )

    const movimientos = await db
      .select()
      .from(movimientosInsumo)
      .where(eq(movimientosInsumo.insumoId, insumoId))
    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, insumoId))

    const movido = movimientos.reduce((total, m) => total + m.cantidad, 0)
    expect(insumo!.saldo).toBe(100 + movido)
  })

  it('nunca deja el saldo negativo, con cantidades desparejas', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        descontar(
          { insumoId, cantidad: (i % 7) + 1, tipo: 'produccion', registradoPor: null },
          pool.db,
        ),
      ),
    )

    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, insumoId))
    expect(insumo!.saldo).toBeGreaterThanOrEqual(0)
  })

  it('entradas y salidas simultáneas cuadran', async () => {
    await Promise.all([
      ...Array.from({ length: 15 }, () =>
        descontar({ insumoId, cantidad: 10, tipo: 'produccion', registradoPor: null }, pool.db),
      ),
      ...Array.from({ length: 5 }, () =>
        ingresar({ insumoId, cantidad: 10, tipo: 'compra', registradoPor: null }, pool.db),
      ),
    ])

    const movimientos = await db
      .select()
      .from(movimientosInsumo)
      .where(eq(movimientosInsumo.insumoId, insumoId))
    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, insumoId))

    const movido = movimientos.reduce((total, m) => total + m.cantidad, 0)
    expect(insumo!.saldo).toBe(100 + movido)
    expect(insumo!.saldo).toBeGreaterThanOrEqual(0)
  })
})

describe('cuando no alcanza, es una respuesta y no un error', () => {
  it('no lanza: devuelve ok:false con lo que había', async () => {
    const resultado = await descontar({
      insumoId,
      cantidad: 500,
      tipo: 'produccion',
      registradoPor: null,
    })

    expect(resultado.ok).toBe(false)
    if (!resultado.ok) expect(resultado.disponible).toBe(100)
  })

  it('un intento fallido no deja movimiento', async () => {
    await descontar({ insumoId, cantidad: 500, tipo: 'produccion', registradoPor: null })

    const movimientos = await db.select().from(movimientosInsumo)
    expect(movimientos).toHaveLength(0)
  })

  it('un intento fallido no toca el saldo', async () => {
    await descontar({ insumoId, cantidad: 500, tipo: 'produccion', registradoPor: null })

    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, insumoId))
    expect(insumo?.saldo).toBe(100)
  })

  it('pedir exactamente lo que hay funciona', async () => {
    // La frontera. Un `>` en vez de un `>=` dejaría el último puñado de tapas
    // inalcanzable, y nadie lo notaría hasta quedarse trabado con stock a la vista.
    const resultado = await descontar({
      insumoId,
      cantidad: 100,
      tipo: 'produccion',
      registradoPor: null,
    })

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(0)
  })

  it('rechaza descontar una cantidad negativa: sería una entrada disfrazada', async () => {
    await expect(
      descontar({ insumoId, cantidad: -5, tipo: 'produccion', registradoPor: null }),
    ).rejects.toThrow(/entero positivo/)
  })
})

/**
 * La conversión queda registrada en el movimiento, no solo su resultado.
 *
 * Sin los kilos y la equivalencia, un descuadre es imposible de reconstruir: no
 * se sabe si se pesó mal, si la equivalencia estaba vieja o si faltaron bolsas
 * de verdad.
 */
describe('la compra por peso deja rastro de cómo se convirtió', () => {
  it('guarda los kilos y la equivalencia que se usó', async () => {
    const resultado = await ingresar({
      insumoId,
      cantidad: 1200,
      tipo: 'compra',
      conversion: { kilos: 12, equivalencia: 100 },
      registradoPor: null,
    })

    expect(resultado.ok).toBe(true)

    const [movimiento] = await db.select().from(movimientosInsumo)
    expect(movimiento?.cantidad).toBe(1200)
    expect(movimiento?.kilos).toBe('12.000')
    expect(movimiento?.equivalencia).toBe('100.000')
  })

  it('una compra en unidades no inventa una conversión', async () => {
    await ingresar({ insumoId, cantidad: 500, tipo: 'compra', registradoPor: null })

    const [movimiento] = await db.select().from(movimientosInsumo)
    expect(movimiento?.kilos).toBeNull()
    expect(movimiento?.equivalencia).toBeNull()
  })
})
