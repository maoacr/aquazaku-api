import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/**
 * Aplica las migraciones pendientes.
 *
 * Se conecta con el rol DUEÑO (`DATABASE_MIGRATION_URL`), el único que puede
 * hacer DDL. No importa `@/lib/env` a propósito: correr una migración no debería
 * exigir que estén definidos el secreto de auth ni el SMTP.
 *
 *   pnpm db:migrate                       # aplica sobre la base de desarrollo
 *   pnpm db:migrate --test                # aplica sobre la base de tests
 */
const useTestDb = process.argv.includes('--test')

const url = useTestDb
  ? process.env.DATABASE_MIGRATION_URL_TEST
  : process.env.DATABASE_MIGRATION_URL

if (!url) {
  const faltante = useTestDb ? 'DATABASE_MIGRATION_URL_TEST' : 'DATABASE_MIGRATION_URL'
  console.error(`✗ Falta ${faltante}. Copiá .env.example a .env y completalo.`)
  process.exit(1)
}

// `max: 1` es requisito del migrador: las migraciones tienen que correr
// secuencialmente sobre una única conexión.
const client = postgres(url, { max: 1, onnotice: () => {} })

try {
  const destino = new URL(url).pathname.slice(1)
  console.log(`→ migrando ${destino}`)

  await migrate(drizzle(client), { migrationsFolder: './src/db/migrations' })

  console.log('✓ migraciones aplicadas')
} catch (err) {
  console.error('✗ falló la migración:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await client.end()
}
