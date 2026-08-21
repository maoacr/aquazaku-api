import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { lotes, movimientosStock, productos } from '@/db/schema'
import { asignarFifo, lotesVencidosConSaldo, sacarConFifo } from '@/modules/stock/asignacion'
import { poolConcurrente, resetDb } from '@/test/db'

/**
 * FIFO y vencidos — RN-STK-08.
 *
 * Todas las fechas son literales. Un `new Date()` en un test de vencimiento lo
 * vuelve verde hoy y rojo el mes que viene, sin que nadie haya tocado el código
 * — y el borde "vence hoy" solo se podría probar el día correcto.
 */

const HOY = '2026-08-22'

let productoId: string

async function sembrarProducto(): Promise<string> {
  const [p] = await db
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
  return p!.id
}

async function sembrarLote(codigo: string, vence: string, cantidad: number): Promise<string> {
  const [l] = await db
    .insert(lotes)
    .values({
      productoId,
      codigo,
      fechaEmpaque: '2026-07-01',
      fechaVencimiento: vence,
      cantidadInicial: cantidad,
      cantidadDisponible: cantidad,
    })
    .returning({ id: lotes.id })
  return l!.id
}

const saldoDeLote = async (id: string) =>
  (await db.select().from(lotes).where(eq(lotes.id, id)))[0]?.cantidadDisponible

beforeEach(async () => {
  await resetDb()
  productoId = await sembrarProducto()
})

afterAll(async () => {
  await closeDb()
})

describe('FIFO: sale primero lo que vence antes', () => {
  it('elige el lote más próximo a vencer, no el más viejo de creación', async () => {
    // Se crean en orden inverso al vencimiento a propósito: si el FIFO mirara
    // el orden de inserción en vez de la fecha, este test lo delataría.
    await sembrarLote('L-TARDE', '2026-12-31', 50)
    await sembrarLote('L-PRONTO', '2026-09-01', 50)

    const plan = await asignarFifo(productoId, 20, HOY)

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.asignaciones).toHaveLength(1)
      expect(plan.asignaciones[0]?.codigo).toBe('L-PRONTO')
    }
  })

  it('una salida abarca varios lotes cuando el primero no alcanza', async () => {
    await sembrarLote('L-PRONTO', '2026-09-01', 20)
    await sembrarLote('L-MEDIO', '2026-10-01', 30)
    await sembrarLote('L-TARDE', '2026-12-31', 50)

    const plan = await asignarFifo(productoId, 35, HOY)

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.asignaciones.map((a) => [a.codigo, a.cantidad])).toEqual([
        ['L-PRONTO', 20],
        ['L-MEDIO', 15],
      ])
    }
  })

  it('no toca lotes de más de los necesarios', async () => {
    await sembrarLote('L-PRONTO', '2026-09-01', 100)
    await sembrarLote('L-TARDE', '2026-12-31', 100)

    const plan = await asignarFifo(productoId, 10, HOY)

    if (plan.ok) expect(plan.asignaciones).toHaveLength(1)
  })

  it('cada lote deja su propio movimiento: sin eso no hay recall posible', async () => {
    await sembrarLote('L-PRONTO', '2026-09-01', 20)
    await sembrarLote('L-MEDIO', '2026-10-01', 30)

    await sacarConFifo({
      productoId,
      cantidad: 35,
      hoy: HOY,
      tipo: 'venta',
      registradoPor: null,
    })

    const movimientos = await db.select().from(movimientosStock)
    expect(movimientos).toHaveLength(2)
    expect(movimientos.map((m) => m.cantidad).sort((a, b) => a - b)).toEqual([-20, -15])
  })
})

describe('el bloqueo de vencidos es una condición, no un job', () => {
  it('un lote vencido no se ofrece para vender', async () => {
    await sembrarLote('L-VENCIDO', '2026-08-21', 100)

    const plan = await asignarFifo(productoId, 10, HOY)

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.disponible).toBe(0)
  })

  it('un lote que vence HOY todavía sirve: vence al terminar el día', async () => {
    await sembrarLote('L-HOY', HOY, 100)

    const plan = await asignarFifo(productoId, 10, HOY)

    expect(plan.ok).toBe(true)
  })

  it('el que venció ayer ya no, y el borde es de un solo día', async () => {
    await sembrarLote('L-AYER', '2026-08-21', 100)

    expect((await asignarFifo(productoId, 1, HOY)).ok).toBe(false)
    // El mismo lote, consultado un día antes, sí servía.
    expect((await asignarFifo(productoId, 1, '2026-08-21')).ok).toBe(true)
  })

  it('el vencido se saltea y la salida sigue con el siguiente vigente', async () => {
    await sembrarLote('L-VENCIDO', '2026-08-01', 100)
    await sembrarLote('L-VIGENTE', '2026-09-01', 40)

    const plan = await asignarFifo(productoId, 30, HOY)

    if (plan.ok) expect(plan.asignaciones[0]?.codigo).toBe('L-VIGENTE')
  })
})

