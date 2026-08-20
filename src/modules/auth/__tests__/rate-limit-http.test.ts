import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { resetDb } from '@/test/db'
import { PASSWORD_DE_PRUEBA, crearUsuario } from '@/test/fixtures'
import { vaciarBuzon } from '@/test/mailpit'
import { LIMITE_LOGIN, LIMITE_RESET, _reiniciarLimites } from '../rate-limit'

/**
 * El límite aplicado de verdad, por HTTP.
 *
 * El plan definía el limitador pero no lo conectaba a ningún endpoint: quedaba
 * como código muerto que daba la sensación de que el sistema estaba protegido.
 */

let app: FastifyInstance

const intentarLogin = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } })

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

describe('límite en el login', () => {
  it(`corta después de ${LIMITE_LOGIN.max} intentos`, async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    for (let i = 0; i < LIMITE_LOGIN.max; i++) {
      const res = await intentarLogin(usuario.email, 'contrasena-equivocada')
      expect(res.statusCode, `intento ${i + 1}`).not.toBe(429)
    }

    const bloqueado = await intentarLogin(usuario.email, 'contrasena-equivocada')
    expect(bloqueado.statusCode).toBe(429)
    expect(bloqueado.json().code).toBe('RATE_LIMITED')
  })

  it('bloquea también con la contraseña CORRECTA: si no, adivinarla libera el freno', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    for (let i = 0; i < LIMITE_LOGIN.max; i++) {
      await intentarLogin(usuario.email, 'contrasena-equivocada')
    }

    const res = await intentarLogin(usuario.email, PASSWORD_DE_PRUEBA)
    expect(res.statusCode).toBe(429)
  })

  it('devuelve retry-after para que el cliente sepa cuánto esperar', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })
    for (let i = 0; i <= LIMITE_LOGIN.max; i++) {
      await intentarLogin(usuario.email, 'mal')
    }

    const res = await intentarLogin(usuario.email, 'mal')

    expect(res.headers['retry-after']).toBeDefined()
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(res.json().reintentarEn).toBeGreaterThan(0)
  })

  it('otro email desde la misma IP no queda bloqueado', async () => {
    const bloqueado = await crearUsuario({ roles: ['pos'] })
    const otro = await crearUsuario({ roles: ['pos'] })

    for (let i = 0; i <= LIMITE_LOGIN.max; i++) {
      await intentarLogin(bloqueado.email, 'mal')
    }

    // Una oficina entera detrás del mismo NAT no puede quedar afuera por culpa
    // de una sola persona.
    const res = await intentarLogin(otro.email, PASSWORD_DE_PRUEBA)
    expect(res.statusCode).toBe(200)
  })

  it('entrar bien limpia el contador', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    for (let i = 0; i < LIMITE_LOGIN.max - 1; i++) {
      await intentarLogin(usuario.email, 'mal')
    }

    expect((await intentarLogin(usuario.email, PASSWORD_DE_PRUEBA)).statusCode).toBe(200)

    // Con el contador limpio vuelve a tener todos sus intentos.
    for (let i = 0; i < LIMITE_LOGIN.max; i++) {
      expect((await intentarLogin(usuario.email, 'mal')).statusCode).not.toBe(429)
    }
  })

  it('llegar al límite queda en la bitácora', async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })
    for (let i = 0; i <= LIMITE_LOGIN.max; i++) {
      await intentarLogin(usuario.email, 'mal')
    }

    const cortes = (await db.select().from(auditLog)).filter((r) => r.action === 'auth:rate-limit')

    // Una ráfaga que llega al tope es justamente lo que hay que poder ver.
    expect(cortes.length).toBeGreaterThan(0)
    expect(cortes[0]).toMatchObject({ result: 'denied', userId: null })
  })
})

describe('límite en la recuperación de contraseña', () => {
  const pedirReset = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email, redirectTo: 'http://localhost:3000/reset-password' },
    })

  it(`corta después de ${LIMITE_RESET.max} pedidos`, async () => {
    const usuario = await crearUsuario({ roles: ['pos'] })

    for (let i = 0; i < LIMITE_RESET.max; i++) {
      expect((await pedirReset(usuario.email)).statusCode, `pedido ${i + 1}`).not.toBe(429)
    }

    // Sin esto, cualquiera con el email de otra persona puede bombardearle la
    // casilla usando nuestro servidor.
    expect((await pedirReset(usuario.email)).statusCode).toBe(429)
  })

  it('es más estricto que el del login', () => {
    expect(LIMITE_RESET.max).toBeLessThan(LIMITE_LOGIN.max)
  })
})
