import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { accounts, auditLog, sessions, userRoles } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { PASSWORD_DE_PRUEBA, crearUsuario, usuarioAutenticado } from '@/test/fixtures'
import { _reiniciarLimites } from '@/modules/auth/rate-limit'

let app: FastifyInstance
let admin: { usuario: { id: string; email: string }; cookie: string }

const registros = () => db.select().from(auditLog).orderBy(desc(auditLog.id))

const NUEVO = {
  email: 'nuevo@aquazaku.com',
  name: 'Persona Nueva',
  password: 'contrasena-inicial-123',
  roles: ['pos', 'seller'],
}

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

/** Manda el request con la cookie del admin ya puesta. */
const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

describe('quién puede administrar usuarios', () => {
  it('sin sesión: 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/users' })).statusCode).toBe(401)
  })

  const sinPermiso: Role[] = ['seller', 'pos', 'contador']

  for (const rol of sinPermiso) {
    it(`${rol} no puede listar usuarios: 403`, async () => {
      const { cookie } = await usuarioAutenticado(rol)

      const res = await app.inject({ method: 'GET', url: '/users', headers: { cookie } })

      expect(res.statusCode).toBe(403)
    })

    it(`${rol} no puede crear usuarios: 403`, async () => {
      const { cookie } = await usuarioAutenticado(rol)

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { cookie },
        payload: NUEVO,
      })

      expect(res.statusCode).toBe(403)
    })
  }

  it('admin sí puede', async () => {
    expect((await comoAdmin({ method: 'GET', url: '/users' })).statusCode).toBe(200)
  })
})

describe('GET /users', () => {
  it('devuelve los usuarios con sus roles', async () => {
    await crearUsuario({ roles: ['pos', 'seller'], email: 'multi@aquazaku.com' })

    const lista = (await comoAdmin({ method: 'GET', url: '/users' })).json() as Array<{
      email: string
      roles: string[]
    }>

    const multi = lista.find((u) => u.email === 'multi@aquazaku.com')
    // Sin los roles en la lista, la pantalla de administración necesitaría un
    // request por fila para saber quién es admin.
    expect(multi?.roles).toEqual(['pos', 'seller'])
  })

  it('nunca expone la contraseña', async () => {
    const cuerpo = (await comoAdmin({ method: 'GET', url: '/users' })).body

    expect(cuerpo).not.toContain('password')
    expect(cuerpo).not.toContain('$argon2')
  })
})

describe('GET /users/:id', () => {
  it('404 si no existe', async () => {
    const res = await comoAdmin({
      method: 'GET',
      url: '/users/00000000-0000-0000-0000-000000000000',
    })

    expect(res.statusCode).toBe(404)
  })
})

describe('POST /users', () => {
  it('crea el usuario y devuelve 201 con sus roles', async () => {
    const res = await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      email: NUEVO.email,
      name: NUEVO.name,
      status: 'active',
      roles: ['pos', 'seller'],
    })
  })

  it('nace obligado a cambiar la contraseña — la eligió un admin, no la persona', async () => {
    const res = await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    expect(res.json().mustChangePassword).toBe(true)
  })

  it('la contraseña queda en accounts, hasheada con argon2id', async () => {
    const res = await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    const [cuenta] = await db.select().from(accounts).where(eq(accounts.userId, res.json().id))

    expect(cuenta?.password).toMatch(/^\$argon2id\$/)
    expect(cuenta?.password).not.toContain(NUEVO.password)
  })

  it('el usuario recién creado puede entrar y ve sus roles', async () => {
    await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: NUEVO.email, password: NUEVO.password },
    })
    expect(login.statusCode).toBe(200)

    const setCookie = login.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
    const cookie = (cookies.find((c) => c.startsWith('aquazaku_session=')) ?? '').split(';')[0] ?? ''

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect([...(me.json().roles as string[])].sort()).toEqual(['pos', 'seller'])
    expect(me.json().mustChangePassword).toBe(true)
  })

  it('se puede crear sin roles: es un estado válido, no un error', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/users',
      payload: { ...NUEVO, roles: [] },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().roles).toEqual([])
  })

  it('email repetido: 409, no 500', async () => {
    await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    const segundo = await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    expect(segundo.statusCode).toBe(409)
    expect(segundo.json().code).toBe('EMAIL_EN_USO')
  })

  it('email repetido con otro case también choca: users.email es citext', async () => {
    await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    const segundo = await comoAdmin({
      method: 'POST',
      url: '/users',
      payload: { ...NUEVO, email: NUEVO.email.toUpperCase() },
    })

    expect(segundo.statusCode).toBe(409)
  })

  it('datos inválidos: 400 con el detalle por campo', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/users',
      payload: { email: 'no-es-un-email', name: '', password: 'corta', roles: ['gerente'] },
    })

    expect(res.statusCode).toBe(400)
    const campos = (res.json().detalle as Array<{ campo: string }>).map((d) => d.campo)
    expect(campos).toContain('email')
    expect(campos).toContain('name')
    expect(campos).toContain('password')
  })
})

