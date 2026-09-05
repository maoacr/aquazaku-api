import { and, eq } from 'drizzle-orm'
import { closeDb, db } from '@/db/client'
import { type NuevoProducto, insumos, productos, roles, userRoles, users } from '@/db/schema'
import { auth } from '@/modules/auth/better-auth'
import { ROLES } from '@/modules/authz/matrix'
import { codigoBase } from '@/modules/productos/codigo'
import { describirConexion } from '../scripts/describir-conexion'
import { INSUMOS_POR_BOTELLON } from '@/modules/produccion/cierre'

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

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de productos — M1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los tres productos reales de Aquazaku, con sus equivalencias confirmadas
 * (/dominio/productos/).
 *
 * ── Por qué las pacas nacen INACTIVAS ───────────────────────────────────────
 *
 * Solo el precio del botellón está confirmado: $10.000 (RN-CAT-08). Los de las
 * pacas no, y hay dos formas de sembrarlos mal:
 *
 *   1. Inventar un número plausible. Nadie lo nota, y se vende a un precio que
 *      no decidió el negocio.
 *   2. Sembrar 0 y dejar el producto activo. Un `pos` puede vender una paca a
 *      $0, y el problema aparece recién en el cierre, sin saber de dónde salió.
 *
 * Las dos fallan en silencio. Por eso las pacas entran **desactivadas**: no se
 * pueden vender hasta que un `admin` les cargue el precio real y las active.
 * Si se olvida, la venta se bloquea — que es un fallo ruidoso y se arregla en
 * el momento.
 *
 * Es el mismo criterio de ADR-0005: ante la duda, cerrado.
 */
// `unidades` es opcional en `NuevoProducto` porque la columna tiene default,
// pero el generador de código la necesita sí o sí: acá va explícita.
type SemillaDeProducto = Omit<NuevoProducto, 'codigo' | 'unidades'> & { unidades: number }

const CATALOGO_INICIAL: readonly SemillaDeProducto[] = [
  {
    nombre: 'Paca de 20 bolsas de 600 ml',
    presentacion: 'paca',
    contenidoMl: 600,
    unidades: 20,
    precioResidencial: '0.00',
    precioComercial: '0.00',
    precioMinimo: '0.00',
    activo: false,
  },
  {
    nombre: 'Paca de 50 bolsas de 300 ml',
    presentacion: 'paca',
    contenidoMl: 300,
    unidades: 50,
    precioResidencial: '0.00',
    precioComercial: '0.00',
    precioMinimo: '0.00',
    activo: false,
  },
  {
    nombre: 'Recarga de botellón de 20 L',
    presentacion: 'botellon',
    contenidoMl: 20000,
    unidades: 1,
    // El único precio confirmado por Aquazaku — RN-CAT-08. Es dato semilla,
    // editable desde la UI: un precio en el código es un deploy cada vez que
    // sube el agua.
    precioResidencial: '10000.00',
    precioComercial: '10000.00',
    precioMinimo: '10000.00',
    activo: true,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Insumos de empaque — M4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los dos insumos que el cierre de producción consume POR CÓDIGO.
 *
 * ── Por qué van en el seed y no los carga alguien a mano ────────────────────
 *
 * `INSUMOS_POR_BOTELLON` los nombra en el código del servicio: el cierre busca
 * `TAPA_20L` y `SELLO_BOTELLON` por código exacto y **lanza** si no están. Eso
 * los vuelve parte de la definición del sistema, no datos que cada instalación
 * elige — igual que los tres productos.
 *
 * Sin esto, una base recién migrada tiene el catálogo completo y aun así no
 * puede hacer la operación central del negocio: cerrar el día. El error sería
 * ruidoso y claro (`INSUMO_NO_CARGADO`), pero aparecería recién cuando alguien
 * intentara cerrar, en la planta, con los botellones ya envasados.
 *
 * ── Nacen en CERO y sin equivalencia, a propósito ───────────────────────────
 *
 * El saldo es cuántas unidades hay, y eso nadie lo sabe hasta contarlas: un
 * número inventado acá descuadraría el inventario desde el primer día. La
 * equivalencia por kilo es la medición de planta de la pregunta 37, y mientras
 * siga en `null` la entrada por kilos se rechaza en vez de estimar.
 *
 * El mínimo sí tiene valor: 200 es el acordado para tapas y sellos.
 */
const MINIMO_ACORDADO = 200

const NOMBRE_DE_INSUMO: Record<(typeof INSUMOS_POR_BOTELLON)[number], string> = {
  TAPA_20L: 'Tapa para botellón de 20 L',
  SELLO_BOTELLON: 'Sello termoencogible para botellón',
}

/** Inserta los insumos que el cierre necesita. Idempotente. */
export async function sembrarInsumos(): Promise<number> {
  const insertados = await db
    .insert(insumos)
    .values(
      INSUMOS_POR_BOTELLON.map((codigo) => ({
        codigo,
        nombre: NOMBRE_DE_INSUMO[codigo],
        minimo: MINIMO_ACORDADO,
      })),
    )
    .onConflictDoNothing({ target: insumos.codigo })
    .returning({ codigo: insumos.codigo })

  return insertados.length
}

/**
 * Inserta el catálogo inicial. Idempotente.
 *
 * El código sale de `codigoBase()`, el mismo generador que usa el alta por API
 * (RN-CAT-11). Escribirlo a mano acá dejaría dos fuentes del formato que se
 * separan el día que cambie.
 */
export async function sembrarProductos(): Promise<number> {
  const filas = CATALOGO_INICIAL.map((p) => ({ ...p, codigo: codigoBase(p) }))

  const insertados = await db
    .insert(productos)
    .values(filas)
    .onConflictDoNothing({ target: productos.codigo })
    .returning({ codigo: productos.codigo })

  return insertados.length
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
  await sembrarProductos()
  await sembrarInsumos()


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
  /*
   * ── A DÓNDE vamos a escribir, dicho antes de escribir ─────────────────────
   *
   * El respaldo ya volcó la base local creyendo que volcaba producción: la
   * variable se puso con `export` en otra terminal y el `.env` tomó el control
   * en silencio.
   *
   * Ese script solo LEÍA. Este escribe, y encima usa `DATABASE_URL` mientras el
   * resto del despliegue usa `DATABASE_MIGRATION_URL` — o sea que es todavía
   * más fácil sembrar la base equivocada sin enterarse.
   */
  console.log(`→ sembrando ${describirConexion(process.env.DATABASE_URL ?? '').descripcion}`)

  const entorno = leerEntorno(process.env)

  if (esProblema(entorno)) {
    console.error(`✗ ${entorno.mensaje}`)
    process.exitCode = 1
    return
  }

  const resultado = await sembrar(entorno)

  const sinPrecio = await db
    .select({ codigo: productos.codigo })
    .from(productos)
    .where(and(eq(productos.activo, false), eq(productos.precioMinimo, '0.00')))

  if (!resultado.creado) {
    console.log('· Ya hay un administrador activo: no se creó ninguno. Nada que hacer.')
  } else {
    console.log(`✓ Administrador creado: ${resultado.email}`)
    console.log('  Al entrar por primera vez va a tener que cambiar la contraseña.')
  }

  if (sinPrecio.length > 0) {
    console.log('')
    console.log(`⚠ ${sinPrecio.length} producto(s) esperando precio, desactivados:`)
    for (const p of sinPrecio) console.log(`    ${p.codigo}`)
    console.log('  No se pueden vender hasta que un admin les cargue el precio y los active.')
  }
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
