/**
 * ¿La colección de Bruno cubre todos los endpoints?
 *
 * ── Por qué esto existe ─────────────────────────────────────────────────────
 *
 * CI corre la colección en cada push, pero verde significa «lo que hay pasa»,
 * NO «cubre todo». Un endpoint nuevo sin petición no rompe nada: simplemente no
 * se prueba, y nadie se entera hasta que falla en la planta.
 *
 * Este script contesta la otra pregunta. Se corre a mano, cuando se agrega o se
 * mueve un endpoint:
 *
 *     pnpm bruno:cobertura
 *
 * ── Es diagnóstico, no portón ───────────────────────────────────────────────
 *
 * Está en `package.json` para que sea fácil de correr, y **fuera del workflow a
 * propósito**. Un portón de cobertura que nadie eligió se vuelve el rojo que
 * todos aprenden a ignorar: el de `web` lleva cuarenta corridas sin pasar, con
 * umbrales que se pusieron como meta y quedaron como barrera.
 *
 * De ahí sale la regla de este archivo: **nunca falla por lo que encuentra**.
 * Reporta y sale con 0, haya cero huecos o veinte. Si algún día se decide
 * convertirlo en portón, que sea una decisión explícita de quien la tome — no
 * algo que se hereda por haber agregado una línea al `package.json`.
 *
 * Sí sale con 1 si no PUEDE correr —falta `fd`—, que es otra cosa: ahí no hay
 * hallazgo que reportar, y un 0 diría «todo bien» sin haber mirado nada.
 *
 * Tampoco escribe, ni abre la base, ni sale a la red: lee archivos y compara.
 *
 * ── Emparejar por SEGMENTOS, no por texto ───────────────────────────────────
 *
 * La primera versión normalizaba las dos cadenas y las comparaba como texto. Eso
 * falla con las rutas cuyo parámetro se escribe literal en la petición:
 * `PUT /parametros/dias_aviso_vencimiento` contra `PUT /parametros/:clave`. El
 * informe decía que ese endpoint no tenía ninguna petición mientras esa misma
 * petición corría y pasaba — o sea que la herramienta mentía con la autoridad de
 * haber medido.
 *
 * Lo correcto es lo que hace el router: comparar segmento por segmento, donde un
 * `:param` acepta cualquier cosa.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Los archivos que hay que leer, vía `fd`.
 *
 * Si `fd` no está, el `execFileSync` tira un `ENOENT` cuyo stack no menciona a
 * `fd` por ningún lado, y se persigue como si el script estuviera roto.
 */
