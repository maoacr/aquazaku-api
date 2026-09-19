import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MODULOS = join(import.meta.dirname, '../..')

/**
 * El `resource` de una fila tiene que ser el prefijo de su `action`.
 *
 * La consulta de la bitácora los combina con AND. Si una fila dice
 * `action: 'configuracion:editar'` pero `resource: 'parametros'`, filtrar por
 * módulo «Configuración» + acción «Editar» devuelve CERO — y cero se ve igual
 * que «no pasó nada». El filtro miente en la pantalla cuyo único trabajo es no
 * mentir.
 *
 * Pasó de verdad: `alertas/routes.ts` escribía el nombre de la TABLA
 * (`parametros`) donde va el de la matriz (`configuracion`), mientras el
 * middleware escribía `configuracion` para esa misma acción. La misma acción
 * con dos módulos distintos en el log.
 *
 * Solo se miran los pares donde los DOS son literales. Cuando el `resource`
 * llega por variable, lo pone quien llama y ya viaja junto a su `action`.
 */
const PAR_LITERAL = /action: '([a-z_]+):[a-z_-]+',\s*\n\s*resource: '([a-z_]+)'/g

describe('la fila dice a qué módulo pertenece', () => {
  it('el `resource` es siempre el prefijo del `action`', () => {
    const desalineadas: string[] = []

    const recorrer = (dir: string) => {
      for (const entrada of readdirSync(dir)) {
        if (entrada === '__tests__') continue
        const ruta = join(dir, entrada)

        if (statSync(ruta).isDirectory()) {
          recorrer(ruta)
          continue
        }
        if (!entrada.endsWith('.ts')) continue

        for (const [, prefijo, resource] of readFileSync(ruta, 'utf8').matchAll(PAR_LITERAL)) {
          if (prefijo !== resource) desalineadas.push(`${entrada}: ${prefijo}:… con resource '${resource}'`)
        }
      }
    }

    recorrer(MODULOS)

    expect(desalineadas).toEqual([])
  })
})