describe('vencido NO es descartado — RN-STK-05', () => {
  it('el lote vencido conserva su saldo: el producto sigue en la bodega', async () => {
    const id = await sembrarLote('L-VENCIDO', '2026-08-01', 75)

    await asignarFifo(productoId, 10, HOY).catch(() => undefined)

    expect(await saldoDeLote(id)).toBe(75)
  })

  it('los vencidos con saldo se pueden listar: son los que hay que descartar', async () => {
    await sembrarLote('L-VENCIDO', '2026-08-01', 75)
    await sembrarLote('L-VIGENTE', '2026-09-01', 40)
    const agotado = await sembrarLote('L-VENCIDO-VACIO', '2026-08-02', 10)
    await db.update(lotes).set({ cantidadDisponible: 0 }).where(eq(lotes.id, agotado))

    const vencidos = await lotesVencidosConSaldo(HOY)

    // El vencido sin saldo no aparece: no hay nada que descartar.
    expect(vencidos.map((l) => l.codigo)).toEqual(['L-VENCIDO'])
  })
})

describe('cuando no alcanza', () => {
  it('informa cuánto había vendible, no cuánto hay en total', async () => {
    await sembrarLote('L-VENCIDO', '2026-08-01', 500)
    await sembrarLote('L-VIGENTE', '2026-09-01', 30)

    const plan = await asignarFifo(productoId, 100, HOY)

    expect(plan.ok).toBe(false)
    // 30, no 530: el vencido no se puede vender.
    if (!plan.ok) expect(plan.disponible).toBe(30)
  })

  it('no descuenta nada si la salida no se puede cubrir entera', async () => {
    const id = await sembrarLote('L-VIGENTE', '2026-09-01', 30)

    await sacarConFifo({ productoId, cantidad: 100, hoy: HOY, tipo: 'venta', registradoPor: null })

    expect(await saldoDeLote(id)).toBe(30)
    expect(await db.select().from(movimientosStock)).toHaveLength(0)
  })
})

describe('salidas simultáneas sobre varios lotes', () => {
  let pool: ReturnType<typeof poolConcurrente>

  beforeEach(() => {
    pool = poolConcurrente(8)
  })

  afterEach(async () => {
    await pool.cerrar()
  })

  it('doce salidas de 10 sobre 100 repartidos en tres lotes: exactamente diez pasan', async () => {
    await sembrarLote('L-1', '2026-09-01', 30)
    await sembrarLote('L-2', '2026-10-01', 30)
    await sembrarLote('L-3', '2026-11-01', 40)

    const resultados = await Promise.all(
      Array.from({ length: 12 }, () =>
        sacarConFifo(
          { productoId, cantidad: 10, hoy: HOY, tipo: 'venta', registradoPor: null },
          pool.db,
        ),
      ),
    )

    expect(resultados.filter((r) => r.ok)).toHaveLength(10)

    const total = (await db.select().from(lotes)).reduce((s, l) => s + l.cantidadDisponible, 0)
    expect(total).toBe(0)
  })

  it('el libro sigue explicando el saldo con salidas concurrentes multi-lote', async () => {
    await sembrarLote('L-1', '2026-09-01', 25)
    await sembrarLote('L-2', '2026-10-01', 25)

    await Promise.all(
      Array.from({ length: 10 }, () =>
        sacarConFifo(
          { productoId, cantidad: 7, hoy: HOY, tipo: 'venta', registradoPor: null },
          pool.db,
        ),
      ),
    )

    const movido = (await db.select().from(movimientosStock)).reduce((s, m) => s + m.cantidad, 0)
    const saldo = (await db.select().from(lotes)).reduce((s, l) => s + l.cantidadDisponible, 0)

    expect(saldo).toBe(50 + movido)
    expect(saldo).toBeGreaterThanOrEqual(0)
  })
})
