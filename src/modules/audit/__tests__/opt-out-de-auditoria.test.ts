import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * El opt-out de auditoría se declara acá o no se declara.
 *
 * `requirePermission(r, a, { auditaLaRuta: true })` APAGA la fila `ok` del
 * middleware (`authz/middleware.ts`). El flag es una promesa: «yo, la ruta,
 * escribo esa fila con más detalle del que hay en el middleware».
 *
 * Cuando la promesa no se cumple, la acción sensible se ejecuta y no deja
 * rastro. Y nadie se entera, porque una bitácora a la que le falta una acción
 * se ve exactamente igual que una bitácora donde esa acción no pasó.
 *
 * Así se perdieron veinte acciones —`ventas:crear` entre ellas—: el único
 * `emit` de esos módulos vive dentro del manejador de errores y escribe
 * `denied`. La venta exitosa no aparecía; la venta RECHAZADA sí. La bitácora
 * mostraba exactamente lo contrario de lo que había pasado.
 *
 * Por eso el opt-out pasa a ser una lista cerrada. Agregar el flag a una ruta
 * nueva rompe este test, y para arreglarlo hay que venir acá y escribir dónde
 * se paga la promesa. Olvidarse deja de ser silencioso, que era el problema.
 */

const MODULOS = join(import.meta.dirname, '../..')

/**
 * Acciones que se auditan solas, y dónde.
 *
 * La clave es `módulo → acción` y no la acción sola: `configuracion:editar` lo
 * usan dos módulos, y solo uno de los dos cumple.
 */
const SE_AUDITAN_SOLAS: Record<string, string> = {
  'alertas → configuracion:editar':
    'alertas/routes.ts — emite con los umbrales viejos y nuevos',
  'productos → productos:crear': 'productos/routes.ts — emite con código y nombre',
  'productos → productos:desactivar':
    'productos/routes.ts — emite `desactivar` y `reactivar` con el código',
  'productos → productos:editar_precios':
    'productos/service.ts — emite con los precios de antes y después',
  'stock → stock:ajustar': 'stock/service.ts — emite con el lote y el delta',
  'stock → stock:descartar': 'stock/service.ts — emite con el lote y el motivo',
  'users → usuarios:crear': 'users/routes.ts — emite con el id nuevo y los roles',
  'users → usuarios:editar': 'users/routes.ts — emite con los campos que cambiaron',
  'ventas → ventas:corregir': 'ventas/routes.ts — emite con el antes y el después',
}

const DECLARA_OPT_OUT =
  /requirePermission\(\s*'([a-z_]+)',\s*'([a-z_]+)'\s*,\s*\{\s*auditaLaRuta:\s*true\s*\}/g

function declaracionesDe(modulo: string): string[] {
  const encontradas: string[] = []

  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (entrada === '__tests__') continue
      const ruta = join(dir, entrada)

      if (statSync(ruta).isDirectory()) {
        recorrer(ruta)
        continue
      }

      if (!entrada.endsWith('.ts')) continue

      for (const [, resource, action] of readFileSync(ruta, 'utf8').matchAll(DECLARA_OPT_OUT)) {
        encontradas.push(`${modulo} → ${resource}:${action}`)
      }
    }
  }

  recorrer(join(MODULOS, modulo))

  return encontradas
}

describe('el opt-out de auditoría es una lista cerrada', () => {
  it('ninguna ruta se exime de la bitácora sin estar declarada', () => {
    const declaradas = readdirSync(MODULOS)
      .filter((m) => statSync(join(MODULOS, m)).isDirectory())
      .flatMap(declaracionesDe)

    expect([...new Set(declaradas)].sort()).toEqual(Object.keys(SE_AUDITAN_SOLAS).sort())
  })
})
