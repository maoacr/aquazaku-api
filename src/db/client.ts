import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/lib/env'
import * as schema from './schema'

/**
 * El pool arranca cada conexión con el `search_path` correspondiente al
 * ambiente: `preview` para `AQUAZAKU_ENV=preview`, `public` para los demás.
 * Postgres resuelve cualquier nombre no calificado (`from ventas`) contra
 * este path, así el código de queries no tiene que saber en qué schema está.
 */
const searchPath =
  env.AQUAZAKU_ENV === 'preview' ? 'preview' : 'public'

/**
 * Conexión de la aplicación.
 *
 * Usa `DATABASE_URL`, que apunta al rol `aquazaku_app` — sin permisos de DDL y
 * sin UPDATE ni DELETE sobre `audit_log`. Las migraciones NO pasan por acá:
 * usan `DATABASE_MIGRATION_URL` con el rol dueño.
 */
const queryClient = postgres(env.DATABASE_URL, {
  // Los tests abren y cierran la conexión seguido; un pool chico alcanza y
  // evita dejar sockets colgados entre suites.
  max: env.NODE_ENV === 'test' ? 1 : 10,
  onnotice: env.NODE_ENV === 'test' ? () => {} : undefined,
  // `postgres.js` no acepta un campo top-level `options` (es libpq-style de
  // node-postgres). Los parámetros de arranque — incluido `search_path` —
  // van bajo `connection`, que `StartupMessage()` envía al server como
  // key/value. Ver `postgres/src/connection.js:996`.
  connection: { search_path: searchPath },
})

export const db = drizzle(queryClient, { schema })

export type DB = typeof db

/** Cierra el pool. Solo para el shutdown del servidor y el teardown de tests. */
export async function closeDb(): Promise<void> {
  await queryClient.end()
}