function listar(args: string[]): string[] {
  try {
    return execFileSync('fd', args, { cwd: RAIZ, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('\n✗ Falta `fd`, que es lo que este script usa para listar archivos.')
      console.error('  Instalalo con: brew install fd\n')
      process.exitCode = 1
      process.exit()
    }

    throw err
  }
}

const segmentos = (p: string): string[] =>
  p.split('?')[0]!.replace(/\/+$/, '').split('/').filter(Boolean)

/** `:param` de Fastify y `{{var}}` de Bruno: los dos aceptan cualquier cosa. */
const comodin = (s: string): boolean => s.startsWith(':') || /^\{\{.*\}\}$/.test(s)

function empareja(ruta: string, peticion: string): boolean {
  const a = segmentos(ruta)
  const b = segmentos(peticion)
  if (a.length !== b.length) return false

  return a.every((s, i) => comodin(s) || comodin(b[i]!) || s === b[i])
}

const RE_RUTA =
  /\b(?:app|fastify|server)\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g

interface Ruta {
  clave: string
  metodo: string
  ruta: string
  archivo: string
}

/**
 * Lo que `api/` expone de verdad.
 *
 * Sin `__tests__`: ahí hay rutas de fixture —`/protegido`, un `/ventas/anular`
 * de prueba— que no son endpoints del sistema y aparecerían como huecos.
 */
function rutasDeLaApi(): Ruta[] {
  const rutas: Ruta[] = []

  for (const archivo of [
    ...listar(['-e', 'ts', '.', 'src/modules', '--exclude', '__tests__']),
    'src/app.ts',
  ]) {
    for (const [, metodo, ruta] of readFileSync(join(RAIZ, archivo), 'utf8').matchAll(RE_RUTA)) {
      const clave = `${metodo!.toUpperCase()} ${ruta!.split('?')[0]}`
      if (!rutas.some((r) => r.clave === clave)) {
        rutas.push({ clave, metodo: metodo!.toUpperCase(), ruta: ruta!, archivo })
      }
    }
  }

  /*
   * Better-Auth monta su propio árbol bajo `/api/auth/*` desde un plugin, así
   * que ningún `app.post` lo declara. Se suma a mano el único que la colección
   * usa —el login—, porque si no aparecería como petición huérfana.
   */
  rutas.push({
    clave: 'POST /api/auth/sign-in/email',
    metodo: 'POST',
    ruta: '/api/auth/sign-in/email',
    archivo: 'better-auth (plugin)',
  })

  return rutas
}

interface Peticion {
  metodo: string
  path: string
  archivo: string
}

function peticionesDeBruno(): Peticion[] {
  const peticiones: Peticion[] = []

  for (const archivo of listar(['-e', 'bru', '.', 'bruno'])) {
    if (archivo.includes('environments') || archivo.endsWith('collection.bru')) continue

    const bloque = readFileSync(join(RAIZ, archivo), 'utf8').match(
      /^\s*(get|post|put|patch|delete)\s*\{[\s\S]*?url:\s*(\S+)/m,
    )
    if (!bloque) continue

    peticiones.push({
      metodo: bloque[1]!.toUpperCase(),
      path: bloque[2]!.replace(/^\{\{baseUrl\}\}/, '').split('?')[0]!,
      archivo: archivo.replace('bruno/aquazaku/', ''),
    })
  }

  return peticiones
}

const rutas = rutasDeLaApi()
const peticiones = peticionesDeBruno()

const cubre = (r: Ruta, p: Peticion): boolean => r.metodo === p.metodo && empareja(r.ruta, p.path)

const sinCubrir = rutas.filter((r) => !peticiones.some((p) => cubre(r, p)))
const sobrantes = peticiones.filter((p) => !rutas.some((r) => cubre(r, p)))

/*
 * Una petición sin ruta cuyo PATH sí existe con otro verbo no es un error: es
 * una prueba negativa. `DELETE /ventas/:id` esperando 404 comprueba que una
 * venta no se borra, y tiene que existir justamente porque esa ruta no existe.
 */
const negativas = sobrantes.filter((p) => rutas.some((r) => empareja(r.ruta, p.path)))
const rotas = sobrantes.filter((p) => !rutas.some((r) => empareja(r.ruta, p.path)))

const pct = ((1 - sinCubrir.length / rutas.length) * 100).toFixed(1)

console.log(`rutas reales en api/      ${rutas.length}`)
console.log(`con al menos una petición ${rutas.length - sinCubrir.length}`)
console.log(`cobertura                 ${pct}%`)
console.log(`pruebas negativas         ${negativas.length}  (verbo prohibido a propósito)`)

console.log(`\n━━━ SIN NINGUNA PETICIÓN (${sinCubrir.length}) ━━━`)
for (const r of [...sinCubrir].sort((a, b) => a.clave.localeCompare(b.clave))) {
  console.log(`  ${r.clave.padEnd(42)} ${r.archivo}`)
}

if (rotas.length > 0) {
  console.log(`\n━━━ ⚠ PETICIONES A RUTAS INEXISTENTES (${rotas.length}) ━━━`)
  for (const p of rotas) console.log(`  ${`${p.metodo} ${p.path}`.padEnd(42)} ${p.archivo}`)
} else {
  console.log('\n✓ Ninguna petición apunta a una ruta que no existe.')
}
