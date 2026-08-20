import { randomUUID } from 'node:crypto'
import { db } from '@/db/client'
import { roles as rolesTable, sessions, userRoles, users } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { ROLES } from '@/modules/authz/matrix'

/**
 * Fixtures para tests de integración. Solo se importan desde tests.
 */

/** Inserta el catálogo de los cuatro roles. Idempotente. */
export async function sembrarRoles(): Promise<void> {
  await db
    .insert(rolesTable)
    .values(ROLES.map((name) => ({ name, description: `Rol ${name}` })))
    .onConflictDoNothing()
}

interface OpcionesUsuario {
  roles?: readonly Role[]
  status?: 'active' | 'inactive'
  email?: string
}

export interface UsuarioDePrueba {
  id: string
  email: string
  roles: readonly Role[]
}

/** Crea un usuario con sus roles asignados. Siembra el catálogo si hace falta. */
export async function crearUsuario(opciones: OpcionesUsuario = {}): Promise<UsuarioDePrueba> {
  const { roles = [], status = 'active', email = `u-${randomUUID()}@aquazaku.com` } = opciones

  await sembrarRoles()

  const [usuario] = await db
    .insert(users)
    .values({ name: 'Usuario de prueba', email, status })
    .returning({ id: users.id })

  if (!usuario) throw new Error('no se pudo crear el usuario de prueba')

  if (roles.length > 0) {
    await db.insert(userRoles).values(roles.map((roleName) => ({ userId: usuario.id, roleName })))
  }

  return { id: usuario.id, email, roles }
}

interface OpcionesSesion {
  /** Milisegundos hasta el vencimiento. Negativo produce una sesión vencida. */
  vencaEn?: number
}

/**
 * Crea una sesión y devuelve su token — que es lo que viaja en la cookie.
 *
 * Los roles se congelan acá, tal como hace el login real: la sesión guarda los
 * roles que el usuario tenía al autenticarse (RN-ACC-01, sin switch de rol).
 */
export async function crearSesion(
  usuario: UsuarioDePrueba,
  opciones: OpcionesSesion = {},
): Promise<string> {
  const { vencaEn = 7 * 24 * 60 * 60 * 1000 } = opciones
  const token = `tok-${randomUUID()}`

  await db.insert(sessions).values({
    token,
    userId: usuario.id,
    expiresAt: new Date(Date.now() + vencaEn),
    roles: [...usuario.roles],
  })

  return token
}

/** Atajo: usuario con roles y sesión válida, listo para pegarle a un endpoint. */
export async function usuarioAutenticado(
  ...roles: Role[]
): Promise<{ usuario: UsuarioDePrueba; cookie: string }> {
  const usuario = await crearUsuario({ roles })
  const token = await crearSesion(usuario)

  return { usuario, cookie: `aquazaku_session=${token}` }
}
