import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '@/db/client'
import { sessions, userRoles, users } from '@/db/schema'
import { auth } from '@/modules/auth/better-auth'
import { ErrorDeNegocio } from '@/lib/errors'
import type { Role } from '@/modules/authz/matrix'

export interface UsuarioListado {
  id: string
  email: string
  name: string
  status: 'active' | 'inactive'
  mustChangePassword: boolean
  roles: string[]
  createdAt: Date
}

/**
 * Lista los usuarios con sus roles.
 *
 * Los roles vienen incluidos porque la pantalla de administración los necesita
 * en la misma tabla: sin ellos, mostrar quién es admin obligaría a un request
 * por fila.
 */
export async function listarUsuarios(): Promise<UsuarioListado[]> {
  const filas = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt)

  if (filas.length === 0) return []

  const asignaciones = await db
    .select({ userId: userRoles.userId, roleName: userRoles.roleName })
    .from(userRoles)
    .where(
      inArray(
        userRoles.userId,
        filas.map((f) => f.id),
      ),
    )

  const porUsuario = new Map<string, string[]>()
  for (const a of asignaciones) {
    porUsuario.set(a.userId, [...(porUsuario.get(a.userId) ?? []), a.roleName])
  }

  return filas.map((f) => ({ ...f, roles: (porUsuario.get(f.id) ?? []).sort() }))
}

export async function buscarUsuario(userId: string): Promise<UsuarioListado | null> {
  const todos = await listarUsuarios()
  return todos.find((u) => u.id === userId) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// La regla que impide dejar el sistema sin administrador
//
// El dominio dice que hoy el dueño es el ÚNICO admin
// (/dominio/roles-y-permisos/). Si se quita a sí mismo el rol, o se desactiva,
// nadie queda con permiso para devolvérselo: el sistema pasa a ser
// inadministrable y solo se recupera metiendo mano en la base a mano.
//
// No es un caso raro. Es un click de más en una pantalla que existe justamente
// para editar usuarios.
// ─────────────────────────────────────────────────────────────────────────────

/** Cuenta administradores activos, opcionalmente ignorando a uno. */
async function contarAdminsActivos(excepto?: string): Promise<number> {
  const condiciones = [eq(userRoles.roleName, 'admin'), eq(users.status, 'active')]
  if (excepto) condiciones.push(ne(users.id, excepto))

  const filas = await db
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(...condiciones))

  return filas.length
}

async function esAdminActivo(userId: string): Promise<boolean> {
  const filas = await db
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.roleName, 'admin'),
        eq(users.status, 'active'),
      ),
    )
    .limit(1)

  return filas.length > 0
}

/**
 * Bloquea la operación si dejaría al sistema sin ningún administrador activo.
 *
 * Dos condiciones tienen que darse a la vez para que sea peligrosa:
 * que este usuario sea hoy un admin activo, y que no haya ningún otro.
 */
