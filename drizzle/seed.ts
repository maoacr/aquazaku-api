import { and, eq } from 'drizzle-orm'
import { closeDb, db } from '@/db/client'
import { roles, userRoles, users } from '@/db/schema'
import { auth } from '@/modules/auth/better-auth'
import { ROLES } from '@/modules/authz/matrix'

/**
 * Deja el sistema utilizable por primera vez: el catálogo de roles y un admin
 * con el que entrar.
 *
 * Sin esto, una base recién migrada no tiene por dónde entrarle. La matriz de
 * permisos vive en código (ADR-0003), pero `user_roles` referencia la tabla
 * `roles`, así que el catálogo tiene que existir en la base.
 *
 * ── Es idempotente a propósito ──────────────────────────────────────────────
 *
 * Corre en cada deploy sin romper nada: si ya hay un admin activo, no hace nada
 * y **termina con éxito**. Abortar con error dejaría el script fuera de
 * cualquier pipeline — nadie pone en su deploy un paso que falla la segunda vez.
 */

/** Descripciones tomadas de /dominio/roles-y-permisos/. */
const CATALOGO: Record<(typeof ROLES)[number], string> = {
  admin: 'Dueño / administración. Configuración, auditoría y ajustes sensibles',
  seller: 'Vendedor. Contacta clientes y registra ventas a distancia (app móvil)',
  pos: 'Planta y mostrador. Venta, despacho y cierre de producción',
  contador: 'Contador externo o interno. Solo lectura, para temas impositivos',
}

const LARGO_MINIMO_PASSWORD = 8

export interface OpcionesDeSeed {
  email: string
  nombre: string
  password: string
}

export type ResultadoDeSeed =
  | { creado: true; adminId: string; email: string }
  | { creado: false; motivo: 'ya-hay-admin' }

/** Inserta el catálogo de roles. Idempotente. */
export async function sembrarRoles(): Promise<void> {
  await db
    .insert(roles)
    .values(ROLES.map((name) => ({ name, description: CATALOGO[name] })))
    .onConflictDoNothing()
}

/**
 * ¿Ya hay alguien que pueda administrar el sistema?
 *
 * Se exige que esté **activo**: un admin desactivado no puede entrar, así que
 * contarlo dejaría la instalación sin nadie con acceso — el mismo razonamiento
 * de RN-ACC-06.
 */
async function hayAdminActivo(): Promise<boolean> {
  const filas = await db
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleName, 'admin'), eq(users.status, 'active')))
    .limit(1)

  return filas.length > 0
}

export async function sembrar(opciones: OpcionesDeSeed): Promise<ResultadoDeSeed> {
  await sembrarRoles()

  if (await hayAdminActivo()) {
    return { creado: false, motivo: 'ya-hay-admin' }
  }

  const email = opciones.email.trim()

  // El alta pasa por Better-Auth y no por un INSERT directo: el hash argon2id
  // va en `accounts`, no en `users`. Escribirlo a mano acá sería una segunda
  // forma de crear una credencial, que el día que cambie el algoritmo queda sin
  // actualizar.
  await auth.api.signUpEmail({
    body: { name: opciones.nombre.trim(), email, password: opciones.password },
  })

  const [creado] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (!creado) throw new Error(`el alta no dejó ningún usuario con email ${email}`)

  await db.insert(userRoles).values({ userId: creado.id, roleName: 'admin' })

  // No se toca `mustChangePassword`: queda en `true`, que es el default. La
  // contraseña vino de una variable de entorno —vista por quien hizo el deploy y
  // probablemente escrita en algún historial de shell—, así que lo primero que
  // hace el admin al entrar es cambiarla (spec §13.2).

  return { creado: true, adminId: creado.id, email }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export interface ProblemaDeEntorno {
  mensaje: string
}

/** Valida el entorno del seed. Devuelve el problema, o las opciones si está bien. */
export function leerEntorno(env: NodeJS.ProcessEnv): ProblemaDeEntorno | OpcionesDeSeed {
  // En producción hay que pedirlo explícitamente. Un seed que corre solo puede
  // crear una cuenta con acceso total sin que nadie lo haya decidido.
  if (env.NODE_ENV === 'production' && env.SEED_CONFIRM !== 'yes') {
    return {
      mensaje:
        'Estás en producción y no pusiste SEED_CONFIRM=yes.\n' +
        'Este script crea un usuario con acceso total al sistema: no corre solo por accidente.',
    }
  }

  const password = env.SEED_ADMIN_PASSWORD

  if (!password) {
    return {
      mensaje:
        'Falta SEED_ADMIN_PASSWORD.\n' +
        'Generá una con: openssl rand -base64 24',
    }
  }

  if (password.length < LARGO_MINIMO_PASSWORD) {
    return {
      mensaje: `SEED_ADMIN_PASSWORD necesita al menos ${LARGO_MINIMO_PASSWORD} caracteres.`,
    }
  }

  return {
    email: env.SEED_ADMIN_EMAIL ?? 'admin@aquazaku.com',
    nombre: env.SEED_ADMIN_NAME ?? 'Admin Inicial',
    password,
  }
}

function esProblema(v: ProblemaDeEntorno | OpcionesDeSeed): v is ProblemaDeEntorno {
  return 'mensaje' in v
}

async function main(): Promise<void> {
  const entorno = leerEntorno(process.env)

  if (esProblema(entorno)) {
    console.error(`✗ ${entorno.mensaje}`)
    process.exitCode = 1
    return
  }

  const resultado = await sembrar(entorno)

  if (!resultado.creado) {
    console.log('· Ya hay un administrador activo: no se creó ninguno. Nada que hacer.')
    return
  }

  console.log(`✓ Administrador creado: ${resultado.email}`)
  console.log('  Al entrar por primera vez va a tener que cambiar la contraseña.')
}

// Solo corre como CLI. Importado desde un test, exporta las funciones y no
// ejecuta nada.
if (process.argv[1]?.endsWith('seed.ts')) {
  try {
    await main()
  } catch (err) {
    console.error('✗ falló el seed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    // `process.exit()` cortaría la conexión a medio drenar y dejaría el último
    // INSERT en el aire.
    await closeDb()
  }
}
