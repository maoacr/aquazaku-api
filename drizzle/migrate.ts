import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { describirConexion } from '../scripts/describir-conexion'

/**
 * Aplica las migraciones pendientes.
 *
 * Se conecta con el rol DUEÑO (`DATABASE_MIGRATION_URL`), el único que puede
 * hacer DDL. No importa `@/lib/env` a propósito: correr una migración no debería
 * exigir que estén definidos el secreto de auth ni el SMTP.
 *
 *   pnpm db:migrate                       # aplica sobre el schema `public`
 *   pnpm db:migrate --test                # idem, pero sobre la base de tests
 *   pnpm db:migrate --schema=preview      # crea el schema y aplica ahí adentro
 *
 * ── Por qué existe `--schema` ───────────────────────────────────────────────
 *
 * Los preview environments necesitan SU PROPIA copia de las tablas para no
 * pisarse entre sí ni pisar a producción. La opción de crear otra base es
 * cara (Supabase cobra por base); la opción de compartir schema es
 * peligrosa (los datos se mezclan). La intermedia es un schema separado en la
 * MISMA base: barato, aislado, y el código no se entera porque el pool le
 * pone `search_path = preview` (ver `src/db/client.ts`).
 *
 * Lo que hace `--schema`:
 *   1. Crea el schema destino si no existe (y da permisos al rol dueño).
 *   2. Copia las migraciones a un tempdir pasándolas por `sed` para reemplazar
 *      cada `"public".` por `"<schema>".` — así las FK y los CREATE TYPE
 *      apuntan al schema correcto.
 *   3. Pone `search_path` en la conexión al schema destino (con `public`
 *      detrás para no perder `gen_random_uuid()` y compañía), para que las
 *      referencias NO calificadas (`CREATE TABLE "ventas"`, `ALTER TABLE "foo"`)
 *      también resuelvan ahí.
 *   4. Cambia el nombre del journal a `__drizzle_migrations_<schema>` y lo pone
 *      adentro del schema destino — sin esto, Drizzle ve el journal de `public`
 *      y se cree que las migraciones del schema nuevo ya están aplicadas.
 *
 * El caso `targetSchema === 'public'` mantiene el comportamiento histórico al
 * pie de la letra: journal en `drizzle.__drizzle_migrations`, sin tempdir, sin
 * tocar `search_path`. Cualquier despliegue existente no nota la diferencia.
 */
const args = process.argv.slice(2)
const useTestDb = args.includes('--test')
const schemaArg = args.find((a) => a.startsWith('--schema='))
// `schemaArg.split('=')[1]` existe cuando hay un `=` en el flag; sin `=`, el
// argumento es `--schema` pelado y se ignora (cae al default 'public').
const targetSchema: string = schemaArg?.includes('=')
  ? (schemaArg.split('=')[1] ?? 'public')
  : 'public'

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(targetSchema)) {
  console.error(
    `✗ --schema=${targetSchema} no es un identificador PostgreSQL válido\n` +
      '  Solo letras, números y guión bajo, empezando con letra o guión bajo.',
  )
  process.exit(1)
}

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
  /*
   * El aviso del `export` no es un detalle. Una variable exportada le GANA al
   * archivo de `--env-file`, así que alguien puede crear un
   * `.env.produccion.local` perfecto y seguir viendo el valor viejo sin
   * entender por qué. Pasó dos veces seguidas, con el mismo valor.
   */
  console.error(
    `✗ ${faltante} no es una cadena de conexión válida.\n` +
      `  Recibí: ${url}\n` +
      '  Se ve así: postgresql://usuario:contraseña@host:5432/postgres\n\n' +
      `  Si exportaste ${faltante} en esta terminal, ESE valor le gana al archivo.\n` +
      `  Sacala con:  unset ${faltante}`,
  )
  process.exit(1)
}

// `max: 1` es requisito del migrador: las migraciones tienen que correr
// secuencialmente sobre una única conexión.
//
// Para `--schema=<otro>`, fijamos `search_path` al schema destino desde el
// arranque: las migraciones usan identificadores SIN calificar para `CREATE
// TABLE` y `ALTER TABLE` (solo los `CREATE TYPE` y las `REFERENCES` son
// explícitos con `"public".`), y sin search_path crearían todo en `public`.
//
// `public` queda SEGUNDO en el path, no primero: las funciones como
// `gen_random_uuid()` (de pgcrypto) y los tipos como `citext` viven en `public`
// desde la migración 0000, y sin `public` en el path fallan con "function does
// not exist". El destino va primero porque es donde queremos que aterricen las
// tablas no calificadas.
//
// Para `public`, no tocamos search_path — la conexión con search_path default
// (`$user, public`) ya resuelve las referencias no calificadas al lugar
// correcto, y no queremos romper el comportamiento histórico.
const client = postgres(url, {
  max: 1,
  onnotice: () => {},
  ...(targetSchema === 'public'
    ? {}
    : { connection: { search_path: `${targetSchema},public` } }),
})

