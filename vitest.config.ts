import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Los tests corren SIEMPRE contra `aquazaku_test`, que se trunca entre suites.
 * Los valores por defecto son los del entorno local documentado en
 * /empezar/entorno-local/ — credenciales de una base descartable, no secretos.
 * En CI se sobrescriben por variables de entorno.
 */
const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.DATABASE_URL_TEST ??
    'postgres://aquazaku_app:aquazaku_app@localhost:5432/aquazaku_test',
  DATABASE_MIGRATION_URL:
    process.env.DATABASE_MIGRATION_URL_TEST ??
    'postgres://aquazaku:aquazaku@localhost:5432/aquazaku_test',
  BETTER_AUTH_SECRET: 'test-secret-solo-para-tests-no-usar-en-produccion',
  BETTER_AUTH_URL: 'http://localhost:3001',
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: testEnv,
    // Los tests tocan la base. Si corren en paralelo se pisan las tablas entre
    // archivos, así que van en un solo proceso hasta que cada suite gestione su
    // propio esquema aislado.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        // Helpers que solo usan los tests: no son código de producción.
        'src/test/**',
        // Entrypoint del proceso: abre un socket y registra señales. Testearlo
        // sería testear a Node, no a Aquazaku. La lógica vive en app.ts, que sí
        // se mide.
        'src/server.ts',
        // Declaración de tablas, sin ramas ni lógica. Su correctitud la prueban
        // los tests que corren contra la base de verdad, no un porcentaje.
        'src/db/schema.ts',
      ],
      thresholds: {
        // Gate global del proyecto (spec §12).
        lines: 70,
        functions: 70,
        branches: 65,
        // authz/ es el corazón del RBAC: se le exige más que al resto.
        'src/modules/authz/**': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
