import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import * as schema from '@/db/schema'
import { describirConexion } from './describir-conexion'
import { privilegiosQuitados, verificarRespaldo } from './verificar-respaldo'

/**
 * Respaldo de la base — la mitad que Supabase Free no trae.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * El plan gratuito de Supabase dice `Backup retention: None`. No son respaldos
 * limitados: no hay. Y adentro van a estar los clientes, las ventas y la plata
 * de un negocio real.
 *
 * Mientras el plan sea el gratuito, **este script es el respaldo**. No es una
 * herramienta de conveniencia.
 *
 * ── Verifica, no solo escribe ───────────────────────────────────────────────
 *
 * La forma clásica de perder datos no es quedarse sin respaldo: es tener uno que
 * nadie miró. El proceso corre un año, el archivo sale vacío o cortado, y eso se
 * descubre el único día que importa.
 *
 * Por eso el volcado se verifica ANTES de comprimirse, y el script falla ruidoso
 * si algo no cierra. Un respaldo que no se verificó no cuenta como respaldo.
 */

const DESTINO = process.env.RESPALDOS_DIR ?? join(process.cwd(), 'respaldos')
const MIGRACIONES = join(process.cwd(), 'src', 'db', 'migrations')

function main(): void {
  /*
   * Va la conexión de MIGRACIONES, con el rol dueño. `aquazaku_app` no puede
   * volcar todo a propósito —no es dueño de las tablas y le faltan permisos
   * sobre `audit_log`—, así que un respaldo hecho con ese rol saldría incompleto
   * y con código de salida cero.
   */
  const url = process.env.DATABASE_MIGRATION_URL
  if (!url) {
    fallar('falta DATABASE_MIGRATION_URL: es la conexión del rol dueño, la única que puede volcar todo')
  }

  /*
   * ── A DÓNDE nos conectamos, dicho antes de empezar ────────────────────────
   *
   * Sin esto, el script volcó la base local creyendo que volcaba producción: la
   * variable estaba puesta con `export` en otra terminal, se perdió al abrir
   * una nueva, y el `.env` tomó el control en silencio.
   *
   * El destino se anuncia antes, se repite al final, y va en el nombre del
   * archivo. Una carpeta de respaldos tiene que poder leerse sin abrirlos.
   */
  const { descripcion, etiqueta } = describirConexion(url)
  console.log(`→ respaldando ${descripcion}`)

  const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const archivo = join(DESTINO, `aquazaku-${etiqueta}-${sello}.sql.gz`)

  let volcado: string
  try {
    /*
     * ── Ni `--no-owner` ni `--no-privileges` ────────────────────────────────
     *
     * Las dos banderas son el default reflejo al escribir un pg_dump, y las dos
     * romperían este respaldo en silencio: la inmutabilidad del `audit_log` son
     * 20 REVOKE repartidos en 9 migraciones (ADR-0004), y viven exactamente en
     * lo que esas banderas descartan.
     *
     * Un volcado sin ellos restaura una base que funciona, pasa los tests y
     * tiene la bitácora editable. El peor resultado posible: parece correcto.
     *
     * ── Solo `public` y `drizzle` ───────────────────────────────────────────
     *
     * Sin acotarlo, el volcado se lleva los esquemas internos de Supabase
     * —`auth`, `storage`, `realtime`—: 35 tablas que Aquazaku no usa, porque la
     * sesión la maneja Better-Auth con tablas propias en `public`.
     *
     * No es cuestión de peso. Al restaurar en un proyecto de Supabase nuevo,
     * esos esquemas YA existen con su propio estado, y el respaldo intentaría
     * pisar las tablas que ese proyecto necesita para funcionar.
     *
     * `drizzle` sí va: ahí vive el registro de migraciones. Sin él, la base
     * restaurada cree que no se migró nunca e intenta aplicarlas de nuevo.
     */
    volcado = execFileSync('pg_dump', ['--schema=public', '--schema=drizzle', url], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    })
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)

    /*
     * El error más probable, y el que peor se lee: pg_dump se niega a volcar un
     * servidor más nuevo que él. Supabase corre 17 y Homebrew instala 16 por
     * defecto.
     */
    if (/server version|version mismatch/i.test(mensaje)) {
      fallar(
        'pg_dump es más viejo que el servidor. Supabase corre Postgres 17:\n' +
          '  brew install postgresql@17\n' +
          '  export PATH="$(brew --prefix postgresql@17)/bin:$PATH"',
      )
    }
    fallar(`pg_dump falló:\n${mensaje}`)
  }

  /*
   * La lista sale de Drizzle con SU API pública, no adivinando la forma de sus
   * objetos internos. La primera versión filtraba por `'_' in t` y devolvía
   * CERO tablas — con lo cual el respaldo se verificaba contra una lista vacía
   * y pasaba siempre.
   */
  const tablas = Object.values(schema)
    .filter((t): t is PgTable => is(t, PgTable))
    .map(getTableName)

  /*
   * Los privilegios quitados se leen de las migraciones, que son la fuente de
   * verdad. Así, el día que una migración nueva revoque algo, el respaldo lo
   * empieza a verificar sin que nadie toque este script.
   */
  const migraciones = readdirSync(MIGRACIONES)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRACIONES, f), 'utf8'))
    .join('\n')

  const { ok, problemas } = verificarRespaldo(volcado!, tablas, privilegiosQuitados(migraciones))

  if (!ok) {
    fallar(
      `el volcado de ${descripcion} no pasó la verificación:\n` +
        `${problemas.map((p) => `  · ${p}`).join('\n')}`,
    )
  }

  mkdirSync(DESTINO, { recursive: true })
  const comprimido = gzipSync(volcado!)
  writeFileSync(archivo, comprimido)

  const mb = (comprimido.byteLength / 1024 / 1024).toFixed(2)
  console.log(`✓ respaldo verificado de ${descripcion} — ${tablas.length} tablas · ${mb} MB`)
  console.log(`  ${archivo}`)
  console.log('\n  Para restaurar en una base VACÍA:')
  console.log(`    gunzip -c ${archivo} | psql "$DATABASE_MIGRATION_URL"`)
}

function fallar(mensaje: string): never {
  console.error(`\n✗ ${mensaje}\n`)
  process.exit(1)
}

main()
