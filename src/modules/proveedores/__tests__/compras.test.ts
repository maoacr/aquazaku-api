import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { bases, compras, movimientosBotellon, proveedores } from '@/db/schema'
import { saldoDe } from '@/modules/insumos/saldo'
import { crearInsumo } from '@/modules/insumos/service'
import { botellonesEnBodega } from '@/modules/retornables/conservacion'
import { comprasVencidas, marcarPagada, registrarCompra } from '@/modules/proveedores/compras'
import { resetDb } from '@/test/db'

/**
 * La compra a proveedor — M9, RN-PRO-02 a 07.
 *
 * Lo que se prueba acá es la unión: que el documento y el inventario caigan
 * juntos o no caiga ninguno. Registrar la compra sin mover el inventario deja
 * mercadería pagada que el sistema no ve; moverlo sin la compra deja stock que
 * apareció de la nada.
 */

const HOY = '2026-08-27'

let proveedorId: string
let tapaId: string

beforeEach(async () => {
  await resetDb()

  const [p] = await db.insert(proveedores).values({ nombre: 'Plásticos del Caribe' }).returning()
  proveedorId = p!.id

  // Por el servicio real: `insumos.codigo` es NOT NULL y lo pone `crearInsumo`.
  tapaId = (await crearInsumo({ codigo: 'TAPA', nombre: 'Tapa de botellón', minimo: 200 })).id
})

afterAll(async () => {
  await closeDb()
})

const deContado = (lineas: Parameters<typeof registrarCompra>[0]['lineas']) =>
  registrarCompra({ proveedorId, medioDePago: 'efectivo', lineas }, null)

describe('la compra mueve el inventario que le corresponde', () => {
  it('un insumo entra al saldo del insumo', async () => {
    await deContado([{ insumoId: tapaId, cantidad: 500, costoUnitario: '120.00' }])

    expect(await saldoDe(tapaId)).toBe(500)
  })

  it('los botellones entran al parque', async () => {
    await deContado([{ botellones: 100, cantidad: 100, costoUnitario: '18000.00' }])

    expect(await botellonesEnBodega()).toBe(100)
  })

  /*
   * Las bases se numeran de a una, con el consecutivo que ya sabe calcular
   * `comprarBases`. Reimplementarlo acá sería la segunda copia de una regla que
   * vive en un solo lugar.
   */
  it('las bases entran numeradas, sin reimplementar el consecutivo', async () => {
    await deContado([{ bases: 3, cantidad: 3, costoUnitario: '80000.00' }])

    const creadas = await db.select().from(bases).orderBy(bases.idSticker)

    expect(creadas.map((b) => b.idSticker)).toEqual(['0001', '0002', '0003'])
  })

  it('el total sale de cantidad por costo, congelado — RN-PRO-04', async () => {
    const { compra } = await deContado([
      { insumoId: tapaId, cantidad: 500, costoUnitario: '120.00' },
      { botellones: 10, cantidad: 10, costoUnitario: '18000.00' },
    ])

    // 500 × 120 = 60.000 · 10 × 18.000 = 180.000
    expect(compra.total).toBe('240000.00')
  })
})

/**
 * ── O caen las dos cosas o no cae ninguna — RN-PRO-05 ───────────────────────
 */
describe('la transacción', () => {
  it('si una línea falla, no queda ni la compra ni el inventario', async () => {
    await expect(
      deContado([
        { botellones: 50, cantidad: 50, costoUnitario: '18000.00' },
        // El insumo no existe: la compra entera se cae.
        { insumoId: '00000000-0000-0000-0000-000000000000', cantidad: 1, costoUnitario: '1.00' },
      ]),
    ).rejects.toMatchObject({ code: 'INSUMO_NO_ENCONTRADO' })

    expect(await botellonesEnBodega()).toBe(0)
    expect(await db.select().from(compras)).toHaveLength(0)
    expect(await db.select().from(movimientosBotellon)).toHaveLength(0)
  })

  it('una línea que compra dos cosas a la vez no se puede convertir en movimiento', async () => {
    await expect(
      deContado([{ botellones: 5, bases: 5, cantidad: 5, costoUnitario: '100.00' }]),
    ).rejects.toMatchObject({ code: 'LINEA_AMBIGUA' })
  })

  it('una compra sin líneas no es una compra', async () => {
    await expect(deContado([])).rejects.toMatchObject({ code: 'COMPRA_VACIA' })
  })
})

