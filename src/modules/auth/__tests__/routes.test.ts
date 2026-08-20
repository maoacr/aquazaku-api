import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, sessions, users } from '@/db/schema'
import { resetDb } from '@/test/db'
import { PASSWORD_DE_PRUEBA, crearUsuario, usuarioAutenticado } from '@/test/fixtures'
import { ERROR_AUTH } from '@/modules/authz/middleware'

let app: FastifyInstance

const registros = () => db.select().from(auditLog).orderBy(desc(auditLog.id))

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('GET /auth/me', () => {
  it('sin sesión devuelve 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ERROR_AUTH.SIN_SESION)
  })

  it('devuelve el perfil completo en un solo viaje', async () => {
    const { usuario, cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: usuario.id,
      email: usuario.email,
      name: 'Usuario de prueba',
      roles: ['admin'],
      mustChangePassword: true,
    })
  })

  it('incluye los permisos resueltos para que el front no replique la matriz', async () => {
    const { cookie } = await usuarioAutenticado('contador')

    const permisos = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json()
      .permisos as string[]

    expect(permisos).toContain('auditoria:ver')
    expect(permisos).toContain('reportes:financieros')
    // El contador no escribe: nada de crear ventas.
    expect(permisos).not.toContain('ventas:crear')
  })

  it('multi-rol: los permisos son la unión de todos los roles', async () => {
    const solo = await usuarioAutenticado('seller')
    const multi = await usuarioAutenticado('seller', 'pos')

    const permisosSolo = (
      await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: solo.cookie } })
    ).json().permisos as string[]
    const permisosMulti = (
      await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: multi.cookie } })
    ).json().permisos as string[]

    expect(permisosSolo).not.toContain('stock:cargar_ruta')
    expect(permisosMulti).toContain('stock:cargar_ruta')
    for (const p of permisosSolo) expect(permisosMulti).toContain(p)
  })

  it('un usuario sin roles no tiene permisos, pero igual se identifica', async () => {
    const { cookie } = await usuarioAutenticado()

    const cuerpo = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json()

    expect(cuerpo.roles).toEqual([])
    expect(cuerpo.permisos).toEqual([])
    expect(cuerpo.id).toBeTruthy()
  })

  it('leer el perfil propio NO deja rastro en la bitácora', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    })
    const setCookie = login.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
    const cookie = (cookies.find((c) => c.startsWith('aquazaku_session=')) ?? '').split(';')[0] ?? ''

    const antes = (await registros()).length

    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })

    // Tres consultas de perfil, cero filas nuevas. Si cada /me auditara, la
    // bitácora se llenaría de ruido en cada carga de pantalla.
    expect(await registros()).toHaveLength(antes)
    expect(antes).toBe(1) // solo el login
  })
})

describe('POST /auth/sign-out', () => {
  it('sin sesión devuelve 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/sign-out' })
    expect(res.statusCode).toBe(401)
  })

  it('invalida la sesión: el siguiente request queda afuera', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const salida = await app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })
    expect(salida.statusCode).toBe(200)

    const despues = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(despues.statusCode).toBe(401)
  })

  it('borra la sesión de la base', async () => {
    const { cookie } = await usuarioAutenticado('admin')
    expect(await db.select().from(sessions)).toHaveLength(1)

    await app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })

    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('manda la cookie de borrado', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })

    const setCookie = res.headers['set-cookie']
    expect(setCookie).toBeDefined()
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
    expect(cookies.some((c) => c.startsWith('aquazaku_session='))).toBe(true)
  })

  it('deja rastro en la bitácora', async () => {
    const { usuario, cookie } = await usuarioAutenticado('pos', 'seller')

    await app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })

    const salida = (await registros()).find((r) => r.action === 'auth:sign-out')
    expect(salida).toMatchObject({
      userId: usuario.id,
      result: 'ok',
      rolEjercido: ['pos', 'seller'],
    })
  })
})

describe('auditoría de los intentos de login', () => {
  it('un login exitoso queda registrado con su usuario', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    })

    const entrada = (await registros()).find((r) => r.action === 'auth:sign-in')
    expect(entrada).toMatchObject({ userId: usuario.id, result: 'ok' })
  })

  it('un login FALLIDO también queda registrado — es la señal que más importa', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: 'contrasena-equivocada' },
    })

    const entrada = (await registros()).find((r) => r.action === 'auth:sign-in')
    expect(entrada).toMatchObject({ result: 'denied', userId: null })
  })

  it('guarda el email del intento, para poder reconstruir contra quién iba', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'objetivo@aquazaku.com', password: 'lo-que-sea-1234' },
    })

    const entrada = (await registros()).find((r) => r.action === 'auth:sign-in')
    expect(entrada?.payload).toEqual({ email: 'objetivo@aquazaku.com' })
  })

  it('NUNCA guarda la contraseña, ni siquiera la fallida', async () => {
    const password = 'contrasena-secretisima-999'

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'alguien@aquazaku.com', password },
    })

    const todo = JSON.stringify(await registros())
    expect(todo).not.toContain(password)
  })

  it('varios intentos fallidos dejan varios registros: así se ve una ráfaga', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'victima@aquazaku.com', password: `intento-${i}-abcd` },
      })
    }

    const intentos = (await registros()).filter((r) => r.action === 'auth:sign-in')
    expect(intentos).toHaveLength(3)
    expect(intentos.every((r) => r.result === 'denied')).toBe(true)
  })
})

describe('E2E: el ciclo completo de sesión', () => {
  it('entrar, identificarse y salir', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    // 1. Entrar
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    })
    expect(login.statusCode).toBe(200)

    const setCookie = login.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
    const cookie = (cookies.find((c) => c.startsWith('aquazaku_session=')) ?? '').split(';')[0] ?? ''
    expect(cookie).toBeTruthy()

    // 2. Identificarse
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().roles).toContain('pos')
    expect(me.json().permisos).toContain('stock:cargar_ruta')

    // 3. Salir
    const salida = await app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })
    expect(salida.statusCode).toBe(200)

    // 4. La misma cookie ya no sirve
    const despues = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(despues.statusCode).toBe(401)

    // 5. Y el ciclo entero quedó en la bitácora
    const acciones = (await registros()).map((r) => r.action)
    expect(acciones).toContain('auth:sign-in')
    expect(acciones).toContain('auth:sign-out')
  })

  it('desactivar a un usuario lo echa en el request siguiente (RN-ACC-05)', async () => {
    const { usuario, cookie } = await usuarioAutenticado('admin')

    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(200)

    await db.update(users).set({ status: 'inactive' }).where(eq(users.id, usuario.id))

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ERROR_AUTH.USUARIO_INACTIVO)
  })
})
