import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }

const PACA = {
  nombre: 'Paca de 20 bolsas de 600 ml',
  presentacion: 'paca',
  contenidoMl: 600,
  unidades: 20,
  precioResidencial: '12000.00',
  precioComercial: '11000.00',
  precioMinimo: '9000.00',
}

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')
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

async function crearPaca() {
  const res = await comoAdmin({ method: 'POST', url: '/productos', payload: PACA })
  return res.json() as { id: string; codigo: string }
}

describe('quién puede tocar el catálogo — RN-CAT-06', () => {
  it('sin sesión no se ve nada', async () => {
    expect((await app.inject({ method: 'GET', url: '/productos' })).statusCode).toBe(401)
  })

  it.each(['admin', 'seller', 'pos', 'contador'] as const)(
    '%s puede leer el catálogo: un pos que no ve precios no puede vender',
    async (rol) => {
      const res = await comoRol(rol, { method: 'GET', url: '/productos' })

      expect(res.statusCode).toBe(200)
    },
  )

  it.each(['seller', 'pos', 'contador'] as const)('%s NO puede crear productos', async (rol) => {
    const res = await comoRol(rol, { method: 'POST', url: '/productos', payload: PACA })

    expect(res.statusCode).toBe(403)
  })

  it.each(['seller', 'pos', 'contador'] as const)(
    '%s NO puede editar precios — es la variable más sensible del negocio',
    async (rol) => {
      const { id } = await crearPaca()

      const res = await comoRol(rol, {
        method: 'PATCH',
        url: `/productos/${id}/precios`,
        payload: { precioResidencial: '1.00', precioComercial: '1.00', precioMinimo: '1.00' },
      })

      expect(res.statusCode).toBe(403)
    },
  )

  it('pos NO puede desactivar un producto', async () => {
    const { id } = await crearPaca()

    const res = await comoRol('pos', { method: 'POST', url: `/productos/${id}/desactivar` })

    expect(res.statusCode).toBe(403)
  })

  it('un acceso denegado queda en la bitácora — RN-ACC-04', async () => {
    await comoRol('pos', { method: 'POST', url: '/productos', payload: PACA })

    const [entrada] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.result, 'denied'))
      .orderBy(desc(auditLog.id))

    expect(entrada?.action).toBe('productos:crear')
  })
})

describe('no existe forma de borrar un producto — RN-CAT-02', () => {
  it('DELETE /productos/:id no es una ruta del sistema', async () => {
    const { id } = await crearPaca()

    const res = await comoAdmin({ method: 'DELETE', url: `/productos/${id}` })

    expect(res.statusCode).toBe(404)
  })
})

describe('crear', () => {
  it('devuelve 201 con el código generado y los litros calculados', async () => {
    const res = await comoAdmin({ method: 'POST', url: '/productos', payload: PACA })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ codigo: 'P20U_600ML', activo: true })
    expect(Number(res.json().litros)).toBe(12)
  })

  it('deja el alta en la bitácora con su código', async () => {
    await crearPaca()

    const [entrada] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'productos:crear'))
      .orderBy(desc(auditLog.id))

    expect((entrada?.payload as { codigo: string }).codigo).toBe('P20U_600ML')
  })

  it('un piso por encima del precio de lista da 422 con mensaje legible', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/productos',
      payload: { ...PACA, precioMinimo: '99000.00' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('PRECIO_MINIMO_INVALIDO')
    expect(res.json().mensaje).toContain('precio mínimo')
  })

  it('un precio que no es un monto da 400 diciendo qué campo está mal', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/productos',
      payload: { ...PACA, precioResidencial: 'doce mil' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
    expect(res.json().detalle[0].campo).toBe('precioResidencial')
  })

  it('cero unidades no llega ni a la base', async () => {
    const res = await comoAdmin({ method: 'POST', url: '/productos', payload: { ...PACA, unidades: 0 } })

    expect(res.statusCode).toBe(400)
  })
})

describe('editar precios', () => {
  it('guarda el antes y el después en la bitácora', async () => {
    const { id } = await crearPaca()

    const res = await comoAdmin({
      method: 'PATCH',
      url: `/productos/${id}/precios`,
      payload: { precioResidencial: '13000.00', precioComercial: '12000.00', precioMinimo: '9000.00' },
    })

    expect(res.statusCode).toBe(200)

    const [entrada] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'productos:editar_precios'))
      .orderBy(desc(auditLog.id))

    const payload = entrada?.payload as { antes: Record<string, string>; despues: Record<string, string> }
    expect(payload.antes.residencial).toBe('12000.00')
    expect(payload.despues.residencial).toBe('13000.00')
  })

  it('el PATCH general no puede cambiar precios — si pudiera, la matriz no significaría nada', async () => {
    const { id } = await crearPaca()

    await comoAdmin({
      method: 'PATCH',
      url: `/productos/${id}`,
      payload: { nombre: 'Otro nombre', precioResidencial: '1.00' },
    })

    const producto = (await comoAdmin({ method: 'GET', url: `/productos/${id}` })).json()
    expect(producto.nombre).toBe('Otro nombre')
    expect(producto.precioResidencial).toBe('12000.00')
  })

  it('los tres precios son obligatorios: mandar uno solo da 400', async () => {
    const { id } = await crearPaca()

    const res = await comoAdmin({
      method: 'PATCH',
      url: `/productos/${id}/precios`,
      payload: { precioResidencial: '13000.00' },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('desactivar y reactivar', () => {
  it('el producto sale del listado por defecto y sigue existiendo', async () => {
    const { id } = await crearPaca()

    await comoAdmin({ method: 'POST', url: `/productos/${id}/desactivar` })

    expect((await comoAdmin({ method: 'GET', url: '/productos' })).json()).toHaveLength(0)
    expect((await comoAdmin({ method: 'GET', url: '/productos?estado=todos' })).json()).toHaveLength(1)
    expect((await comoAdmin({ method: 'GET', url: `/productos/${id}` })).statusCode).toBe(200)
  })

  it('desactivar dos veces avisa en vez de fallar en silencio', async () => {
    const { id } = await crearPaca()
    await comoAdmin({ method: 'POST', url: `/productos/${id}/desactivar` })

    const res = await comoAdmin({ method: 'POST', url: `/productos/${id}/desactivar` })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('PRODUCTO_YA_INACTIVO')
  })

  it('reactivar lo devuelve al listado', async () => {
    const { id } = await crearPaca()
    await comoAdmin({ method: 'POST', url: `/productos/${id}/desactivar` })

    await comoAdmin({ method: 'POST', url: `/productos/${id}/reactivar` })

    expect((await comoAdmin({ method: 'GET', url: '/productos' })).json()).toHaveLength(1)
  })
})

describe('listar y buscar', () => {
  it('un id que no existe da 404, no 500', async () => {
    const res = await comoAdmin({
      method: 'GET',
      url: '/productos/00000000-0000-0000-0000-000000000000',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PRODUCTO_NO_ENCONTRADO')
  })

  it('un estado inválido en la query da 400', async () => {
    const res = await comoAdmin({ method: 'GET', url: '/productos?estado=cualquiera' })

    expect(res.statusCode).toBe(400)
  })
})
