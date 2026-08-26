import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/db/schema'

/**
 * Utilidades de base para los tests. Solo se importan desde tests.
 */

/** Códigos SQLSTATE que usamos en aserciones. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  /** Lo devuelven tanto un GRANT faltante como nuestro trigger de audit_log. */
  INSUFFICIENT_PRIVILEGE: '42501',
} as const

type PgErrorInfo = { code: string; message: string; constraint: string | undefined }

/**
 * Extrae el error real de Postgres.
 *
 * Drizzle envuelve todo en un `DrizzleQueryError` cuyo mensaje es el SQL que
 * falló, no la causa. Asertar contra ese texto es frágil; el SQLSTATE de la
 * causa es estable y dice exactamente qué se violó.
 */
export async function pgErrorOf(operacion: Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await operacion
  } catch (err) {
    const causa = (err as { cause?: unknown }).cause ?? err
    const pg = causa as { code?: string; message?: string; constraint_name?: string }

    if (!pg.code) throw err

    return {
      code: pg.code,
      message: pg.message ?? '',
      constraint: pg.constraint_name,
    }
  }

  throw new Error('Se esperaba que la operación fallara, pero terminó bien')
}

/**
 * Conexión con el rol DUEÑO. Los tests la necesitan para dos cosas que la
 * aplicación no puede —ni debe— hacer: limpiar `audit_log` entre suites, y
 * comprobar que los triggers también frenan al dueño.
 */
export function ownerSql() {
  const url = process.env.DATABASE_MIGRATION_URL
  if (!url) throw new Error('DATABASE_MIGRATION_URL no está definida en el entorno de tests')
  return postgres(url, { max: 1, onnotice: () => {} })
}

/**
 * Conexión cruda con el rol de la APLICACIÓN, sin pasar por Drizzle. Sirve para
 * verificar permisos a nivel Postgres, que es donde viven de verdad.
 */
export function appSql() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL no está definida en el entorno de tests')
  return postgres(url, { max: 1, onnotice: () => {} })
}

/**
 * Pool con VARIAS conexiones reales, para probar concurrencia de verdad.
 *
 * El pool de la aplicación corre con `max: 1` en tests, a propósito: evita
 * sockets colgados entre suites. Pero con una sola conexión, veinte descuentos
 * lanzados a la vez **se encolan**, corren uno detrás de otro y el test pasa sin
 * haber probado nada.
 *
 * Un test de concurrencia sobre un pool de una conexión es un test de
 * secuencialidad con nombre engañoso. Por eso este abre las suyas.
 *
 * Quien lo use tiene que cerrarlo: `await pool.end()`.
 */
export function poolConcurrente(conexiones: number) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL no está definida en el entorno de tests')

  const cliente = postgres(url, { max: conexiones, onnotice: () => {} })
  return { db: drizzle(cliente, { schema }), cerrar: () => cliente.end() }
}

/** Tablas en orden seguro para truncar (las hijas primero por las FK). */
const TABLAS = [
  'movimientos_agua',
  'cierres_produccion',
  'movimientos_insumo',
  'insumos',
  'movimientos_stock',
  'lotes',
  'productos',
  'user_roles',
  'sessions',
  'accounts',
  'verifications',
  'users',
  'roles',
] as const

/**
 * Deja la base de tests vacía.
 *
 * `audit_log` merece párrafo aparte: los triggers append-only rechazan también
 * el TRUNCATE, así que hay que desactivarlos explícitamente y volver a
 * prenderlos. Solo el dueño de la tabla puede hacerlo — el rol de la aplicación
 * no, por diseño.
 *
 * Que limpiar la bitácora en un test cueste este ritual es exactamente la señal
 * de que la protección funciona.
 */
export async function resetDb(): Promise<void> {
  const sql = ownerSql()
  try {
    await sql.unsafe(`TRUNCATE ${TABLAS.join(', ')} RESTART IDENTITY CASCADE`)

    await sql.unsafe('ALTER TABLE audit_log DISABLE TRIGGER USER')
    await sql.unsafe('TRUNCATE audit_log RESTART IDENTITY')
    await sql.unsafe('ALTER TABLE audit_log ENABLE TRIGGER USER')
  } finally {
    await sql.end()
  }
}
