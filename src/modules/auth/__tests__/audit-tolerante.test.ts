import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { sessions } from '@/db/schema'
import { emit } from '@/modules/authz/audit'
import { resetDb } from '@/test/db'
import { PASSWORD_DE_PRUEBA, crearUsuario, usuarioAutenticado } from '@/test/fixtures'

/**
 * Entrar y salir se auditan, pero un fallo de la bitácora NO los bloquea.
 *
 * Es lo contrario de lo que hace `requirePermission`, y la diferencia no es de
 * criterio sino de regla: RN-ACC-04 enumera las acciones sensibles —anulaciones,
 * ajustes, bajas, préstamos, cambios de precio— y entrar o salir del sistema no
 * está entre ellas.
 *
 * Convertir una caída de la bitácora en imposibilidad de iniciar sesión
 * transformaría un problema de registro en una caída total del sistema.
 */
vi.mock('@/modules/authz/audit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/authz/audit')>()
  return { ...original, emit: vi.fn() }
})

let app: FastifyInstance

beforeEach(async () => {
  await resetDb()
  vi.mocked(emit).mockReset()
  vi.mocked(emit).mockRejectedValue(new Error('bitácora caída'))

  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('con la bitácora caída', () => {
  it('se puede iniciar sesión igual', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    })

    expect(res.statusCode).toBe(200)
    expect(await db.select().from(sessions)).toHaveLength(1)
  })

  it('se puede cerrar sesión igual, y la sesión se invalida de verdad', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    // Lo que no puede pasar bajo ningún concepto: que el fallo de auditoría
    // deje la sesión viva y el usuario crea que salió.
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('un login fallido sigue siendo rechazado', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: 'contrasena-equivocada' },
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('se intentó auditar: el fallo no es que nadie lo llamó', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    })

    expect(emit).toHaveBeenCalled()
  })
})
