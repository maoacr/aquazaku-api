import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, productos } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let productoId: string
let clienteId: string

const HOY = new Date().toISOString().slice(0, 10)

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

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
  await app?.close()
  await closeDb()
})

const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

const como = async (rol: Role, pedido: Omit<InjectOptions, 'headers'>) => {
  const usuario = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie: usuario.cookie } })
}

const UNA_VENTA = { medioDePago: 'efectivo', items: [{ productoId: '', cantidad: 2 }] }
const conProducto = (extra: object = {}) => ({
  ...UNA_VENTA,
  items: [{ productoId, cantidad: 2 }],
  ...extra,
})

describe('POST /ventas', () => {
  it('el `pos` vende: es quien está en el mostrador', async () => {
    const res = await como('pos', { method: 'POST', url: '/ventas', payload: conProducto() })

    expect(res.statusCode).toBe(201)
    expect(res.json().venta.total).toBe('20000.00')
  })

  it('el `contador` mira pero no vende', async () => {
    expect((await como('contador', { method: 'GET', url: '/ventas' })).statusCode).toBe(200)

    const res = await como('contador', { method: 'POST', url: '/ventas', payload: conProducto() })
    expect(res.statusCode).toBe(403)
  })

  it('un intento denegado queda auditado', async () => {
    await como('contador', { method: 'POST', url: '/ventas', payload: conProducto() })

    const [ultimo] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('ventas')
  })

  it('vender más de lo que hay responde 422 con el número real', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 999 }] }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('STOCK_INSUFICIENTE')
    expect(res.json().mensaje).toMatch(/quedan 100/)
  })

  it('a crédito sin cliente lo atrapa Zod antes que el servicio', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ medioDePago: 'credito' }),
    })

    // El CHECK de la base también lo impediría; acá falla antes, y está bien.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})

/**
 * ── El contrato incluye lo que NO existe ────────────────────────────────────
 *
 * Una venta confirmada no se edita — RN-VEN-02. Es la regla que más se pide
 * romper por comodidad y la que más caro sale romper.
 */
describe('una venta no se edita', () => {
  it('no existe PATCH', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    expect(
      (await comoAdmin({
        method: 'PATCH',
        url: `/ventas/${venta.venta.id}`,
        payload: { total: '1.00' },
      })).statusCode,
    ).toBe(404)
  })

  it('no existe DELETE', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/ventas/${venta.venta.id}` })).statusCode,
    ).toBe(404)
  })
})

/**
 * ── El alcance sale de la matriz, no de la ruta ─────────────────────────────
 *
 * `pos` y `seller` ven y anulan lo PROPIO; `admin`, todo.
 */
describe('el alcance de ver y anular', () => {
  it('un `pos` solo ve sus ventas', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const res = await como('pos', { method: 'GET', url: '/ventas' })

    expect(res.json()).toHaveLength(0)
  })

  it('el `admin` ve todas', async () => {
    await como('pos', { method: 'POST', url: '/ventas', payload: conProducto() })

    expect((await comoAdmin({ method: 'GET', url: '/ventas' })).json()).toHaveLength(1)
  })

  it('un `pos` no anula la venta de otro', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    const res = await como('pos', {
      method: 'POST',
      url: `/ventas/${venta.venta.id}/anulacion`,
      payload: { motivo: 'me equivoqué de producto al cargar' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('NO_ES_SU_VENTA')
  })

  it('sin motivo no se anula, ni siendo admin', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${venta.venta.id}/anulacion`,
      payload: { motivo: 'x' },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('los cobros', () => {
  const venderACredito = () =>
    comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ medioDePago: 'credito', clienteId }),
    })

  it('un cobro parcial deja la deuda restante', async () => {
    await venderACredito()

    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '5000.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().deudaRestante).toBe('15000.00')
    expect(res.json().quedaSaldada).toBe(false)
  })

  it('cobrar de más se rechaza con la deuda real', async () => {
    await venderACredito()

    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '99999.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('COBRO_MAYOR_QUE_LA_DEUDA')
  })

  /** `credito` no es un medio de PAGO: pagar deuda con deuda no la reduce. */
  it('no se cobra a crédito', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '5000.00', medioDePago: 'credito' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('la deuda del cliente es consultable', async () => {
    await venderACredito()

    const res = await comoAdmin({ method: 'GET', url: `/clientes/${clienteId}/deuda` })

    expect(res.json().deuda).toBe('20000.00')
  })
})

describe('los códigos de descuento son del admin — RN-VEN-13', () => {
  const UN_CODIGO = {
    codigo: 'VERANO2026',
    tipo: 'porcentaje',
    valor: '10',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2026-12-31',
  }

  it('el `pos` no los crea', async () => {
    expect(
      (await como('pos', { method: 'POST', url: '/descuentos', payload: UN_CODIGO })).statusCode,
    ).toBe(403)
  })

  it('el admin sí, y se aplica en la venta', async () => {
    expect(
      (await comoAdmin({ method: 'POST', url: '/descuentos', payload: UN_CODIGO })).statusCode,
    ).toBe(201)

    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ codigoDescuento: 'VERANO2026' }),
    })

    expect(res.json().venta.total).toBe('18000.00')
  })

  it('se desactivan, no se borran', async () => {
    const codigo = (await comoAdmin({ method: 'POST', url: '/descuentos', payload: UN_CODIGO })).json()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/descuentos/${codigo.id}` })).statusCode,
    ).toBe(404)

    const res = await comoAdmin({ method: 'PATCH', url: `/descuentos/${codigo.id}/desactivar` })
    expect(res.json().activo).toBe(false)
  })
})

describe('la devolución', () => {
  it('vuelve al stock y queda colgada de la venta', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()
    const detalle = (await comoAdmin({ method: 'GET', url: `/ventas/${venta.venta.id}` })).json()

    const res = await comoAdmin({
      method: 'POST',
      url: '/devoluciones',
      payload: {
        lineaId: detalle.lineas[0].id,
        cantidad: 1,
        estadoProducto: 'sano',
        motivo: 'el cliente pidió de menos de lo que necesitaba',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().volvioAlStock).toBe(true)

    const conDevolucion = (await comoAdmin({ method: 'GET', url: `/ventas/${venta.venta.id}` })).json()
    expect(conDevolucion.devoluciones).toHaveLength(1)
  })
})