describe('PATCH /users/:id', () => {
  it('cambia el nombre', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })

    const res = await comoAdmin({
      method: 'PATCH',
      url: `/users/${otro.id}`,
      payload: { name: 'Nombre Corregido' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Nombre Corregido')
  })

  it('desactivar CIERRA las sesiones del usuario', async () => {
    const victima = await usuarioAutenticado('pos')
    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: victima.cookie } }))
        .statusCode,
    ).toBe(200)

    await comoAdmin({
      method: 'PATCH',
      url: `/users/${victima.usuario.id}`,
      payload: { status: 'inactive' },
    })

    // No alcanza con que `requireAuth` lo frene: una sesión de alguien que ya no
    // debería entrar no tiene por qué seguir existiendo.
    expect(await db.select().from(sessions).where(eq(sessions.userId, victima.usuario.id))).toHaveLength(0)
    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: victima.cookie } }))
        .statusCode,
    ).toBe(401)
  })

  it('404 si el usuario no existe', async () => {
    const res = await comoAdmin({
      method: 'PATCH',
      url: '/users/00000000-0000-0000-0000-000000000000',
      payload: { name: 'X' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('un body vacío es 400: no hay nada que modificar', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })

    const res = await comoAdmin({ method: 'PATCH', url: `/users/${otro.id}`, payload: {} })

    expect(res.statusCode).toBe(400)
  })
})

