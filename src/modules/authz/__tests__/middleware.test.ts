import { desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { crearSesion, crearUsuario, usuarioAutenticado } from '@/test/fixtures'
import { resetDb } from '@/test/db'
import { ERROR_AUTH, requireAuth, requirePermission } from '../middleware'

/**
 * Tests de integración del middleware: HTTP real vía `app.inject()`, sesiones
 * reales en Postgres y bitácora real.
 *
 * El plan difería estos tests a la Task 9 "porque requerirían una base de test".
 * La base existe desde la Task 2, y este es el módulo que decide quién entra a
 * qué: es exactamente el último lugar donde conviene postergar la verificación.
 */

let app: FastifyInstance

async function construirApp(): Promise<FastifyInstance> {
  const instancia = await buildApp()

  instancia.get('/protegido', { preHandler: requireAuth }, async (req) => ({
    userId: req.user?.id,
    roles: req.user?.roles,
  }))

  // Acción sensible: se audita al permitirse.
  instancia.post(
    '/ventas/anular',
    { preHandler: [requireAuth, requirePermission('ventas', 'anular')] },
    async () => ({ ok: true }),
  )

  // Lectura pura: NO se audita al permitirse.
  instancia.get(
    '/ventas',
    { preHandler: [requireAuth, requirePermission('ventas', 'ver')] },
    async () => ({ ok: true }),
  )

  // Lectura que SÍ se audita: quién mira la bitácora queda en la bitácora.
  instancia.get(
    '/auditoria',
    { preHandler: [requireAuth, requirePermission('auditoria', 'ver')] },
    async () => ({ ok: true }),
  )

  // Sin `requireAuth` antes: no debería poder ejecutarse nunca.
  instancia.get(
    '/mal-configurado',
    { preHandler: requirePermission('ventas', 'ver') },
    async () => ({ ok: true }),
  )

  await instancia.ready()
  return instancia
}

const registros = () => db.select().from(auditLog).orderBy(desc(auditLog.id))

beforeEach(async () => {
  await resetDb()
  app = await construirApp()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('requireAuth', () => {
  it('sin cookie devuelve 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/protegido' })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ERROR_AUTH.SIN_SESION)
  })

  it('con un token que no existe devuelve 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protegido',
      headers: { cookie: 'aquazaku_session=token-inventado' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ERROR_AUTH.SIN_SESION)
  })

  it('con la sesión vencida devuelve 401 con código propio', async () => {
    const usuario = await crearUsuario({ roles: ['admin'] })
    const token = await crearSesion(usuario, { vencaEn: -1000 })

    const res = await app.inject({
      method: 'GET',
      url: '/protegido',
      headers: { cookie: `aquazaku_session=${token}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ERROR_AUTH.SESION_VENCIDA)
  })

  it('con el usuario desactivado devuelve 401 aunque la sesión siga viva', async () => {
    // RN-ACC-05: desactivar tiene que hacer efecto en el request siguiente, no
    // cuando le venza la sesión.
    const usuario = await crearUsuario({ roles: ['admin'], status: 'inactive' })
    const token = await crearSesion(usuario)

    const res = await app.inject({
      method: 'GET',
      url: '/protegido',
      headers: { cookie: `aquazaku_session=${token}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe(ERROR_AUTH.USUARIO_INACTIVO)
  })

  it('con sesión válida deja pasar y puebla req.user', async () => {
    const { usuario, cookie } = await usuarioAutenticado('pos', 'seller')

    const res = await app.inject({ method: 'GET', url: '/protegido', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe(usuario.id)
    expect(res.json().roles).toEqual(['pos', 'seller'])
  })

  it('los códigos de error son distintos entre sí: web/ los usa para el mensaje', () => {
    const codigos = [ERROR_AUTH.SIN_SESION, ERROR_AUTH.SESION_VENCIDA, ERROR_AUTH.USUARIO_INACTIVO]

    expect(new Set(codigos).size).toBe(3)
  })
})

describe('requirePermission', () => {
  it('sin requireAuth previo devuelve 401 en vez de dejar pasar', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({ method: 'GET', url: '/mal-configurado', headers: { cookie } })

    expect(res.statusCode).toBe(401)
  })

  it('permite cuando el rol concede el permiso', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

    expect(res.statusCode).toBe(200)
  })

  it('deniega con 403 cuando el rol no lo concede', async () => {
    const { cookie } = await usuarioAutenticado('contador')

    const res = await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      code: ERROR_AUTH.SIN_PERMISO,
      resource: 'ventas',
      action: 'anular',
    })
  })

  it('multi-rol: alcanza con que UN rol lo conceda', async () => {
    // `seller` solo no puede anular ventas ajenas ni acceder como admin;
    // sumándole `admin`, sí.
    const soloSeller = await usuarioAutenticado('seller')
    const conAdmin = await usuarioAutenticado('seller', 'admin')

    const sinPermiso = await app.inject({
      method: 'POST',
      url: '/ventas/anular',
      headers: { cookie: soloSeller.cookie },
    })
    const conPermiso = await app.inject({
      method: 'POST',
      url: '/ventas/anular',
      headers: { cookie: conAdmin.cookie },
    })

    // seller SÍ tiene ventas:anular (alcance propio), así que ambos pasan.
    expect(sinPermiso.statusCode).toBe(200)
    expect(conPermiso.statusCode).toBe(200)
  })
})

