import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb } from '@/db/client'
import type { Role } from '@/modules/authz/matrix'
import { crearInsumo } from '@/modules/insumos/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { cookie: string }
let tapaId: string

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')
  tapaId = (await crearInsumo({ codigo: 'TAPA', nombre: 'Tapa de botellón', minimo: 200 })).id
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

const crearProveedor = (nombre = 'Plásticos del Caribe', extra: object = {}) =>
  comoAdmin({ method: 'POST', url: '/proveedores', payload: { nombre, ...extra } })

describe('los proveedores', () => {
  it('se crean sin exigir NIT', async () => {
    const res = await crearProveedor('El de las tapas')

    expect(res.statusCode).toBe(201)
    expect(res.json().activo).toBe(true)
    expect(res.json().nit).toBeNull()
  })

  it('dos con el mismo NIT es el mismo cargado dos veces', async () => {
    await crearProveedor('Uno', { nit: '900123456' })

    const res = await crearProveedor('Otro', { nit: '900123456' })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NIT_DUPLICADO')
    // Nombra al que ya está, para que quede claro que no hay que crear otro.
    expect(res.json().mensaje).toContain('Uno')
  })

  /**
   * ── El `pos` compra, pero no da de alta proveedores ────────────────────────
   *
   * Quien recibe la mercadería registra lo que llegó; abrir un proveedor nuevo
   * es una decisión del negocio, no del mostrador. Lo dice la matriz desde M0.
   */
  it('el `pos` los ve y no los crea', async () => {
    expect((await como('pos', { method: 'GET', url: '/proveedores' })).statusCode).toBe(200)

    const res = await como('pos', {
      method: 'POST',
      url: '/proveedores',
      payload: { nombre: 'Uno nuevo' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('el `seller` ni siquiera los ve', async () => {
    expect((await como('seller', { method: 'GET', url: '/proveedores' })).statusCode).toBe(403)
  })

  it('se desactivan, y la lista deja de traerlos', async () => {
    const id = (await crearProveedor()).json().id

    const res = await comoAdmin({
      method: 'PATCH',
      url: `/proveedores/${id}/estado`,
      payload: { activo: false },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().activo).toBe(false)
    expect((await comoAdmin({ method: 'GET', url: '/proveedores' })).json()).toHaveLength(0)
  })

  /*
   * Reactivar existe porque el caso real es «le volvimos a comprar»: la compra a
   * un inactivo se rechaza, y el camino correcto es reactivarlo en vez de crear
   * un duplicado con el mismo NIT.
   */
  it('y se vuelven a activar cuando se les compra de nuevo', async () => {
    const id = (await crearProveedor()).json().id
    await comoAdmin({
      method: 'PATCH',
      url: `/proveedores/${id}/estado`,
      payload: { activo: false },
    })

    const res = await comoAdmin({
      method: 'PATCH',
      url: `/proveedores/${id}/estado`,
      payload: { activo: true },
    })

    expect(res.json().activo).toBe(true)
  })
})

describe('las compras', () => {
  const conProveedor = async () => (await crearProveedor()).json().id as string

  it('registran el documento y el inventario de una vez', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/compras',
      payload: {
        proveedorId: await conProveedor(),
        medioDePago: 'efectivo',
        lineas: [{ insumoId: tapaId, cantidad: 500, costoUnitario: '120.00' }],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().compra.total).toBe('60000.00')
    expect(res.json().lineas).toHaveLength(1)
  })

  it('el `pos` sí registra compras: es quien recibe la mercadería', async () => {
    const res = await como('pos', {
      method: 'POST',
      url: '/compras',
      payload: {
        proveedorId: await conProveedor(),
        medioDePago: 'efectivo',
        lineas: [{ botellones: 20, cantidad: 20, costoUnitario: '18000.00' }],
      },
    })

    expect(res.statusCode).toBe(201)
  })

  it('una línea que compra dos cosas la frena el esquema, con 400', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/compras',
      payload: {
        proveedorId: await conProveedor(),
        medioDePago: 'efectivo',
        lineas: [{ botellones: 5, bases: 5, cantidad: 5, costoUnitario: '100.00' }],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json())).toContain('exactamente una cosa')
  })

  it('los kilos son solo para insumos', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/compras',
      payload: {
        proveedorId: await conProveedor(),
        medioDePago: 'efectivo',
        lineas: [{ botellones: 5, cantidad: 5, kilos: 3, costoUnitario: '100.00' }],
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it('a crédito sin fecha responde 422 y explica por qué', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/compras',
      payload: {
        proveedorId: await conProveedor(),
        medioDePago: 'credito',
        lineas: [{ botellones: 5, cantidad: 5, costoUnitario: '100.00' }],
      },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('VENCIMIENTO_REQUERIDO')
    expect(res.json().mensaje).toContain('La dice el proveedor')
  })

  it('las vencidas se consultan con los días de atraso', async () => {
    const ayer = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    await comoAdmin({
      method: 'POST',
      url: '/compras',
      payload: {
        proveedorId: await conProveedor(),
        medioDePago: 'credito',
        venceEl: ayer,
        lineas: [{ botellones: 5, cantidad: 5, costoUnitario: '100.00' }],
      },
    })

    const res = await comoAdmin({ method: 'GET', url: '/compras/vencidas' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].diasDeAtraso).toBe(3)
  })

  it('pagar dos veces se rechaza', async () => {
    const compra = (
      await comoAdmin({
        method: 'POST',
        url: '/compras',
        payload: {
          proveedorId: await conProveedor(),
          medioDePago: 'efectivo',
          lineas: [{ botellones: 5, cantidad: 5, costoUnitario: '100.00' }],
        },
      })
    ).json().compra

    const res = await comoAdmin({ method: 'POST', url: `/compras/${compra.id}/pago` })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('COMPRA_YA_PAGADA')
  })
})
