import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { roles as rolesTable, sessions, userRoles, users } from '@/db/schema'
import { auth } from '@/modules/auth/better-auth'
import { COOKIE_SESION } from '@/modules/authz/middleware'
import { ROLES, type Role } from '@/modules/authz/matrix'

/**
 * Fixtures para tests de integración. Solo se importan desde tests.
 *
 * Los usuarios y las sesiones se crean **a través de Better-Auth**, no
 * insertando filas a mano. Es más lento (cada alta hashea con argon2id), pero es
 * el único modo de obtener una cookie realmente firmada. Una fixture que inserta
 * un token crudo produce sesiones que el sistema real nunca aceptaría, y los
 * tests que la usan verifican un camino que no existe.
 */

export const PASSWORD_DE_PRUEBA = 'contrasena-de-prueba-123'

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

/** Crea un usuario real (con credencial) y le asigna sus roles. */
export async function crearUsuario(opciones: OpcionesUsuario = {}): Promise<UsuarioDePrueba> {
  const { roles = [], status = 'active', email = `u-${randomUUID()}@aquazaku.com` } = opciones

  await sembrarRoles()

  await auth.api.signUpEmail({
    body: { name: 'Usuario de prueba', email, password: PASSWORD_DE_PRUEBA },
  })

  const [usuario] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (!usuario) throw new Error(`no se pudo crear el usuario de prueba ${email}`)

  if (roles.length > 0) {
    await db.insert(userRoles).values(roles.map((roleName) => ({ userId: usuario.id, roleName })))
  }

  // El estado se ajusta después del alta: `status` es `input: false` en
  // Better-Auth, así que el sign-up siempre crea al usuario activo.
  if (status !== 'active') {
    await db.update(users).set({ status }).where(eq(users.id, usuario.id))
  }

  return { id: usuario.id, email, roles }
}

interface OpcionesSesion {
  /** Milisegundos hasta el vencimiento. Negativo produce una sesión vencida. */
  vencaEn?: number
}

/**
 * Inicia sesión y devuelve la cookie firmada, lista para mandar en un header.
 *
 * Los roles quedan congelados acá, igual que en el login real: la sesión guarda
 * los roles que el usuario tenía al autenticarse (RN-ACC-01, sin switch de rol).
 * Por eso hay que asignarlos ANTES de llamar a esta función.
 */
export async function crearSesion(
  usuario: UsuarioDePrueba,
  opciones: OpcionesSesion = {},
): Promise<string> {
  const respuesta = await auth.api.signInEmail({
    body: { email: usuario.email, password: PASSWORD_DE_PRUEBA },
    asResponse: true,
  })

  const cookie = respuesta.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${COOKIE_SESION}=`))
    ?.split(';')[0]

  if (!cookie) throw new Error(`el login de ${usuario.email} no devolvió cookie de sesión`)

  // Para probar el vencimiento se retrocede la fecha en la base. La cookie sigue
  // siendo válida (la firma es sobre el token), que es exactamente el escenario
  // real: el browser conserva una cookie cuya sesión ya expiró del lado servidor.
  if (opciones.vencaEn !== undefined) {
    const token = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? ''
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + opciones.vencaEn) })
      .where(eq(sessions.token, token))
  }

  return cookie
}

/** Atajo: usuario con roles y sesión válida, listo para pegarle a un endpoint. */
export async function usuarioAutenticado(
  ...roles: Role[]
): Promise<{ usuario: UsuarioDePrueba; cookie: string }> {
  const usuario = await crearUsuario({ roles })
  const cookie = await crearSesion(usuario)

  return { usuario, cookie }
}
