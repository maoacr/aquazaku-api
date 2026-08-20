import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { accounts, sessions, userRoles, users } from '@/db/schema'
import { resetDb } from '@/test/db'
import { sembrarRoles } from '@/test/fixtures'
import { COOKIE_SESION, requireAuth } from '@/modules/authz/middleware'

/**
 * Integración de Better-Auth sobre nuestro schema.
 *
 * El plan verificaba esta task con un `curl` a mano. El problema es que la
 * mitad de lo que puede salir mal acá es invisible desde afuera: que el id no
 * sea un UUID, que la contraseña no quede en argon2id, que la sesión no traiga
 * los roles, o que la cookie tenga otro nombre del que espera el middleware.
 * Nada de eso se ve en un 200.
 */

const CREDENCIALES = {
  name: 'Mao Prueba',
  email: 'mao@aquazaku.com',
  password: 'contrasena-segura-123',
}

let app: FastifyInstance

async function registrar(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: CREDENCIALES,
  })

  expect(res.statusCode, `sign-up falló: ${res.body}`).toBeLessThan(300)

  const [usuario] = await db.select().from(users).where(eq(users.email, CREDENCIALES.email))
  if (!usuario) throw new Error('el sign-up no creó el usuario')

  return usuario.id
}

async function iniciarSesion(): Promise<{ cookie: string; res: Awaited<ReturnType<typeof app.inject>> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: CREDENCIALES.email, password: CREDENCIALES.password },
  })

  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  const sesion = cookies.find((c) => c.startsWith(`${COOKIE_SESION}=`)) ?? ''

  return { cookie: sesion.split(';')[0] ?? '', res }
}

beforeEach(async () => {
  await resetDb()
  await sembrarRoles()

  app = await buildApp()
  app.get('/protegido', { preHandler: requireAuth }, async (req) => ({
    userId: req.user?.id,
    roles: req.user?.roles,
  }))
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('montaje de Better-Auth', () => {
  it('responde en /api/auth/*', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'noexiste@aquazaku.com', password: 'loquesea1234' },
    })

    // Lo que importa es que el endpoint exista y conteste, no que autentique.
    expect(res.statusCode).not.toBe(404)
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('sign-up sobre nuestro schema', () => {
  it('crea el usuario con un id UUID, no con el formato propio de Better-Auth', async () => {
    const id = await registrar()

    // Sin `generateId: "uuid"` esto explotaría al insertar contra una columna
    // uuid. Es la trampa que dejamos anotada en la Task 2.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('guarda la contraseña en accounts, no en users', async () => {
    const id = await registrar()

    const [cuenta] = await db.select().from(accounts).where(eq(accounts.userId, id))

    expect(cuenta?.password).toBeTruthy()
    expect(cuenta?.providerId).toBe('credential')
  })

  it('la contraseña queda hasheada con argon2id', async () => {
    const id = await registrar()

    const [cuenta] = await db.select().from(accounts).where(eq(accounts.userId, id))

    // El prefijo del formato PHC. Si acá dijera "$scrypt$" sería el default de
    // Better-Auth y no lo que pide el spec §5.
    expect(cuenta?.password).toMatch(/^\$argon2id\$/)
    expect(cuenta?.password).not.toContain(CREDENCIALES.password)
  })

  it('aplica nuestros defaults: activo y obligado a cambiar la contraseña', async () => {
    const id = await registrar()

    const [usuario] = await db.select().from(users).where(eq(users.id, id))

    expect(usuario?.status).toBe('active')
    expect(usuario?.mustChangePassword).toBe(true)
  })

  it('no inicia sesión al registrarse: las cuentas las crea un admin', async () => {
    await registrar()

    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('rechaza contraseñas de menos de 8 caracteres', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { ...CREDENCIALES, password: 'corta' },
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('sign-in', () => {
  it('devuelve la cookie con el nombre que espera el middleware', async () => {
    await registrar()
    const { cookie } = await iniciarSesion()

    // Si Better-Auth nombrara la cookie con su prefijo por defecto, el login
    // andaría y el middleware jamás encontraría la sesión.
    expect(cookie).toMatch(new RegExp(`^${COOKIE_SESION}=`))
  })

  it('la cookie es httpOnly: nada de tokens accesibles desde JS', async () => {
    await registrar()
    const { res } = await iniciarSesion()

    const setCookie = res.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
    const sesion = cookies.find((c) => c.startsWith(`${COOKIE_SESION}=`)) ?? ''

    expect(sesion.toLowerCase()).toContain('httponly')
    expect(sesion.toLowerCase()).toContain('samesite=lax')
  })

  it('con la contraseña equivocada no entrega sesión', async () => {
    await registrar()

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: CREDENCIALES.email, password: 'contrasena-equivocada' },
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('crea la sesión en la base', async () => {
    await registrar()
    await iniciarSesion()

    expect(await db.select().from(sessions)).toHaveLength(1)
  })
})

describe('los roles viajan congelados en la sesión (RN-ACC-01)', () => {
  it('sin roles asignados, la sesión nace con la lista vacía', async () => {
    await registrar()
    await iniciarSesion()

    const [sesion] = await db.select().from(sessions)
    expect(sesion?.roles).toEqual([])
  })

  it('congela TODOS los roles del usuario, no uno solo', async () => {
    const id = await registrar()
    await db.insert(userRoles).values([
      { userId: id, roleName: 'pos' },
      { userId: id, roleName: 'seller' },
    ])

    await iniciarSesion()

    const [sesion] = await db.select().from(sessions)
    expect([...(sesion?.roles ?? [])].sort()).toEqual(['pos', 'seller'])
  })

  it('los roles se congelan al login: cambiarlos después no toca la sesión abierta', async () => {
    const id = await registrar()
    await db.insert(userRoles).values({ userId: id, roleName: 'pos' })
    await iniciarSesion()

    await db.insert(userRoles).values({ userId: id, roleName: 'admin' })

    const [sesion] = await db.select().from(sessions)
    expect(sesion?.roles).toEqual(['pos'])
    // Consecuencia a resolver en Task 8: al cambiarle los roles a alguien hay
    // que invalidarle las sesiones, o sigue operando con los viejos.
  })
})

describe('la cookie de Better-Auth funciona con nuestro middleware', () => {
  it('un usuario logueado pasa requireAuth con sus roles', async () => {
    const id = await registrar()
    await db.insert(userRoles).values({ userId: id, roleName: 'admin' })

    const { cookie } = await iniciarSesion()
    const res = await app.inject({ method: 'GET', url: '/protegido', headers: { cookie } })

    // Este es el test que importa de toda la task: las dos mitades del sistema
    // —la identidad de Better-Auth y la autorización nuestra— hablando entre sí.
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe(id)
    expect(res.json().roles).toEqual(['admin'])
  })

  it('sin la cookie, el mismo endpoint devuelve 401', async () => {
    await registrar()

    const res = await app.inject({ method: 'GET', url: '/protegido' })
    expect(res.statusCode).toBe(401)
  })
})
