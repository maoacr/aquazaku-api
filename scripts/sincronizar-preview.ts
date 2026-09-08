/**
 * Wrapper post-deploy de producción: sincroniza el schema `preview` con `public`.
 *
 * ── Por qué este script existe ──────────────────────────────────────────────
 *
 * Cada vez que se mergea algo a `main`, Railway redeploya producción con el
 * release command `pnpm db:migrate && pnpm db:sync-preview && pnpm start`. El
 * `db:migrate` aplica las migraciones nuevas al schema `public`; este script se
 * encarga de que `preview` (donde corren los staging de las PRs de Vercel)
 * reciba las MISMAS migraciones. Sin esto, la próxima PR abriría un preview
 * contra un schema viejo y las tablas de las migraciones nuevas simplemente no
 * existirían.
 *
 * ── Por qué dos pasos en vez de uno ─────────────────────────────────────────
 *
 * `db:migrate --schema=preview` corre las migraciones con sed reemplazando
 * `"public".` por `"preview".`, pero confiar en que el sed y los GRANTs
 * quedaron bien plantados no es verificar. Después de la migración se corre
 * la auditoría de permisos sobre `preview.audit_log` — el mismo script que ya
 * usa T3 para validar previews. Si la auditoría falla, el deploy aborta:
 * la decisión operativa es "nada falla para pasar a producción".
 *
 * El orden importa: primero la migración (sin tablas no se puede auditar
 * nada) y después la auditoría. Si la auditoría falla, las tablas YA están
 * aplicadas pero el proceso sale con código no-cero y Railway marca el
 * deploy como roto. La tabla queda hasta que alguien la corrija y vuelva a
 * correr; el schema no se revierte solo.
 *
 * ── Por qué `spawnSync` y no `import` directo ───────────────────────────────
 *
 * `drizzle/migrate.ts` y `scripts/auditar-permisos-preview.ts` no son módulos
 * reusables: son scripts de shell envueltos en Node, sin exports. La forma
 * honesta de invocarlos es como procesos, con `stdio: 'inherit'` para que el
 * output aparezca tal cual en el log de Railway — si la migración falla
 * porque una FK quedó apuntando al schema equivocado, hay que ver el SQL del
 * fallo, no un wrapper que lo oculte.
 *
 * `pnpm db:migrate` corre el script con el cwd del package (la raíz de `api/`);
 * `process.cwd()` del subproceso se hereda automáticamente.
 */

import { spawnSync } from 'node:child_process'

/*
 * ── Sin `shell: true` ni quoting mágico ────────────────────────────────────
 *
 * Los argumentos van como array: `'preview'` no se interpreta como flag de
 * pnpm ni como wildcard de la shell. Si en el futuro alguien agrega un valor
 * con espacios (no debería, pero...), `shell: true` lo rompería silencioso.
 */
const migrate = spawnSync('pnpm', ['db:migrate', '--schema=preview'], {
  stdio: 'inherit',
})

/*
 * `migrate.status` es `null` si el subproceso fue terminado por una señal
 * (SIGTERM, OOM kill, etc.) en vez de salir con código. El fallback a `1`
 * evita que el wrapper reporte éxito cuando en realidad el subproceso murió
 * sin terminar.
 */
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1)
}

/*
 * El primer `spawnSync` (`pnpm db:migrate`) hereda `--env-file-if-exists=.env`
 * porque ese flag está en el script `db:migrate` de `package.json`. Acá
 * invocamos `tsx` directamente, así que tenemos que pasarlo explícito: en
 * Railway no importa (las env vars las inyecta el runner), pero localmente
 * `DATABASE_URL` no llega al subproceso y el audit falla con "DATABASE_URL
 * no definida" apenas arranca.
 */
const audit = spawnSync(
  'pnpm',
  ['tsx', '--env-file-if-exists=.env', 'scripts/auditar-permisos-preview.ts', '--schema=preview'],
  { stdio: 'inherit' },
)

process.exit(audit.status ?? 1)