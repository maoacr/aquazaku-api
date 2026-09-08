/**
 * Auditoría de inmutabilidad de `audit_log` en un schema que no sea `public`.
 *
 * ── Por qué este script existe ──────────────────────────────────────────────
 *
 * La garantía de que `audit_log` es append-only vive en DOS capas (ver
 * `0001_audit_append_only.sql`): un trigger que rechaza UPDATE/DELETE/TRUNCATE
 * a todo el mundo, y permisos reducidos sobre el rol de aplicación
 * (`aquazaku_app` solo tiene SELECT e INSERT — nunca UPDATE ni DELETE).
 *
 * Para `public` esa combinación ya la aplican las migraciones. Para `preview`
 * las migraciones se vuelven a correr con `sed` reemplazando `"public".` por
 * `"preview".`, y se confía en que la misma `GRANT SELECT, INSERT` aterrice
 * sobre `preview.audit_log`. Confiar no es verificar: si alguien edita una
 * migración y se olvida del GRANT, o si el sed se rompe en una línea con un
 * quoting raro, el `preview` puede quedar con un `audit_log` REESCRIBIBLE.
 *
 * Este script es la prueba: abre una conexión como `aquazaku_app` con
 * `search_path = <schema>` y consulta `has_table_privilege` para UPDATE y
 * DELETE sobre `<schema>.audit_log`. Si Postgres dice `false` para ambos, el
 * schema pasa (exit 0). Si dice `true` para cualquiera, el GRANT no se
 * replicó y el deploy aborta (exit 1).
 *
 * ── Por qué `has_table_privilege` y no un `UPDATE ... WHERE FALSE` ──────────
 *
 * El camino tentador — correr un UPDATE inocuo y mirar si Postgres devuelve
 * `permission denied` — tropieza con el trigger: `reject_audit_mutation` es
 * un BEFORE STATEMENT trigger, se ejecuta ANTES del chequeo de permisos, y
 * siempre aborta la operación con `42501 insufficient_privilege` y un mensaje
 * propio (`audit_log es append-only: ...`). Eso significa que la prueba
 * distingue DOS estados distintos como si fueran el mismo:
 *
 *   (a) `aquazaku_app` SIN UPDATE → trigger fires → "append-only" (también 42501)
 *   (b) `aquazaku_app` CON UPDATE → trigger fires → "append-only" (también 42501)
 *
 * El trigger oculta la verdad del GRANT. `has_table_privilege` consulta la
 * tabla de permisos directamente (lo que `information_schema` ve), sin
 * ejecutar la operación, así que distingue (a) de (b) sin ambigüedad.
 *
 * El trigger sigue siendo defensa en profundidad (un sysadmin que desactive
 * el trigger queda bloqueado por la otra capa, y viceversa). Este script
 * audita la capa de permisos, que es la que depende de la migración con sed.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *
 *   pnpm tsx scripts/auditar-permisos-preview.ts --schema=preview
 *   AQUAZAKU_ENV=preview pnpm tsx scripts/auditar-permisos-preview.ts
 *
 * Round 2: el deploy del 8-sep-2026 triggeró este script via `db:sync-preview`
 * después de mergear preview-environments — el script detectó que `0015_audit_revoke`
 * no estaba aplicada en `public` de Supabase porque las migraciones previas corrieron
 * antes de que el archivo existiera. El siguiente deploy la aplica.
 *
 * Si `--schema` está ausente, default `preview` — es el único caso que nos
 * importa (en `public` la auditoría es trivial porque las migraciones acaban
 * de correr).
 */

import { exit } from 'node:process'
import postgres from 'postgres'
import { describirConexion } from './describir-conexion'

const args = process.argv.slice(2)
const schemaArg = args.find((a) => a.startsWith('--schema='))
const schema = schemaArg ? schemaArg.split('=')[1] : 'preview'

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
  console.error(
    `✗ --schema=${schema} no es un identificador PostgreSQL válido\n` +
      '  Solo letras, números y guión bajo, empezando con letra o guión bajo.',
  )
  exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error(
    '✗ Falta DATABASE_URL.\n' +
      '  El script se conecta con el rol de la aplicación (aquazaku_app).\n' +
      '  Copiá .env.example a .env o exportá la variable antes de correrlo.',
  )
  exit(1)
}

/*
 * ── `connection: { search_path }` y no `options: '-c ...'` ─────────────────
 *
 * `postgres.js` no acepta la sintaxis libpq de `options: '-c search_path=...'`
 * (esa es la API de `node-postgres`). Los parámetros de arranque van bajo
 * `connection`, igual que en `src/db/client.ts` y `drizzle/migrate.ts`. Si
 * alguien lo cambia a `options`, el script SILENCIOSAMENTE va a conectar con
 * `search_path` default y va a auditar `public.audit_log` — y va a pasar
 * aunque `preview.audit_log` esté roto.
 *
 * `onnotice: () => {}` silencia los NOTICE de Postgres (típicamente
 * "CREATE TABLE" cuando la conexión se inicializa); sin esto, el output se
 * mezcla con el veredicto y confunde al ojo.
 */
const client = postgres(url, {
  max: 1,
  onnotice: () => {},
  connection: { search_path: schema },
})

try {
  /*
   * Que la cadena SEA una cadena: ya lo hacen otros scripts del repo, lo
   * repetimos acá porque un `URL inválida` de node-postgres no menciona ni
   * la variable ni qué se esperaba.
   */
  new URL(url)

  console.log(
    `→ auditando ${describirConexion(url).descripcion} → schema "${schema}"`,
  )

  /*
   * El rol `aquazaku_app` se referencia por nombre — no por `current_user` —
   * porque este script TIENE que correr como el rol de la app para ser
   * honesto. Si `current_user` fuera `aquazaku` (el dueño), Postgres mentiría
   * con `true` para todo (el dueño tiene todos los privilegios por defecto).
   *
   * `has_table_privilege` consulta `information_schema.role_table_grants`:
   * lo que la GRANT y los ALTER DEFAULT PRIVILEGES dejaron plantado en el
   * catálogo, sin pasar por el evaluador de queries ni por los triggers.
   */
  const resultado = await client.unsafe<{ puede_update: boolean; puede_delete: boolean }[]>(
    `SELECT
       has_table_privilege('aquazaku_app', 'audit_log', 'UPDATE') AS puede_update,
       has_table_privilege('aquazaku_app', 'audit_log', 'DELETE') AS puede_delete`,
  )
  const fila = resultado[0]

  if (!fila) {
    console.error(
      `✗ No pude leer los privilegios sobre ${schema}.audit_log — la consulta no devolvió filas.`,
    )
    exit(1)
  }

  if (fila.puede_update || fila.puede_delete) {
    const concedidos: string[] = []
    if (fila.puede_update) concedidos.push('UPDATE')
    if (fila.puede_delete) concedidos.push('DELETE')
    console.error(
      `✗ PELIGRO: aquazaku_app tiene ${concedidos.join(' + ')} sobre ${schema}.audit_log.`,
    )
    console.error(
      '  Las migraciones no replicaron el GRANT selectivo (SELECT, INSERT). Deploy abortado.',
    )
    exit(1)
  }

  console.log(`✓ audit_log en "${schema}" es append-only para aquazaku_app.`)
  exit(0)
} catch (err) {
  console.error('✗ Error inesperado:', err)
  exit(1)
} finally {
  await client.end()
}