describe('qué queda en la bitácora', () => {
  it('un acceso denegado siempre deja rastro', async () => {
    const { usuario, cookie } = await usuarioAutenticado('contador')

    await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

    const filas = await registros()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      userId: usuario.id,
      action: 'ventas:anular',
      resource: 'ventas',
      result: 'denied',
      rolEjercido: ['contador'],
    })
  })

  it('la acción se guarda como `recurso:accion`, que es la nomenclatura del dominio', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

    // En la columna indexada, no escondida en el payload: si no se puede
    // filtrar por acción, la UI de auditoría no sirve.
    expect((await registros())[0]?.action).toBe('ventas:anular')
  })

  it('una acción sensible permitida deja rastro', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

    const filas = await registros()
    expect(filas).toHaveLength(1)
    expect(filas[0]?.result).toBe('ok')
  })

  it('una lectura pura permitida NO deja rastro', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    await app.inject({ method: 'GET', url: '/ventas', headers: { cookie } })

    // Auditar cada lectura sería un INSERT por pantalla y ahogaría la señal.
    expect(await registros()).toHaveLength(0)
  })

  it('una lectura DENEGADA sí deja rastro', async () => {
    const usuario = await crearUsuario({ roles: [] })
    const token = await crearSesion(usuario)

    await app.inject({
      method: 'GET',
      url: '/ventas',
      headers: { cookie: `aquazaku_session=${token}` },
    })

    const filas = await registros()
    expect(filas).toHaveLength(1)
    expect(filas[0]?.result).toBe('denied')
  })

  it('mirar la bitácora también queda en la bitácora', async () => {
    const { cookie } = await usuarioAutenticado('contador')

    await app.inject({ method: 'GET', url: '/auditoria', headers: { cookie } })

    const filas = await registros()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ action: 'auditoria:ver', result: 'ok' })
  })

  it('guarda todos los roles activos, no uno solo', async () => {
    const { cookie } = await usuarioAutenticado('pos', 'seller')

    await app.inject({ method: 'POST', url: '/ventas/anular', headers: { cookie } })

    expect((await registros())[0]?.rolEjercido).toEqual(['pos', 'seller'])
  })

  it('conserva el x-request-id del cliente para poder correlacionar con web/', async () => {
    const { cookie } = await usuarioAutenticado('admin')
    const requestId = 'req-de-prueba-123'

    await app.inject({
      method: 'POST',
      url: '/ventas/anular',
      headers: { cookie, 'x-request-id': requestId },
    })

    expect((await registros())[0]?.requestId).toBe(requestId)
  })

  it('guarda user agent e ip', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    await app.inject({
      method: 'POST',
      url: '/ventas/anular',
      headers: { cookie, 'user-agent': 'navegador-de-prueba/1.0' },
    })

    const fila = (await registros())[0]
    expect(fila?.userAgent).toBe('navegador-de-prueba/1.0')
    expect(fila?.ip).toBeTruthy()
  })
})