describe('PUT /users/:id/roles', () => {
  it('reemplaza el conjunto completo de roles', async () => {
    const otro = await crearUsuario({ roles: ['pos', 'seller'] })

    const res = await comoAdmin({
      method: 'PUT',
      url: `/users/${otro.id}/roles`,
      payload: { roles: ['contador'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().roles).toEqual(['contador'])
  })

  it('registra quién otorgó los roles', async () => {
    const otro = await crearUsuario({ roles: [] })

    await comoAdmin({ method: 'PUT', url: `/users/${otro.id}/roles`, payload: { roles: ['pos'] } })

    const [asignacion] = await db.select().from(userRoles).where(eq(userRoles.userId, otro.id))
    expect(asignacion?.grantedBy).toBe(admin.usuario.id)
  })

  it('es idempotente: repetir la llamada no duplica roles', async () => {
    const otro = await crearUsuario({ roles: [] })

    await comoAdmin({ method: 'PUT', url: `/users/${otro.id}/roles`, payload: { roles: ['pos'] } })
    const res = await comoAdmin({
      method: 'PUT',
      url: `/users/${otro.id}/roles`,
      payload: { roles: ['pos'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().roles).toEqual(['pos'])
  })
})

/**
 * El pendiente que quedó anotado en la Task 5: los roles se congelan dentro de
 * la sesión al iniciar sesión. Sin actualizarlos, un cambio de roles no tendría
 * efecto hasta que la persona vuelva a entrar — y eso es inaceptable en la
 * dirección peligrosa.
 */
describe('un cambio de roles hace efecto EN EL ACTO', () => {
  it('quitar el rol admin le corta el acceso en el request siguiente', async () => {
    const otroAdmin = await usuarioAutenticado('admin')
    expect(
      (await app.inject({ method: 'GET', url: '/users', headers: { cookie: otroAdmin.cookie } }))
        .statusCode,
    ).toBe(200)

    await comoAdmin({
      method: 'PUT',
      url: `/users/${otroAdmin.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    // Sin actualizar la sesión, seguiría administrando durante siete días.
    const res = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: otroAdmin.cookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('agregar un rol le habilita permisos sin tener que volver a entrar', async () => {
    const usuario = await usuarioAutenticado('seller')

    await comoAdmin({
      method: 'PUT',
      url: `/users/${usuario.usuario.id}/roles`,
      payload: { roles: ['seller', 'admin'] },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: usuario.cookie },
    })
    expect(res.statusCode).toBe(200)
  })

  it('la sesión sigue viva: un trámite administrativo no echa a nadie del sistema', async () => {
    const usuario = await usuarioAutenticado('seller')

    await comoAdmin({
      method: 'PUT',
      url: `/users/${usuario.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: usuario.cookie },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().roles).toEqual(['pos'])
  })
})

/**
 * La regla que impide dejar el sistema sin administrador.
 *
 * El dominio dice que hoy el dueño es el único admin. Un click de más en la
 * pantalla de usuarios podía dejar el sistema inadministrable, recuperable solo
 * metiendo mano en la base.
 */
describe('protección del último administrador', () => {
  it('no puede quitarse a sí mismo el rol admin si es el único', async () => {
    const res = await comoAdmin({
      method: 'PUT',
      url: `/users/${admin.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('ULTIMO_ADMIN')
  })

  it('no puede desactivarse a sí mismo si es el único admin', async () => {
    const res = await comoAdmin({
      method: 'PATCH',
      url: `/users/${admin.usuario.id}`,
      payload: { status: 'inactive' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('ULTIMO_ADMIN')
  })

  it('sigue siendo admin después del intento fallido', async () => {
    await comoAdmin({
      method: 'PUT',
      url: `/users/${admin.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    const res = await comoAdmin({ method: 'GET', url: '/users' })
    expect(res.statusCode).toBe(200)
  })

  it('SÍ puede si hay otro admin activo', async () => {
    await crearUsuario({ roles: ['admin'], email: 'segundo-admin@aquazaku.com' })

    const res = await comoAdmin({
      method: 'PUT',
      url: `/users/${admin.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    expect(res.statusCode).toBe(200)
  })

  it('un admin DESACTIVADO no cuenta como respaldo', async () => {
    const suplente = await crearUsuario({ roles: ['admin'], status: 'inactive' })
    expect(suplente.id).toBeTruthy()

    const res = await comoAdmin({
      method: 'PUT',
      url: `/users/${admin.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    // Si contara, el sistema quedaría en manos de una cuenta que no puede entrar.
    expect(res.statusCode).toBe(409)
  })

  it('quitarle el rol a alguien que NO es admin no se ve afectado por la regla', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })

    const res = await comoAdmin({
      method: 'PUT',
      url: `/users/${otro.id}/roles`,
      payload: { roles: [] },
    })

    expect(res.statusCode).toBe(200)
  })

  it('el intento fallido queda en la bitácora', async () => {
    await comoAdmin({
      method: 'PUT',
      url: `/users/${admin.usuario.id}/roles`,
      payload: { roles: ['pos'] },
    })

    const denegado = (await registros()).find(
      (r) => r.action === 'usuarios:editar' && r.result === 'denied',
    )
    expect(denegado?.payload).toMatchObject({ motivo: 'ULTIMO_ADMIN' })
  })
})

describe('qué queda en la bitácora', () => {
  it('crear un usuario deja UNA fila, con el detalle', async () => {
    const antes = (await registros()).length

    const res = await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    const nuevas = (await registros()).slice(0, (await registros()).length - antes)
    const deUsuarios = nuevas.filter((r) => r.resource === 'usuarios')

    // Una sola: si el middleware auditara además del handler, quedarían dos
    // filas por acción y la bitácora se leería el doble diciendo la mitad.
    expect(deUsuarios).toHaveLength(1)
    expect(deUsuarios[0]).toMatchObject({
      action: 'usuarios:crear',
      resourceId: res.json().id,
      result: 'ok',
    })
    expect(deUsuarios[0]?.payload).toMatchObject({ email: NUEVO.email, roles: ['pos', 'seller'] })
  })

  it('un cambio de roles registra el antes y el después', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })

    await comoAdmin({
      method: 'PUT',
      url: `/users/${otro.id}/roles`,
      payload: { roles: ['contador'] },
    })

    const cambio = (await registros()).find(
      (r) => r.resourceId === otro.id && r.action === 'usuarios:editar',
    )
    expect(cambio?.payload).toMatchObject({ rolesAntes: ['pos'], rolesDespues: ['contador'] })
  })

  it('desactivar a alguien queda registrado', async () => {
    const otro = await crearUsuario({ roles: ['pos'] })

    await comoAdmin({
      method: 'PATCH',
      url: `/users/${otro.id}`,
      payload: { status: 'inactive' },
    })

    const cambio = (await registros()).find((r) => r.resourceId === otro.id)
    expect(cambio?.payload).toMatchObject({ cambios: { status: 'inactive' } })
  })

  it('un intento sin permiso queda registrado por el middleware', async () => {
    const { usuario, cookie } = await usuarioAutenticado('seller')

    await app.inject({ method: 'POST', url: '/users', headers: { cookie }, payload: NUEVO })

    const denegado = (await registros()).find(
      (r) => r.userId === usuario.id && r.action === 'usuarios:crear',
    )
    expect(denegado?.result).toBe('denied')
  })

  it('la contraseña del nuevo usuario NUNCA llega a la bitácora', async () => {
    await comoAdmin({ method: 'POST', url: '/users', payload: NUEVO })

    expect(JSON.stringify(await registros())).not.toContain(NUEVO.password)
    expect(JSON.stringify(await registros())).not.toContain(PASSWORD_DE_PRUEBA)
  })
})
