import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, lotes, productos } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let productoId: string

const HOY = new Date().toISOString().slice(0, 10)

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

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
  productoId = p!.id
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

async function comoRol(rol: Role, pedido: Omit<InjectOptions, 'headers'>) {
  const { cookie } = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie } })
}

async function cargar(cantidad = 100) {
  const res = await comoAdmin({
    method: 'POST',
    url: '/stock/entradas',
    payload: { productoId, cantidad, fechaEmpaque: HOY, motivo: 'carga inicial' },
  })
  return res.json() as { id: string; codigo: string }
}

describe('el saldo no se edita: esas rutas no existen — RN-STK-02', () => {
  it.each(['PUT', 'PATCH'] as const)('%s /stock/:id no es una ruta del sistema', async (method) => {
    const lote = await cargar()

    const res = await comoAdmin({ method, url: `/stock/${lote.id}`, payload: { cantidad: 999 } })

    expect(res.statusCode).toBe(404)
  })

  it('DELETE sobre un lote tampoco existe', async () => {
    const lote = await cargar()

    expect((await comoAdmin({ method: 'DELETE', url: `/stock/${lote.id}` })).statusCode).toBe(404)
  })
})

describe('quién puede tocar el stock', () => {
  it('sin sesión no se ve nada', async () => {
    expect((await app.inject({ method: 'GET', url: '/stock' })).statusCode).toBe(401)
  })

  it.each(['admin', 'seller', 'pos', 'contador'] as const)('%s puede ver el stock', async (rol) => {
    expect((await comoRol(rol, { method: 'GET', url: '/stock' })).statusCode).toBe(200)
  })

  it.each(['seller', 'contador'] as const)('%s NO puede ajustar', async (rol) => {
    const lote = await cargar()

    const res = await comoRol(rol, {
      method: 'POST',
      url: '/stock/ajustes',
      payload: { loteId: lote.id, cantidad: -5, motivo: 'no debería' },
    })

    expect(res.statusCode).toBe(403)
  })

  it.each(['seller', 'contador'] as const)('%s NO puede descartar', async (rol) => {
    const lote = await cargar()

    const res = await comoRol(rol, {
      method: 'POST',
      url: '/stock/descartes',
      payload: { loteId: lote.id, cantidad: 1, causa: 'vencido' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('el pos SÍ puede descartar: manipula el producto y ve el daño', async () => {
    const lote = await cargar()

    const res = await comoRol('pos', {
      method: 'POST',
      url: '/stock/descartes',
      payload: { loteId: lote.id, cantidad: 2, causa: 'falla_produccion' },
    })

    expect(res.statusCode).toBe(200)
  })

  it('un acceso denegado queda en la bitácora', async () => {
    await cargar()
    await comoRol('seller', {
      method: 'POST',
      url: '/stock/ajustes',
      payload: { loteId: '00000000-0000-0000-0000-000000000000', cantidad: 1, motivo: 'carga inicial de inventario' },
    })

    const [entrada] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.result, 'denied'))
      .orderBy(desc(auditLog.id))

    expect(entrada?.action).toBe('stock:ajustar')
  })
})

describe('entrada de inventario', () => {
  it('devuelve 201 con el lote, su código y su vencimiento', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/entradas',
      payload: { productoId, cantidad: 100, fechaEmpaque: '2026-08-22', motivo: 'carga inicial' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      codigo: '2026-08-22-L1',
      fechaVencimiento: '2026-09-21',
      cantidadDisponible: 100,
    })
  })

  it('sin motivo devuelve 400 diciendo qué campo falta', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/entradas',
      payload: { productoId, cantidad: 10, fechaEmpaque: HOY, motivo: '' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().detalle[0].campo).toBe('motivo')
  })

  it('una fecha mal formada no llega a la base', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/entradas',
      payload: { productoId, cantidad: 10, fechaEmpaque: '22/08/2026', motivo: 'carga inicial de inventario' },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('ajuste y descarte', () => {
  it('un ajuste negativo mayor al saldo devuelve 409 con el saldo real', async () => {
    const lote = await cargar(10)

    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/ajustes',
      payload: { loteId: lote.id, cantidad: -50, motivo: 'intento de descontar mas de lo que hay' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('STOCK_INSUFICIENTE')
    expect(res.json().mensaje).toContain('10')
  })

  it('un ajuste de cero se rechaza en la validación', async () => {
    const lote = await cargar()

    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/ajustes',
      payload: { loteId: lote.id, cantidad: 0, motivo: 'ajuste de prueba del schema' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('un descarte sin causa no pasa la validación', async () => {
    const lote = await cargar()

    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/descartes',
      payload: { loteId: lote.id, cantidad: 1 },
    })

    expect(res.statusCode).toBe(400)
  })

  it('un lote inexistente da 404, no 500', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/stock/ajustes',
      payload: {
        loteId: '00000000-0000-0000-0000-000000000000',
        cantidad: -1,
        motivo: 'carga inicial de inventario',
      },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('LOTE_NO_ENCONTRADO')
  })
})

describe('consultas', () => {
  it('un producto sin lotes aparece en cero, no desaparece del listado', async () => {
    const resumen = (await comoAdmin({ method: 'GET', url: '/stock' })).json()

    // Un producto que no figura se lee como "no existe", no como "no hay".
    expect(resumen).toHaveLength(1)
    expect(resumen[0]).toMatchObject({ codigo: 'P20U_600ML', total: 0, vendible: 0, vencido: 0 })
  })

  it('separa lo vendible de lo vencido en la misma respuesta', async () => {
    await cargar(40)
    // Un lote viejo, ya vencido, con producto que sigue en la bodega.
    await db.insert(lotes).values({
      productoId,
      codigo: '2020-01-01-L1',
      fechaEmpaque: '2020-01-01',
      fechaVencimiento: '2020-01-31',
      cantidadInicial: 7,
      cantidadDisponible: 7,
    })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/stock' })).json()

    expect(fila).toMatchObject({ total: 47, vendible: 40, vencido: 7 })
  })

  it('los lotes de un producto vienen del más próximo a vencer', async () => {
    await comoAdmin({
      method: 'POST',
      url: '/stock/entradas',
      payload: { productoId, cantidad: 10, fechaEmpaque: '2026-09-01', motivo: 'carga inicial de inventario' },
    })
    await comoAdmin({
      method: 'POST',
      url: '/stock/entradas',
      payload: { productoId, cantidad: 10, fechaEmpaque: '2026-08-01', motivo: 'carga inicial de inventario' },
    })

    const lotesDelProducto = (
      await comoAdmin({ method: 'GET', url: `/stock/${productoId}/lotes` })
    ).json()

    expect(lotesDelProducto[0].codigo).toBe('2026-08-01-L1')
  })

  it('el libro pagina por cursor y filtra por tipo', async () => {
    const lote = await cargar()
    await comoAdmin({
      method: 'POST',
      url: '/stock/descartes',
      payload: { loteId: lote.id, cantidad: 1, causa: 'vencido' },
    })

    const pagina = (
      await comoAdmin({ method: 'GET', url: '/stock/movimientos?tipo=descarte&limite=10' })
    ).json()

    expect(pagina.filas).toHaveLength(1)
    expect(pagina.filas[0].tipo).toBe('descarte')
    expect(pagina.siguienteCursor).toBeNull()
  })

  it('el límite tiene techo: no se puede pedir la tabla entera', async () => {
    const res = await comoAdmin({ method: 'GET', url: '/stock/movimientos?limite=99999' })

    expect(res.statusCode).toBe(400)
  })
})
