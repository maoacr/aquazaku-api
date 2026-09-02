import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, cobros, lineasDeVenta, lotes, productos, ventas } from '@/db/schema'
import { resumenMensual } from '@/modules/contador/mensual'
import { resetDb } from '@/test/db'

/**
 * El resumen mensual — M11, RN-CON-07.
 *
 * Lo que se prueba acá es sobre todo lo que NO se puede pedir: meses parciales,
 * rangos al revés y meses inventados. El resumen existe para comparar meses, y
 * una fila que dice «agosto» sin ser agosto entero rompe justamente esa
 * comparación — sin que nadie lo note.
 */

let clienteId: string
let productoId: string
let loteId: string

async function ventaEn(fecha: string, total: string) {
  return db.transaction(async (tx) => {
    const [v] = await tx
      .insert(ventas)
      .values({
        clienteId,
        tipoClienteAlMomento: 'comercial',
        medioDePago: 'efectivo',
        tipo: 'producto',
        total,
        createdAt: new Date(`${fecha}T10:00:00-05:00`),
      })
      .returning()

    await tx.insert(lineasDeVenta).values({
      ventaId: v!.id,
      productoId,
      loteId,
      cantidad: 1,
      precioListaAplicado: total,
      descuentoMonto: '0.00',
      precioFinal: total,
      precioMinimoAplicado: '0.00',
    })

    return v!
  })
}

beforeEach(async () => {
  await resetDb()

  const [c] = await db
    .insert(clientes)
    .values({
      nombre: 'Panadería del Centro',
      tipoDocumento: 'NIT',
      numeroDocumento: '900456789',
      tipo: 'comercial',
    })
    .returning()
  clienteId = c!.id

  const [p] = await db
    .insert(productos)
    .values({
      codigo: 'BOT_20L',
      nombre: 'Recarga de botellón',
      presentacion: 'botellon',
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '12000.00',
      precioComercial: '10000.00',
      precioMinimo: '8000.00',
    })
    .returning()
  productoId = p!.id

  const [l] = await db
    .insert(lotes)
    .values({
      productoId,
      codigo: 'L-001',
      fechaEmpaque: '2026-01-01',
      fechaVencimiento: '2026-12-31',
      cantidadInicial: 9999,
      cantidadDisponible: 9999,
    })
    .returning()
  loteId = l!.id
})

afterAll(async () => {
  await closeDb()
})

describe('una fila por mes', () => {
  it('separa lo de cada mes', async () => {
    await ventaEn('2026-06-10', '100000.00')
    await ventaEn('2026-07-15', '250000.00')

    const meses = await resumenMensual({ desde: '2026-06', hasta: '2026-07' })

    expect(meses.map((m) => m.mes)).toEqual(['2026-06', '2026-07'])
    expect(meses[0]!.totales.entradas).toBe('100000.00')
    expect(meses[1]!.totales.entradas).toBe('250000.00')
  })

  /*
   * ── El mes vacío aparece, en cero ─────────────────────────────────────────
   *
   * Un mes ausente se lee como «no lo consulté». Uno en cero dice «no pasó
   * nada» — y en una planta que factura todos los días, eso es una alarma.
   */
  it('un mes sin movimiento aparece en cero, no desaparece', async () => {
    await ventaEn('2026-06-10', '100000.00')
    await ventaEn('2026-08-10', '100000.00')

    const meses = await resumenMensual({ desde: '2026-06', hasta: '2026-08' })

    expect(meses.map((m) => m.mes)).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(meses[1]!.totales.entradas).toBe('0.00')
  })

  it('cruza el fin de año sin saltearse diciembre ni enero', async () => {
    const meses = await resumenMensual({ desde: '2025-11', hasta: '2026-02' })

    expect(meses.map((m) => m.mes)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
})

/**
 * ── El borde del mes ────────────────────────────────────────────────────────
 *
 * El último día del mes es el que más se pierde: se calcula mal una vez y el
 * reporte queda corto para siempre, sin que nadie extrañe la fila que falta.
 */
describe('el mes entra ENTERO', () => {
  it('el día 1 y el último día cuentan', async () => {
    await ventaEn('2026-07-01', '10000.00')
    await ventaEn('2026-07-31', '20000.00')

    const [julio] = await resumenMensual({ desde: '2026-07', hasta: '2026-07' })

    expect(julio!.totales.entradas).toBe('30000.00')
  })

  it('febrero termina el 28, y en bisiesto el 29', async () => {
    await ventaEn('2024-02-29', '50000.00') // 2024 fue bisiesto

    const [feb] = await resumenMensual({ desde: '2024-02', hasta: '2024-02' })

    expect(feb!.totales.entradas).toBe('50000.00')
  })

  it('lo del mes siguiente NO se cuela', async () => {
    await ventaEn('2026-08-01', '99000.00')

    const [julio] = await resumenMensual({ desde: '2026-07', hasta: '2026-07' })

    expect(julio!.totales.entradas).toBe('0.00')
  })
})

describe('el desglose por tipo', () => {
  it('separa lo vendido de lo cobrado: son dos hechos distintos', async () => {
    await ventaEn('2026-07-10', '100000.00')
    await db.insert(cobros).values({ clienteId, monto: '40000.00', medioDePago: 'efectivo' })

    const mes = new Date().toISOString().slice(0, 7)
    const meses = await resumenMensual({ desde: '2026-07', hasta: mes })

    expect(meses[0]!.porTipo.venta).toBe('100000.00')
    expect(meses[0]!.porTipo.cobro).toBe('0.00')
    expect(meses.at(-1)!.porTipo.cobro).toBe('40000.00')
  })
})

/**
 * ── Lo que no se puede pedir ────────────────────────────────────────────────
 *
 * Entra en meses y sale en meses. Aceptar fechas sueltas daría meses parciales
 * con pinta de completos, y esa comparación falsa no la detecta nadie.
 */
describe('lo que se rechaza', () => {
  it('un rango al revés', async () => {
    await expect(resumenMensual({ desde: '2026-08', hasta: '2026-06' })).rejects.toThrow('al revés')
  })

  it('una fecha completa en vez de un mes', async () => {
    await expect(resumenMensual({ desde: '2026-08-15', hasta: '2026-08' })).rejects.toThrow(
      'como 2026-08',
    )
  })

  it('un mes 13', async () => {
    await expect(resumenMensual({ desde: '2026-13', hasta: '2026-13' })).rejects.toThrow(
      'como 2026-08',
    )
  })
})
