import { execSync } from 'node:child_process'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Integración del runner de migraciones con `--schema=<nombre>`.
 *
 * ── Qué prueba esto que un test unitario no prueba ─────────────────────────
 *
 * El sed, el `search_path` y el journal por ambiente son tres mecanismos que
 * tienen que funcionar JUNTOS para que un schema paralelo a `public` termine
 * con todas las tablas adentro y todas las FK apuntando para el mismo lado.
 * Si solo uno falla, la tabla queda en `public`, o las FK apuntan a `public`,
 * o Drizzle cree que las migraciones ya están aplicadas y no corra ninguna.
 * Ningún test unitario atrapa esa interacción; hay que pegarle a Postgres.
 *
 * ── Por qué se hace con un schema efímero y no con `preview` ────────────────
 *
 * El schema `preview` es de producción: este test no debería tocarlo aunque
 * pasara por encima de un `DROP`. Cada corrida usa un nombre con timestamp
 * para que dos suites no se pisen, y `afterAll` lo tira con `CASCADE` (que
 * se lleva el journal incluido — eso valida además que el journal quedó
 * ADENTRO del schema, como se diseñó).
 *
 * ── Por qué se invoca `pnpm` y no se importa la función ────────────────────
 *
 * `drizzle/migrate.ts` no exporta nada: es un script de shell envuelto en
 * Node. La única manera de probarlo es mediante el proceso real, así que
 * `execSync` con el comando que un humano tipearía.
 */
describe('migrate --schema=<nombre>', () => {
  // Nombre único por corrida: si dos suites corren en paralelo o una quedó
  // a medias, no se pisan entre sí ni con un schema de un humano.
  const schema = `preview_test_${Date.now()}`

  const databaseUrl = process.env.DATABASE_MIGRATION_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_MIGRATION_URL no está definida — vitest.config.ts la setea por default',
    )
  }

  afterAll(async () => {
    // CASCADE se lleva también `__drizzle_migrations_<schema>`: confirma que
    // el journal está adentro del schema (no quedó huérfano en `drizzle`).
    const client = postgres(databaseUrl)
    await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await client.end()
  })

  it('crea el schema, aplica todas las migraciones adentro y deja las tablas ahí', async () => {
    execSync(`pnpm db:migrate --schema=${schema}`, {
      // `process.env` ya trae `DATABASE_MIGRATION_URL` (vitest.config.ts la
      // mapea desde `DATABASE_MIGRATION_URL_TEST` con fallback al local).
      env: { ...process.env },
      stdio: 'pipe',
    })

    const client = postgres(databaseUrl)
    try {
      // `ventas` nace en la migración 0007. Si está, las 6 anteriores también.
      // Es la tabla más barata de verificar que NO está en `public`: cualquier
      // fuga del sed terminaría creando en `public` y este EXISTS daría true
      // ahí, no acá.
      const filas = await client.unsafe<{ existe: boolean }[]>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = '${schema}' AND table_name = 'ventas'
        ) AS existe
      `)
      expect(filas[0]?.existe).toBe(true)
    } finally {
      await client.end()
    }
  })

  /*
   * ── El journal tiene que quedar ADENTRO del schema ──────────────────────
   *
   * Si quedó en `drizzle.__drizzle_migrations` (el de `public`), dos cosas
   * malas pasan: (1) otro `--schema` lo lee y se vuelve loco, y (2) un
   * `DROP SCHEMA preview CASCADE` no se lo lleva y deja basura.
   *
   * Buscar la tabla explícitamente en el schema prueba que se creó donde
   * debía y no se acumuló en el schema default.
   */
  it('deja el journal adentro del schema destino, no en `drizzle`', async () => {
    const client = postgres(databaseUrl)
    try {
      const enDestino = await client.unsafe<{ existe: boolean }[]>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = '${schema}'
            AND table_name LIKE '__drizzle_migrations_%'
        ) AS existe
      `)
      expect(enDestino[0]?.existe).toBe(true)

      const enDrizzle = await client.unsafe<{ existe: boolean }[]>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'drizzle'
            AND table_name = '__drizzle_migrations_${schema}'
        ) AS existe
      `)
      expect(enDrizzle[0]?.existe).toBe(false)
    } finally {
      await client.end()
    }
  })

  /*
   * ── El rol de la app tiene que poder LEER las tablas del schema ─────────
   *
   * Sin el `GRANT USAGE ON SCHEMA <x> TO aquazaku_app` (y los `ALTER DEFAULT
   * PRIVILEGES` para tablas/sequences futuras), el pool de runtime entra
   * con `permission denied for schema <x>` apenas intente la primera SELECT.
   *
   * Este test se conecta como `aquazaku_app` (el rol que usa el runtime, no
   * el dueño) y ejecuta `SELECT 1 FROM ventas LIMIT 0`. El `LIMIT 0` evita
   * traer filas — solo pedimos el permiso de lectura sobre la tabla. Si el
   * GRANT falta, postgres tira `permission denied for table ventas`.
   *
   * Por qué `ventas`: nace en 0007 y la app la toca constantemente. Si está
   * legible, las GRANTs de las migraciones se aplicaron al schema correcto
   * (no se quedaron apuntando a `public`).
   *
   * Skip si `DATABASE_URL` no está seteada con credenciales de `aquazaku_app`
   * (CI puede apuntar a un rol distinto): el test no es bloqueante, el GRANT
   * ya está en migrate.ts.
   */
  const appUrl = process.env.DATABASE_URL
  /*
   * El check es sobre el prefijo del usuario en la URL, no un `includes` sobre
   * la palabra "aquazaku_app" en cualquier lado: si en el futuro alguien define
   * `DATABASE_URL` con `search_path=aquazaku_app,...` (u otro caso similar),
   * `includes` da true sin que haya un rol real para conectarse.
   */
  const skipSinAppUrl = !appUrl || !appUrl.startsWith('postgres://aquazaku_app:')

  it.skipIf(skipSinAppUrl)(
    'aquazaku_app puede SELECTear tablas del schema destino',
    async () => {
      const client = postgres(appUrl!, {
        // El rol de la app no tiene `search_path` por default — se lo fijamos
        // explícito para que `ventas` resuelva al schema del `it` anterior.
        connection: { search_path: `${schema},public` },
        onnotice: () => {},
      })
      try {
        // `LIMIT 0`: pide el permiso de SELECT y devuelve 0 filas. Si el
        // GRANT para `aquazaku_app` falta, esto tira `permission denied`.
        await client.unsafe('SELECT 1 FROM "ventas" LIMIT 0')
      } finally {
        await client.end()
      }
    },
  )
})