/**
 * ── El crédito está modelado y no se ejerce — RN-PRO-06 y 07 ────────────────
 */
describe('el medio de pago', () => {
  it('lo de contado nace pagado: no hay nada que cobrar después', async () => {
    const { compra } = await deContado([{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }])

    expect(compra.pagada).toBe(true)
    expect(compra.venceEl).toBeNull()
  })

  it('a crédito sin fecha no se puede reclamar ni avisar', async () => {
    await expect(
      registrarCompra(
        {
          proveedorId,
          medioDePago: 'credito',
          lineas: [{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'VENCIMIENTO_REQUERIDO' })
  })

  it('y lo que se paga de contado no vence', async () => {
    await expect(
      registrarCompra(
        {
          proveedorId,
          medioDePago: 'efectivo',
          venceEl: '2026-09-30',
          lineas: [{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'VENCIMIENTO_SIN_CREDITO' })
  })

  it('a crédito con su fecha nace pendiente', async () => {
    const { compra } = await registrarCompra(
      {
        proveedorId,
        medioDePago: 'credito',
        venceEl: '2026-09-30',
        lineas: [{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }],
      },
      null,
    )

    expect(compra.pagada).toBe(false)
    expect(compra.venceEl).toBe('2026-09-30')
  })
})

/**
 * ── Lo vencido no necesita umbral — RN-PRO-07 ──────────────────────────────
 *
 * El aviso de bases tuvo que DERIVAR su umbral. Acá el dato ya es una fecha: o
 * pasó o no pasó.
 */
describe('el aviso de vencidas', () => {
  const aCredito = (venceEl: string) =>
    registrarCompra(
      {
        proveedorId,
        medioDePago: 'credito',
        venceEl,
        lineas: [{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }],
      },
      null,
    )

  it('avisa lo que ya pasó de fecha, con los días de atraso', async () => {
    await aCredito('2026-08-20')

    const vencidas = await comprasVencidas(HOY)

    expect(vencidas).toHaveLength(1)
    expect(vencidas[0]!.diasDeAtraso).toBe(7)
    expect(vencidas[0]!.proveedor).toBe('Plásticos del Caribe')
  })

  it('no avisa lo que todavía no vence', async () => {
    await aCredito('2026-09-30')

    expect(await comprasVencidas(HOY)).toHaveLength(0)
  })

  /*
   * Una compra de contado nace pagada, así que no puede aparecer en el aviso ni
   * por error. Este test lo confirma desde afuera.
   */
  it('lo de contado nunca aparece', async () => {
    await deContado([{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }])

    expect(await comprasVencidas(HOY)).toHaveLength(0)
  })

  it('una vez pagada deja de avisar', async () => {
    const { compra } = await aCredito('2026-08-20')

    await marcarPagada(compra.id)

    expect(await comprasVencidas(HOY)).toHaveLength(0)
  })
})

describe('marcar pagada', () => {
  it('pagar dos veces se rechaza: significaría mandar la plata dos veces', async () => {
    const { compra } = await deContado([{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }])

    await expect(marcarPagada(compra.id)).rejects.toMatchObject({ code: 'COMPRA_YA_PAGADA' })
  })

  it('una anulada no se paga: no hay nada que deber', async () => {
    const { compra } = await registrarCompra(
      {
        proveedorId,
        medioDePago: 'credito',
        venceEl: '2026-09-30',
        lineas: [{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }],
      },
      null,
    )

    await db
      .update(compras)
      .set({ estado: 'anulada', motivoAnulacion: 'el proveedor facturó otra cosa' })
      .where(eq(compras.id, compra.id))

    await expect(marcarPagada(compra.id)).rejects.toMatchObject({ code: 'COMPRA_ANULADA' })
  })
})

describe('el proveedor', () => {
  /*
   * Un proveedor desactivado conserva su historial pero no recibe compras
   * nuevas. Si le volvieron a comprar, se reactiva primero: eso deja el hecho
   * registrado en vez de contradecirlo en silencio.
   */
  it('uno desactivado no recibe compras nuevas', async () => {
    await db.update(proveedores).set({ activo: false }).where(eq(proveedores.id, proveedorId))

    await expect(
      deContado([{ botellones: 10, cantidad: 10, costoUnitario: '100.00' }]),
    ).rejects.toMatchObject({ code: 'PROVEEDOR_INACTIVO' })
  })
})
