import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, users } from '@/db/schema'
import { _reiniciarLimites } from '@/modules/auth/rate-limit'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { crearUsuario, usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string; email: string }; cookie: string }

beforeEach(async () => {
  await resetDb()
  _reiniciarLimites()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const consultar = (query = '', cookie = admin.cookie) =>
  app.inject({ method: 'GET', url: `/audit${query}`, headers: { cookie } } as InjectOptions)

interface Pagina {
  filas: Array<{
    id: number
    userId: string | null
    userName: string | null
    action: string
    resource: string | null
    result: string
    payload: unknown
  }>
  siguienteCursor: number | null
}

/** Inserta registros sintéticos para probar filtros y paginación. */
async function sembrarRegistros(cantidad: number, base: Record<string, unknown> = {}) {
  await db.insert(auditLog).values(
    Array.from({ length: cantidad }, (_, i) => ({
      action: `ventas:accion-${i}`,
      result: 'ok' as const,
      ...base,
    })),
  )
}

describe('quién puede consultar la bitácora', () => {
  it('sin sesión: 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/audit' })).statusCode).toBe(401)
  })

  it('el contador SÍ puede: es el testigo externo del sistema', async () => {
    const { cookie } = await usuarioAutenticado('contador')

    expect((await consultar('', cookie)).statusCode).toBe(200)
  })

  const sinPermiso: Role[] = ['seller', 'pos']

  for (const rol of sinPermiso) {
    it(`${rol} no puede: 403`, async () => {
      const { cookie } = await usuarioAutenticado(rol)

      expect((await consultar('', cookie)).statusCode).toBe(403)
    })
  }

  it('consultar la bitácora QUEDA en la bitácora', async () => {
    await consultar()

    const filas = await db.select().from(auditLog).where(eq(auditLog.action, 'auditoria:ver'))
    // Sin esto, el único control del sistema no tendría control sobre sí mismo.
    expect(filas.length).toBeGreaterThan(0)
  })
})

describe('contenido de la respuesta', () => {
  it('trae el NOMBRE del usuario, no solo su id', async () => {
    await consultar()

    const pagina = (await consultar()).json() as Pagina
    const propia = pagina.filas.find((f) => f.userId === admin.usuario.id)

    // Una pantalla de auditoría que muestra UUIDs no sirve para investigar nada.
    expect(propia?.userName).toBe('Usuario de prueba')
  })

  it('los registros SOBREVIVEN al borrado del usuario que los generó', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })
    await db.insert(auditLog).values({
      userId: otro.id,
      action: 'ventas:anular',
      result: 'ok',
    })

    await db.delete(users).where(eq(users.id, otro.id))

    const pagina = (await consultar('?action=ventas:anular')).json() as Pagina
    // `audit_log` no tiene FK a `users` justamente para esto. Con un INNER JOIN
    // el historial habría desaparecido de la consulta.
    expect(pagina.filas).toHaveLength(1)
    expect(pagina.filas[0]?.userName).toBeNull()
    expect(pagina.filas[0]?.userId).toBe(otro.id)
  })

  it('viene de lo más reciente hacia atrás', async () => {
    await sembrarRegistros(5)

    const ids = ((await consultar()).json() as Pagina).filas.map((f) => f.id)

    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })
})