/*
 * ── Por qué un tempdir y no `migrationsFolder` apuntando a la carpeta real ─
 *
 * Drizzle lee los .sql de disco con `readMigrationFiles`. No hay manera de
 * pasarle el contenido en memoria. Si apuntáramos a la carpeta real sin sed,
 * los `REFERENCES "public"."users"` apuntarían al schema equivocado.
 *
 * La alternativa sería editar las 15 migraciones para que todas las
 * referencias sean dinámicas — un cambio invasivo y que rompe el journal de
 * despliegues existentes. El tempdir mantiene los originales intactos y deja
 * la transformación local al comando que la necesita.
 */
function prepararCarpetaSed(targetSchema: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aquazaku-migrations-'))
  mkdirSync(join(tmpDir, 'meta'), { recursive: true })

  const journalSrc = './src/db/migrations/meta/_journal.json'
  copyFileSync(journalSrc, join(tmpDir, 'meta', '_journal.json'))

  const journal = JSON.parse(readFileSync(journalSrc, 'utf8')) as {
    entries: { tag: string }[]
  }

  for (const entry of journal.entries) {
    const src = `./src/db/migrations/${entry.tag}.sql`
    const sql = readFileSync(src, 'utf8')
    // Solo `"public".` (con el punto pegado) para no romper literales ni
    // comentarios donde aparezca la palabra "public" suelta.
    const sedeado = sql.replaceAll('"public".', `"${targetSchema}".`)
    writeFileSync(join(tmpDir, `${entry.tag}.sql`), sedeado, 'utf8')
  }

  return tmpDir
}

let tmpMigrationsDir: string | null = null

try {
  /*
   * A QUÉ base, con usuario y host, antes de tocar nada. Solo el nombre de la
   * base no alcanza: la de producción y la local pueden llamarse igual, y
   * migrar la equivocada no avisa — deja las dos a medias.
   */
  console.log(`→ migrando ${describirConexion(url).descripcion} → schema "${targetSchema}"`)

  if (targetSchema !== 'public') {
    /*
     * Crear el schema y darle permisos al rol de la app ANTES de cualquier
     * `CREATE TABLE` (las migraciones no lo hacen — `public` venía pre-creado).
     *
     * El `GRANT USAGE, CREATE` es lo que permite que el pool de runtime (con
     * search_path = preview) pueda crear tablas temporales si alguna migración
     * lo necesitara, y reserve el nombre del schema. Sin esto, el schema existe
     * pero la app entra con `permission denied for schema preview`.
     */
    await client.unsafe(
      `CREATE SCHEMA IF NOT EXISTS "${targetSchema}";
       GRANT USAGE, CREATE ON SCHEMA "${targetSchema}" TO aquazaku;`,
    )
    tmpMigrationsDir = prepararCarpetaSed(targetSchema)
  }

  const migrationsFolder = tmpMigrationsDir ?? './src/db/migrations'

  /*
   * ── Journal por ambiente ────────────────────────────────────────────────
   *
   * Sin un nombre distinto, el journal queda en `drizzle.__drizzle_migrations`
   * — el MISMO que usa `public`. Si ya corrimos `db:migrate` en `public`, el
   * journal tiene todas las migraciones marcadas como aplicadas; al correr
   * `db:migrate --schema=<otro>` Drizzle leería ese journal y creería que las
   * migraciones del schema nuevo ya están aplicadas, sin aplicar nada.
   *
   * El check es `targetSchema !== 'public'` (no `=== 'preview'`): cualquier
   * schema alternativo merece su propio journal, no solo el de producción. Un
   * `--schema=preview_test` en una corrida de tests no debe contaminar al
   * `--schema=preview` de la corrida siguiente.
   *
   * La tabla va ADENTRO del schema destino (migrationsSchema = targetSchema)
   * para que un `DROP SCHEMA preview CASCADE` se lleve el journal también —
   * recrear el ambiente no debería requerir limpieza manual.
   */
  const migrationsTable =
    targetSchema === 'public'
      ? '__drizzle_migrations'
      : `__drizzle_migrations_${targetSchema}`
  const migrationsSchema =
    targetSchema === 'public' ? undefined : targetSchema

  await migrate(drizzle(client), {
    migrationsFolder,
    migrationsTable,
    migrationsSchema,
  })

  console.log('✓ migraciones aplicadas')
} catch (err) {
  console.error('✗ falló la migración:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  if (tmpMigrationsDir) {
    rmSync(tmpMigrationsDir, { recursive: true, force: true })
  }
  await client.end()
}