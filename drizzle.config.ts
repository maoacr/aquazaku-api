import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit corre DDL, así que se conecta con el rol DUEÑO
 * (`DATABASE_MIGRATION_URL`), nunca con el de la aplicación.
 *
 * No lee `@/lib/env` a propósito: drizzle-kit se invoca desde la CLI, donde el
 * resto del contrato de entorno (secreto de auth, SMTP…) no aplica y exigirlo
 * solo estorbaría.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
  strict: true,
  verbose: true,
})
