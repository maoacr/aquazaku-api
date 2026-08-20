import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, sessions, users } from '@/db/schema'
import { resetDb } from '@/test/db'
import { PASSWORD_DE_PRUEBA, crearUsuario, usuarioAutenticado } from '@/test/fixtures'
import { esperarCorreoPara, exigirMailpit, mensajes, vaciarBuzon } from '@/test/mailpit'
import { _reiniciarLimites } from '../rate-limit'

let app: FastifyInstance

const NUEVA_PASSWORD = 'contrasena-nueva-999'

/** Extrae el link de reset del correo que llegó a Mailpit. */
async function tokenDelCorreo(email: string): Promise<string> {
  const correo = await esperarCorreoPara(email)
  const url = /https?:\/\/[^\s"<]+/.exec(correo.Text)?.[0]
  if (!url) throw new Error(`el correo a ${email} no traía ningún link`)

  const token = new URL(url).searchParams.get('token')
  if (!token) throw new Error(`el link del correo no traía token: ${url}`)

  return token
}

beforeAll(async () => {
  await exigirMailpit()
})

beforeEach(async () => {
  await resetDb()
  await vaciarBuzon()
  _reiniciarLimites()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('pedido de recuperación', () => {
  it('manda el correo con el link', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: usuario.email, redirectTo: 'http://localhost:3000/reset-password' },
    })

    expect(res.statusCode).toBe(200)
    const correo = await esperarCorreoPara(usuario.email)
    expect(correo.Subject).toContain('Restablecer tu contraseña')
  })

  it('con un email que no existe responde igual y NO manda correo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: 'nadie@aquazaku.com', redirectTo: 'http://localhost:3000/reset-password' },
    })

    // Misma respuesta que con un email real: si difiriera, cualquiera podría
    // averiguar qué direcciones tienen cuenta en el sistema.
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 300))
    expect(await mensajes()).toHaveLength(0)
  })
})

describe('flujo completo de recuperación', () => {
  it('pedir, recibir el correo, cambiar la contraseña y entrar con la nueva', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    await app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: usuario.email, redirectTo: 'http://localhost:3000/reset-password' },
    })

    const token = await tokenDelCorreo(usuario.email)

    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: NUEVA_PASSWORD },
    })
    expect(reset.statusCode).toBe(200)

    // La vieja ya no sirve
    const conVieja = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    })
    expect(conVieja.statusCode).toBeGreaterThanOrEqual(400)

    // La nueva sí
    const conNueva = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: NUEVA_PASSWORD },
    })
    expect(conNueva.statusCode).toBe(200)
  })

  it('el token es de un solo uso', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })
    await app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: usuario.email, redirectTo: 'http://localhost:3000/reset-password' },
    })
    const token = await tokenDelCorreo(usuario.email)

    await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: NUEVA_PASSWORD },
    })

    const segundo = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'otra-contrasena-888' },
    })
    expect(segundo.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('un token inventado no sirve', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: 'token-inventado', newPassword: NUEVA_PASSWORD },
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('cambiar la contraseña CIERRA todas las sesiones abiertas', async () => {
    const { usuario, cookie } = await usuarioAutenticado('admin')
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(200)

    await app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: usuario.email, redirectTo: 'http://localhost:3000/reset-password' },
    })
    const token = await tokenDelCorreo(usuario.email)
    await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: NUEVA_PASSWORD },
    })

    // Lo más importante de todo el flujo: si alguien te robó la sesión y vos
    // recuperás la cuenta, el atacante tiene que quedar afuera.
    expect(await db.select().from(sessions)).toHaveLength(0)
    const despues = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(despues.statusCode).toBe(401)
  })

  it('limpia mustChangePassword: el usuario ya eligió una propia', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })
    await app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: usuario.email, redirectTo: 'http://localhost:3000/reset-password' },
    })
    const token = await tokenDelCorreo(usuario.email)

    await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: NUEVA_PASSWORD },
    })

    const [fila] = await db.select().from(users).where(eq(users.id, usuario.id))
    expect(fila?.mustChangePassword).toBe(false)
  })
})

describe('POST /auth/change-password', () => {
  it('sin sesión devuelve 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { currentPassword: PASSWORD_DE_PRUEBA, newPassword: NUEVA_PASSWORD },
    })

    expect(res.statusCode).toBe(401)
  })

  it('cambia la contraseña y permite entrar con la nueva', async () => {
    const { usuario, cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD_DE_PRUEBA, newPassword: NUEVA_PASSWORD },
    })
    expect(res.statusCode).toBe(200)

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: NUEVA_PASSWORD },
    })
    expect(login.statusCode).toBe(200)
  })

  it('EXIGE la contraseña actual', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'la-que-no-es', newPassword: NUEVA_PASSWORD },
    })

    // Sin este requisito, quien se apodere de una sesión deja al dueño afuera
    // de su cuenta para siempre.
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_CREDENTIALS')
  })

  it('rechaza contraseñas de menos de 8 caracteres con 400, no con 500', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD_DE_PRUEBA, newPassword: 'corta' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })

  it('limpia mustChangePassword — es el flujo del primer login (spec §7.2)', async () => {
    const { usuario, cookie } = await usuarioAutenticado('pos')

    await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD_DE_PRUEBA, newPassword: NUEVA_PASSWORD },
    })

    const [fila] = await db.select().from(users).where(eq(users.id, usuario.id))
    expect(fila?.mustChangePassword).toBe(false)
  })

  it('deja rastro en la bitácora, y también los intentos fallidos', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'la-que-no-es', newPassword: NUEVA_PASSWORD },
    })
    await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD_DE_PRUEBA, newPassword: NUEVA_PASSWORD },
    })

    const cambios = (await db.select().from(auditLog)).filter(
      (r) => r.action === 'auth:change-password',
    )
    expect(cambios.map((c) => c.result).sort()).toEqual(['denied', 'ok'])
  })
})
