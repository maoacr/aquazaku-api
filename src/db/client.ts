import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/lib/env'
import * as schema from './schema'

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
})

export const db = drizzle(queryClient, { schema })

export type DB = typeof db

/** Cierra el pool. Solo para el shutdown del servidor y el teardown de tests. */
export async function closeDb(): Promise<void> {
  await queryClient.end()
}