describe('filtros', () => {
  it('por acción', async () => {
    await db.insert(auditLog).values([
      { action: 'ventas:anular', result: 'ok' },
      { action: 'stock:ajustar', result: 'ok' },
    ])

    const pagina = (await consultar('?action=ventas:anular')).json() as Pagina

    expect(pagina.filas.every((f) => f.action === 'ventas:anular')).toBe(true)
    expect(pagina.filas.length).toBeGreaterThan(0)
  })

  it('por recurso — es el "módulo" que pide el doc de dominio', async () => {
    await db.insert(auditLog).values([
      { action: 'ventas:anular', resource: 'ventas', result: 'ok' },
      { action: 'stock:ajustar', resource: 'stock', result: 'ok' },
    ])

    const pagina = (await consultar('?resource=stock')).json() as Pagina

    expect(pagina.filas.every((f) => f.resource === 'stock')).toBe(true)
  })

  it('por usuario', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })
    await db.insert(auditLog).values({ userId: otro.id, action: 'ventas:crear', result: 'ok' })

    const pagina = (await consultar(`?userId=${otro.id}`)).json() as Pagina

    expect(pagina.filas.every((f) => f.userId === otro.id)).toBe(true)
    expect(pagina.filas.length).toBe(1)
  })

  it('por resultado: ver todos los DENEGADOS es la consulta de seguridad más útil', async () => {
    await db.insert(auditLog).values([
      { action: 'ventas:anular', result: 'denied' },
      { action: 'ventas:crear', result: 'ok' },
    ])

    const pagina = (await consultar('?result=denied')).json() as Pagina

    expect(pagina.filas.every((f) => f.result === 'denied')).toBe(true)
  })

  it('por rango de fechas', async () => {
    await sembrarRegistros(3)

    const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

    expect(((await consultar(`?desde=${ayer}`)).json() as Pagina).filas.length).toBeGreaterThan(0)
    expect(((await consultar(`?desde=${manana}`)).json() as Pagina).filas).toHaveLength(0)
  })

  it('acepta una fecha simple, sin obligar a armar un timestamp', async () => {
    await sembrarRegistros(1)

    expect((await consultar('?desde=2020-01-01')).statusCode).toBe(200)
  })

  it('los filtros se combinan', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })
    await db.insert(auditLog).values([
      { userId: otro.id, action: 'ventas:anular', resource: 'ventas', result: 'denied' },
      { userId: otro.id, action: 'ventas:anular', resource: 'ventas', result: 'ok' },
      { userId: admin.usuario.id, action: 'ventas:anular', resource: 'ventas', result: 'denied' },
    ])

    const pagina = (await consultar(
      `?userId=${otro.id}&action=ventas:anular&result=denied`,
    )).json() as Pagina

    expect(pagina.filas).toHaveLength(1)
  })
})

describe('validación de los filtros', () => {
  it('un userId que no es UUID: 400, no 500', async () => {
    const res = await consultar('?userId=no-es-uuid')

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })

  it('una fecha inválida: 400', async () => {
    expect((await consultar('?desde=no-es-fecha')).statusCode).toBe(400)
  })

  it('un resultado que no existe: 400', async () => {
    expect((await consultar('?result=quizas')).statusCode).toBe(400)
  })

  it('un límite por encima del tope: 400', async () => {
    // El tope evita que alguien pida el log entero de un saque.
    expect((await consultar('?limite=99999')).statusCode).toBe(400)
  })

  it('un rango de fechas al revés: 400 con un mensaje claro', async () => {
    const res = await consultar('?desde=2026-12-31&hasta=2026-01-01')

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('RANGO_INVALIDO')
  })
})

