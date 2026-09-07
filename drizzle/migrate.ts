import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { describirConexion } from '../scripts/describir-conexion'
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

const faltante = useTestDb ? 'DATABASE_MIGRATION_URL_TEST' : 'DATABASE_MIGRATION_URL'

if (!url) {
  console.error(
    `✗ Falta ${faltante}.\n` +
      '  Para la base local: copiá .env.example a .env y completalo.\n' +
      '  Para producción:    pnpm db:migrate:prod (lee .env.produccion.local)',
  )
  process.exit(1)
}

/*
 * ── Que la cadena SEA una cadena ──────────────────────────────────────────
 *
 * Sin esto, `postgres()` tira un `TypeError: Invalid URL` con un stack de Node
 * que no menciona ni la variable ni qué se esperaba. Pasó de verdad: se pegó un
 * marcador de posición —`LA-DEL-5432`— y el error no ayudaba a verlo.
 *
 * El mensaje tiene que decir QUÉ variable, QUÉ recibió y CÓMO se ve la buena.
 */
try {
  new URL(url)
} catch {
  console.error(
    `✗ ${faltante} no es una cadena de conexión válida.\n` +
      `  Recibí: ${url}\n` +
      '  Se ve así: postgresql://usuario:contraseña@host:5432/postgres',
  )
  process.exit(1)
}

// `max: 1` es requisito del migrador: las migraciones tienen que correr
// secuencialmente sobre una única conexión.
const client = postgres(url, { max: 1, onnotice: () => {} })

try {
  /*
   * A QUÉ base, con usuario y host, antes de tocar nada. Solo el nombre de la
   * base no alcanza: la de producción y la local pueden llamarse igual, y
   * migrar la equivocada no avisa — deja las dos a medias.
   */
  console.log(`→ migrando ${describirConexion(url).descripcion}`)

  await migrate(drizzle(client), { migrationsFolder: './src/db/migrations' })

  console.log('✓ migraciones aplicadas')
} catch (err) {
  console.error('✗ falló la migración:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await client.end()
}
