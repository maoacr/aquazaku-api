import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'
import { emit } from '../audit'
import { ERROR_AUTH, requireAuth, requirePermission } from '../middleware'

/**
 * Qué pasa cuando NO se puede escribir en la bitácora.
 *
 * Los dos casos se tratan distinto a propósito:
 *
 *   · Denegado  → 403 igual. El usuario queda bloqueado, que es lo que protege
 *     al sistema. La falla se loguea como error.
 *   · Permitido → 500, y la acción NO se ejecuta. RN-ACC-04 exige que las
 *     acciones sensibles queden auditadas; dejar pasar una sin rastro sería
 *     incumplir la regla en silencio.
 *
 * Preferimos un endpoint caído a una acción sensible sin registro. Sin este
 * test, esa decisión sería un comentario, no un comportamiento.
 */
vi.mock('../audit', async (importOriginal) => {
  const original = await importOriginal<typeof import('../audit')>()
  return { ...original, emit: vi.fn() }
})

let app: FastifyInstance

beforeEach(async () => {
  await resetDb()
  vi.mocked(emit).mockReset()

  app = await buildApp()

  app.post(
    '/ventas/anular',
    { preHandler: [requireAuth, requirePermission('ventas', 'anular')] },
    async () => ({ ok: true, ejecutado: true }),
  )

  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('cuando la bitácora no está disponible', () => {
  describe('en un acceso DENEGADO', () => {
    beforeEach(() => {
      vi.mocked(emit).mockRejectedValue(new Error('base caída'))
    })

    it('igual responde 403: el usuario queda bloqueado', async () => {
      const { cookie } = await usuarioAutenticado('contador')

      const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe(ERROR_AUTH.SIN_PERMISO)
    })

    it('no deja que la falla de auditoría se coma la denegación', async () => {
      const { cookie } = await usuarioAutenticado('contador')

      const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

      // Ni 500 ni, muchísimo peor, un 200.
      expect(res.statusCode).not.toBe(500)
      expect(res.statusCode).not.toBe(200)
    })
  })

  describe('en un acceso PERMITIDO', () => {
    beforeEach(() => {
      vi.mocked(emit).mockRejectedValue(new Error('base caída'))
    })

    it('responde 500 y NO ejecuta la acción', async () => {
      const { cookie } = await usuarioAutenticado('admin')

      const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

      expect(res.statusCode).toBe(500)
      expect(res.json().code).toBe(ERROR_AUTH.AUDITORIA_CAIDA)
    })

    it('el handler nunca corre: una acción sensible sin rastro no puede pasar', async () => {
      const { cookie } = await usuarioAutenticado('admin')

      const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

      expect(res.json().ejecutado).toBeUndefined()
    })
  })

  describe('cuando la bitácora funciona', () => {
    it('la acción se ejecuta normalmente', async () => {
      vi.mocked(emit).mockResolvedValue(undefined)
      const { cookie } = await usuarioAutenticado('admin')

      const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

      expect(res.statusCode).toBe(200)
      expect(res.json().ejecutado).toBe(true)
      expect(emit).toHaveBeenCalledOnce()
    })

    it('y no se escribió nada de más en la tabla real', async () => {
      vi.mocked(emit).mockResolvedValue(undefined)
      const { cookie } = await usuarioAutenticado('admin')

      await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

      // `emit` está mockeada, así que la tabla tiene que seguir vacía. Si acá
      // apareciera una fila, el mock no estaría interceptando y los tests de
      // arriba serían falsos positivos.
      expect(await db.select().from(auditLog)).toHaveLength(0)
    })
  })
})
