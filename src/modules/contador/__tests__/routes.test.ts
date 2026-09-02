import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { clientes, cobros } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let contador: { cookie: string }
let clienteId: string

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  contador = await usuarioAutenticado('contador')

  const [c] = await db
    .insert(clientes)
    .values({ nombre: 'Panadería del Centro', tipoDocumento: 'NIT', numeroDocumento: '900456789' })
    .returning()
  clienteId = c!.id
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const como = async (rol: Role, pedido: Omit<InjectOptions, 'headers'>) => {
  const usuario = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie: usuario.cookie } })
}

const comoContador = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: contador.cookie } })

const HOY = new Date().toISOString().slice(0, 10)

describe('el extracto', () => {
  it('el contador lo consulta con su rango', async () => {
    await db.insert(cobros).values({ clienteId, monto: '80000.00', medioDePago: 'efectivo' })

    const res = await comoContador({
      method: 'GET',
      url: `/reportes/extracto?desde=2026-01-01&hasta=${HOY}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().movimientos).toHaveLength(1)
    expect(res.json().totales.entradas).toBe('80000.00')
  })

  it('filtra por tipo, separados por coma', async () => {
    await db.insert(cobros).values({ clienteId, monto: '80000.00', medioDePago: 'efectivo' })

    const res = await comoContador({
      method: 'GET',
      url: `/reportes/extracto?desde=2026-01-01&hasta=${HOY}&tipos=compra`,
    })

    expect(res.json().movimientos).toHaveLength(0)
  })

  /*
   * Un tipo inventado no rompería nada —el filtro no lo encontraría— pero
   * devolvería un extracto vacío que se lee como «no hubo movimientos». Esa
   * respuesta plausible y falsa es lo que el esquema evita.
   */
  it('un tipo que no existe se rechaza, en vez de devolver vacío', async () => {
    const res = await comoContador({
      method: 'GET',
      url: `/reportes/extracto?desde=2026-01-01&hasta=${HOY}&tipos=inventado`,
    })

    expect(res.statusCode).toBe(400)
  })

  it('un rango al revés responde 422 y explica por qué', async () => {
    const res = await comoContador({
      method: 'GET',
      url: '/reportes/extracto?desde=2026-08-31&hasta=2026-08-01',
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().mensaje).toContain('al revés')
  })

  it('sin rango no hay extracto: el esquema lo frena', async () => {
    expect((await comoContador({ method: 'GET', url: '/reportes/extracto' })).statusCode).toBe(400)
  })
})

/**
 * ── El `pos` NO ve la plata del negocio ─────────────────────────────────────
 *
 * La matriz distingue `reportes:operativos` de `reportes:financieros` desde M0,
 * y esa distinción existe justamente para esto: quien atiende el mostrador
 * necesita datos de operación, no el total facturado del mes ni quién debe
 * cuánto.
 */
describe('quién puede mirar', () => {
  it('el `pos` no ve el extracto', async () => {
    const res = await como('pos', {
      method: 'GET',
      url: `/reportes/extracto?desde=2026-01-01&hasta=${HOY}`,
    })

    expect(res.statusCode).toBe(403)
  })

  it('ni la cartera', async () => {
    expect((await como('pos', { method: 'GET', url: '/reportes/cartera' })).statusCode).toBe(403)
  })

  it('el `seller` tampoco', async () => {
    expect((await como('seller', { method: 'GET', url: '/reportes/cartera' })).statusCode).toBe(403)
  })

  it('el `admin` sí: es el dueño del negocio', async () => {
    expect((await como('admin', { method: 'GET', url: '/reportes/cartera' })).statusCode).toBe(200)
  })
})

describe('la cartera', () => {
  it('sin deuda viene vacía, y eso no es un error', async () => {
    const res = await comoContador({ method: 'GET', url: '/reportes/cartera' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe('el resumen mensual', () => {
  it('devuelve una fila por mes del rango', async () => {
    const res = await comoContador({
      method: 'GET',
      url: '/reportes/mensual?desde=2026-06&hasta=2026-08',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((m: { mes: string }) => m.mes)).toEqual(['2026-06', '2026-07', '2026-08'])
  })

  /*
   * Una fecha completa daría un mes PARCIAL con pinta de mes entero, y esa
   * comparación falsa no la detecta nadie. El esquema la frena en la puerta.
   */
  it('una fecha completa se rechaza: el resumen va por meses', async () => {
    const res = await comoContador({
      method: 'GET',
      url: '/reportes/mensual?desde=2026-06-15&hasta=2026-08',
    })

    expect(res.statusCode).toBe(400)
  })

  it('un rango al revés responde 422', async () => {
    const res = await comoContador({
      method: 'GET',
      url: '/reportes/mensual?desde=2026-08&hasta=2026-06',
    })

    expect(res.statusCode).toBe(422)
  })

  it('el `pos` no lo ve: son montos del negocio', async () => {
    const res = await como('pos', {
      method: 'GET',
      url: '/reportes/mensual?desde=2026-06&hasta=2026-08',
    })

    expect(res.statusCode).toBe(403)
  })
})