describe('paginación por cursor', () => {
  it('respeta el límite pedido', async () => {
    await sembrarRegistros(10)

    const pagina = (await consultar('?limite=4')).json() as Pagina

    expect(pagina.filas).toHaveLength(4)
  })

  it('el cursor trae la página siguiente, sin repetir ni saltear', async () => {
    await sembrarRegistros(10)

    const primera = (await consultar('?limite=4')).json() as Pagina
    const segunda = (await consultar(`?limite=4&cursor=${primera.siguienteCursor}`)).json() as Pagina

    const idsPrimera = primera.filas.map((f) => f.id)
    const idsSegunda = segunda.filas.map((f) => f.id)

    expect(idsSegunda).toHaveLength(4)
    expect(idsPrimera.some((id) => idsSegunda.includes(id))).toBe(false)
    expect(Math.max(...idsSegunda)).toBeLessThan(Math.min(...idsPrimera))
  })

  it('la ÚLTIMA página devuelve cursor null', async () => {
    await sembrarRegistros(3)

    // Con menos filas que el límite, no hay página siguiente.
    const pagina = (await consultar('?limite=50')).json() as Pagina

    expect(pagina.siguienteCursor).toBeNull()
  })

  it('una página que viene justa NO promete una siguiente vacía', async () => {
    // Exactamente tantas filas como el límite. La primera versión del plan
    // devolvía cursor igual, la UI mostraba "cargar más" y traía cero filas.
    await sembrarRegistros(4, { resource: 'justa' })

    const primera = (await consultar('?limite=4&resource=justa')).json() as Pagina

    expect(primera.filas).toHaveLength(4)
    // No hay nada más: el cursor tiene que venir nulo aunque la página esté
    // llena. Se resuelve pidiendo una fila de más de la que se devuelve.
    expect(primera.siguienteCursor).toBeNull()
  })

  it('recorrer todas las páginas devuelve cada registro UNA sola vez', async () => {
    await sembrarRegistros(23, { resource: 'recorrido' })

    const vistos: number[] = []
    let cursor: number | null = null

    for (let i = 0; i < 20; i++) {
      const query = `?limite=5&resource=recorrido${cursor !== null ? `&cursor=${cursor}` : ''}`
      const pagina = (await consultar(query)).json() as Pagina

      vistos.push(...pagina.filas.map((f) => f.id))
      cursor = pagina.siguienteCursor
      if (cursor === null) break
    }

    expect(vistos).toHaveLength(23)
    expect(new Set(vistos).size).toBe(23)
  })

  it('insertar registros nuevos mientras se pagina no descoloca las páginas', async () => {
    await sembrarRegistros(8, { resource: 'estable' })

    const primera = (await consultar('?limite=4&resource=estable')).json() as Pagina
    expect(primera.siguienteCursor).not.toBeNull()

    // Con paginación por offset, estas filas nuevas correrían todo un lugar y
    // harían que un registro aparezca dos veces o se saltee.
    await db.insert(auditLog).values(
      Array.from({ length: 5 }, () => ({
        action: 'intruso:nuevo',
        resource: 'estable',
        result: 'ok' as const,
      })),
    )

    const segunda = (await consultar(
      `?limite=4&resource=estable&cursor=${primera.siguienteCursor}`,
    )).json() as Pagina

    expect(segunda.filas.every((f) => f.action !== 'intruso:nuevo')).toBe(true)
    expect(primera.filas.map((f) => f.id).some((id) => segunda.filas.some((f) => f.id === id))).toBe(
      false,
    )
  })
})

describe('E2E: la acción ocurre, queda registrada y se puede encontrar', () => {
  it('crear un usuario aparece en la bitácora con su detalle', async () => {
    const alta = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: admin.cookie },
      payload: {
        email: 'auditado@aquazaku.com',
        name: 'Auditado',
        password: 'contrasena-inicial-123',
        roles: ['pos'],
      },
    })
    expect(alta.statusCode).toBe(201)

    const pagina = (await consultar('?action=usuarios:crear')).json() as Pagina

    expect(pagina.filas).toHaveLength(1)
    expect(pagina.filas[0]).toMatchObject({
      action: 'usuarios:crear',
      resource: 'usuarios',
      result: 'ok',
      userName: 'Usuario de prueba',
    })
    expect(pagina.filas[0]?.payload).toMatchObject({ email: 'auditado@aquazaku.com' })
  })

  it('un intento sin permiso se puede encontrar filtrando por denegados', async () => {
    const { cookie } = await usuarioAutenticado('seller')

    await app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie },
    })

    const pagina = (await consultar('?result=denied&action=usuarios:ver')).json() as Pagina

    expect(pagina.filas.length).toBeGreaterThan(0)
    expect(pagina.filas[0]?.result).toBe('denied')
  })
})