async function exigirQueQuedeUnAdmin(userId: string, motivo: string): Promise<void> {
  if ((await contarAdminsActivos(userId)) > 0) return
  if (!(await esAdminActivo(userId))) return

  throw new ErrorDeNegocio(
    'ULTIMO_ADMIN',
    409,
    `${motivo} dejaría al sistema sin ningún administrador activo. ` +
      'Asignale el rol admin a otra persona antes de hacerlo.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Operaciones
// ─────────────────────────────────────────────────────────────────────────────

export interface AltaDeUsuarioInput {
  email: string
  name: string
  password: string
  roles: readonly Role[]
}

/**
 * Crea un usuario con su credencial.
 *
 * Pasa por Better-Auth y no por un INSERT directo: el hash argon2id va en
 * `accounts`, no en `users`, y replicar acá esa mecánica sería tener dos formas
 * distintas de crear una credencial —con el riesgo de que una quede sin
 * actualizar el día que cambie el algoritmo.
 *
 * Nace con `mustChangePassword: true`, que es el default de la tabla: la
 * contraseña la eligió un admin, no la persona, así que la primera cosa que
 * hace al entrar es cambiarla (spec §7.2).
 */
export async function crearUsuario(input: AltaDeUsuarioInput): Promise<UsuarioListado> {
  const yaExiste = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  if (yaExiste.length > 0) {
    throw new ErrorDeNegocio('EMAIL_EN_USO', 409, 'ya existe un usuario con ese email')
  }

  await auth.api.signUpEmail({
    body: { name: input.name, email: input.email, password: input.password },
  })

  const [creado] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  if (!creado) throw new Error('el alta no dejó ningún usuario en la base')

  if (input.roles.length > 0) {
    await db
      .insert(userRoles)
      .values(input.roles.map((roleName) => ({ userId: creado.id, roleName })))
  }

  const usuario = await buscarUsuario(creado.id)
  if (!usuario) throw new Error('no se pudo leer el usuario recién creado')

  return usuario
}

export interface EdicionInput {
  name?: string | undefined
  status?: 'active' | 'inactive' | undefined
  mustChangePassword?: boolean | undefined
}

/**
 * Modifica un usuario.
 *
 * Desactivar cierra sus sesiones. `requireAuth` ya lo frena en el request
 * siguiente por el chequeo de `status`, pero borrarlas es lo correcto igual:
 * una sesión de alguien que ya no debería entrar no tiene por qué seguir
 * existiendo, y no queremos que la única barrera sea que nadie se olvide de ese
 * chequeo.
 */
export async function editarUsuario(userId: string, patch: EdicionInput): Promise<UsuarioListado> {
  if (patch.status === 'inactive') {
    await exigirQueQuedeUnAdmin(userId, 'Desactivar a este usuario')
  }

  const cambios: Record<string, unknown> = {}
  if (patch.name !== undefined) cambios.name = patch.name
  if (patch.status !== undefined) cambios.status = patch.status
  if (patch.mustChangePassword !== undefined) cambios.mustChangePassword = patch.mustChangePassword

  const actualizados = await db
    .update(users)
    .set(cambios)
    .where(eq(users.id, userId))
    .returning({ id: users.id })

  if (actualizados.length === 0) {
    throw new ErrorDeNegocio('USUARIO_NO_ENCONTRADO', 404, 'no existe ese usuario')
  }

  if (patch.status === 'inactive') {
    await db.delete(sessions).where(eq(sessions.userId, userId))
  }

  const usuario = await buscarUsuario(userId)
  if (!usuario) throw new ErrorDeNegocio('USUARIO_NO_ENCONTRADO', 404, 'no existe ese usuario')

  return usuario
}

/**
 * Reemplaza los roles de un usuario.
 *
 * ── Por qué se actualizan las sesiones abiertas ──────────────────────────────
 *
 * Los roles se congelan dentro de la sesión al iniciar sesión (Task 5), así que
 * sin este paso un cambio de roles no tendría efecto hasta que la persona
 * vuelva a entrar. Eso es inaceptable en la dirección peligrosa: quitarle el rol
 * `admin` a alguien lo dejaría administrando durante siete días más.
 *
 * Se actualizan en lugar de cerrar las sesiones. Cerrarlas también resolvería el
 * problema, pero echaría a la persona del sistema cada vez que un admin le toca
 * un rol — un trámite administrativo no debería interrumpirle el trabajo a
 * nadie. Actualizar hace efecto en el request siguiente, que es lo que importa.
 */
export async function asignarRoles(
  userId: string,
  nuevosRoles: readonly Role[],
  otorgadoPor: string,
): Promise<UsuarioListado> {
  if (!nuevosRoles.includes('admin')) {
    await exigirQueQuedeUnAdmin(userId, 'Quitarle el rol admin a este usuario')
  }

  const [existe] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!existe) throw new ErrorDeNegocio('USUARIO_NO_ENCONTRADO', 404, 'no existe ese usuario')

  await db.transaction(async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId))

    if (nuevosRoles.length > 0) {
      await tx
        .insert(userRoles)
        .values(nuevosRoles.map((roleName) => ({ userId, roleName, grantedBy: otorgadoPor })))
    }

    await tx
      .update(sessions)
      .set({ roles: [...nuevosRoles] })
      .where(eq(sessions.userId, userId))
  })

  const usuario = await buscarUsuario(userId)
  if (!usuario) throw new ErrorDeNegocio('USUARIO_NO_ENCONTRADO', 404, 'no existe ese usuario')

  return usuario
}
