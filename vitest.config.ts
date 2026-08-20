import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Los tests tocan la base. Si corren en paralelo se pisan las tablas entre
    // archivos, así que van en un solo proceso hasta que cada suite gestione su
    // propio esquema aislado.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts'],
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
