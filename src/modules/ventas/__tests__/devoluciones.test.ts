import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, lineasDeVenta, lotes, movimientosStock, productos } from '@/db/schema'
import type { UserContext } from '@/modules/authz/can'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { anularVenta } from '@/modules/ventas/anulacion'
import { registrarDevolucion } from '@/modules/ventas/devoluciones'
import { deudaDe } from '@/modules/ventas/saldo'
import { registrarVenta } from '@/modules/ventas/venta'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Devoluciones — RN-VEN-10.
 *
 * Devolver NO es anular. La anulación cancela la venta entera; la devolución no
 * cancela nada — la venta ocurrió y el cliente trajo parte del producto.
 */

const HOY = '2026-08-26'
const MOTIVO = 'el cliente dijo que el agua tenía mal sabor'

let productoId: string
let clienteId: string

beforeEach(async () => {
  await resetDb()

  const [producto] = await db
    .insert(productos)
    .values({
      codigo: 'BOT_20L',
      nombre: 'Recarga de botellón de 20 L',
      presentacion: 'botellon',
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })
    .returning()
  productoId = producto!.id

  await crearLoteConEntrada(
    { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
    db,
  )

  const [cliente] = await db
    .insert(clientes)
    .values({
      nombre: 'Yeimy',
      tipoDocumento: 'CC',
      numeroDocumento: '79123456',
      verificacionEstado: 'verificado',
      verificadoEn: new Date(),
      verificacionMetodo: 'admin_oficial',
      creditoHabilitado: true,
    })
    .returning()
  clienteId = cliente!.id
})

afterAll(async () => {
  await closeDb()
})

/** Vende 5 y devuelve el id de su única línea. */
async function venderCinco(medioDePago: 'efectivo' | 'credito' = 'efectivo') {
  const { venta } = await registrarVenta(
    {
      medioDePago,
      ...(medioDePago === 'credito' ? { clienteId } : {}),
      items: [{ productoId, cantidad: 5 }],
      hoy: HOY,
    },
    null,
  )
  const [linea] = await db.select().from(lineasDeVenta).where(eq(lineasDeVenta.ventaId, venta.id))

  return { venta, lineaId: linea!.id }
}

const saldo = async () =>
  (await db.select().from(lotes).where(eq(lotes.productoId, productoId)))[0]!.cantidadDisponible

describe('el producto sano vuelve al stock', () => {
  it('al MISMO lote, y se puede volver a vender', async () => {
    const { lineaId } = await venderCinco()
    expect(await saldo()).toBe(95)

    const { volvioAlStock } = await registrarDevolucion(
      { lineaId, cantidad: 2, estadoProducto: 'sano', motivo: MOTIVO },
      null,
    )

    expect(volvioAlStock).toBe(true)
    expect(await saldo()).toBe(97)
  })
})

/**
 * ── Lo dañado y lo vencido PASAN por el lote ────────────────────────────────
 *
 * Podría no entrar nunca, pero el producto existe: si no se registrara la
 * entrada, el descarte saldría de un lote que nunca lo recibió y el libro no
 * podría explicarlo. Dos movimientos dicen la verdad completa — volvió, y se
 * descartó.
 */
describe('lo que no se puede vender entra y sale', () => {
  it('el saldo queda igual, con dos movimientos que lo explican', async () => {
    const { lineaId } = await venderCinco()
    const antes = await saldo()

    const { volvioAlStock } = await registrarDevolucion(
      { lineaId, cantidad: 2, estadoProducto: 'danado', motivo: MOTIVO },
      null,
    )

    expect(volvioAlStock).toBe(false)
    expect(await saldo()).toBe(antes)

    const movimientos = await db.select().from(movimientosStock)
    const devolucion = movimientos.find((m) => m.tipo === 'devolucion')
    const descarte = movimientos.find((m) => m.tipo === 'descarte')

    expect(devolucion?.cantidad).toBe(2)
    expect(descarte?.cantidad).toBe(-2)
    expect(descarte?.causa).toBe('mal_manejo_cliente')
  })

  it('lo vencido se descarta con su causa', async () => {
    const { lineaId } = await venderCinco()

    await registrarDevolucion(
      { lineaId, cantidad: 1, estadoProducto: 'vencido', motivo: 'llegó pasado de fecha' },
      null,
    )

    const [descarte] = await db
      .select()
      .from(movimientosStock)
      .where(eq(movimientosStock.tipo, 'descarte'))

    expect(descarte?.causa).toBe('vencido')
  })
})

/**
 * ── Acreditar solo tiene sentido si hay deuda ───────────────────────────────
 *
 * De contado el cliente ya pagó en efectivo: bajarle una deuda que no tiene lo
 * dejaría en negativo. Devolverle la plata es un REEMBOLSO, y ese es otro
 * documento que el dominio todavía no definió.
 */
describe('la plata', () => {
  it('una venta a crédito baja la deuda por lo devuelto', async () => {
    const { lineaId } = await venderCinco('credito')
    expect(await deudaDe(clienteId)).toBe('50000.00')

    const { montoAcreditado } = await registrarDevolucion(
      { lineaId, cantidad: 2, estadoProducto: 'sano', motivo: MOTIVO },
      null,
    )

    expect(montoAcreditado).toBe('20000.00')
    expect(await deudaDe(clienteId)).toBe('30000.00')
  })

  it('una venta de contado no acredita nada', async () => {
    const { lineaId } = await venderCinco()

    const { montoAcreditado } = await registrarDevolucion(
      { lineaId, cantidad: 2, estadoProducto: 'sano', motivo: MOTIVO },
      null,
    )

    expect(montoAcreditado).toBe('0.00')
  })
})

describe('lo que la devolución no deja hacer', () => {
  it('devolver más de lo vendido', async () => {
    const { lineaId } = await venderCinco()

    await expect(
      registrarDevolucion({ lineaId, cantidad: 9, estadoProducto: 'sano', motivo: MOTIVO }, null),
    ).rejects.toMatchObject({ code: 'DEVUELVE_DE_MAS' })
  })

  it('devolver de a poco hasta pasarse tampoco', async () => {
    const { lineaId } = await venderCinco()
    await registrarDevolucion({ lineaId, cantidad: 3, estadoProducto: 'sano', motivo: MOTIVO }, null)

    await expect(
      registrarDevolucion({ lineaId, cantidad: 3, estadoProducto: 'sano', motivo: MOTIVO }, null),
    ).rejects.toMatchObject({ code: 'DEVUELVE_DE_MAS' })
  })

  /**
   * Anular ya devolvió TODO el producto al lote. Aceptar una devolución encima
   * lo contaría dos veces, y el inventario diría que hay más de lo que hay.
   */
  it('devolver sobre una venta anulada', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta, lineaId } = await venderCinco()
    await anularVenta(venta.id, 'me equivoqué de cliente al registrar', {
      id: admin.usuario.id,
      roles: ['admin'],
    } as UserContext)

    await expect(
      registrarDevolucion({ lineaId, cantidad: 1, estadoProducto: 'sano', motivo: MOTIVO }, null),
    ).rejects.toMatchObject({ code: 'VENTA_ANULADA' })
  })

  it('sin explicación', async () => {
    const { lineaId } = await venderCinco()

    await expect(
      registrarDevolucion({ lineaId, cantidad: 1, estadoProducto: 'sano', motivo: 'x' }, null),
    ).rejects.toMatchObject({ code: 'MOTIVO_REQUERIDO' })
  })
})
