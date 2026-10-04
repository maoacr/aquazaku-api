import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/lib/env'
import * as schema from './schema'
import { searchPathFor } from './search-path'

/**
 * El pool arranca cada conexión con el `search_path` del ambiente.
 *
 * Postgres resuelve cualquier nombre no calificado (`from ventas`) contra este
 * path, así el código de queries no tiene que saber en qué schema está.
 *
 * La decisión vive en `search-path.ts`, compartida con el migrador: antes cada
 * uno la tomaba por su cuenta, y en staging eso hacía que `pnpm db:migrate`
 * tocara `public` mientras la app servía `preview`.
 */
const searchPath = searchPathFor(env.AQUAZAKU_ENV)

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

/**
 * `db` o una transacción abierta.
 *
 * Vive acá porque «qué es una transacción de esta base» es de la capa de
 * acceso, no de un módulo de dominio. Estaba declarado DOS veces —en
 * `stock/saldo.ts` y en `insumos/saldo.ts`, idénticos— y el resto del sistema
 * importaba el de `stock`, que no tiene por qué ser dueño de esto. Los dos
 * siguen reexportándolo, así que ningún import existente se entera.
 */
export type Transaccion = Parameters<Parameters<DB['transaction']>[0]>[0]
export type Ejecutor = DB | Transaccion

/**
 * Abre transacción solo si el ejecutor no es ya una.
 *
 * Es lo que permite que una función sirva tanto suelta como adentro de una
 * transacción ajena, sin que quien la llama tenga que saber cuál de las dos
 * está pasando.
 */
export function enTransaccion<T>(
  ejecutor: Ejecutor,
  fn: (tx: Ejecutor) => Promise<T>,
): Promise<T> {
  return 'transaction' in ejecutor ? ejecutor.transaction((tx) => fn(tx)) : fn(ejecutor)
}

/** Cierra el pool. Solo para el shutdown del servidor y el teardown de tests. */
export async function closeDb(): Promise<void> {
  await queryClient.end()
}

/** Reexportada: quien ya la importaba de acá no se entera del movimiento. */
export { searchPathFor } from './search-path'
