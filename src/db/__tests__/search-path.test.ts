import { describe, expect, it } from 'vitest'
import { searchPathFor } from '@/db/search-path'

/**
 * En qué schema vive cada ambiente — una sola decisión.
 *
 * ── El bug que este archivo existe para impedir ─────────────────────────────
 *
 * La app decidía por `AQUAZAKU_ENV` y el migrador tenía `'public'` escrito a
 * mano. En staging, eso significaba:
 *
 *     pnpm db:migrate  → migraba «public»   ← el schema de PRODUCCIÓN
 *     pnpm start       → servía «preview»
 *
 * El mismo comando apuntaba a schemas distintos según qué pieza lo leyera. Y no
 * fallaba: migraba producción en cada deploy de staging, en silencio, que es la
 * peor forma de romper algo.
 */

describe('el schema del ambiente', () => {
  it('preview va a su propio schema', () => {
    expect(searchPathFor('preview')).toBe('preview')
  })

  it('producción y desarrollo van a public', () => {
    expect(searchPathFor('production')).toBe('public')
    expect(searchPathFor('development')).toBe('public')
  })

  /*
   * Sin ambiente, `public`. Es el comportamiento histórico y el más seguro para
   * un script suelto: preview se pide, no se cae en él por accidente.
   */
  it('sin ambiente definido, public', () => {
    expect(searchPathFor(undefined)).toBe('public')
  })

  /*
   * `AQUAZAKU_ENV` es un enum de tres valores en `env.ts`. Si alguien agrega
   * uno —`qa`, `demo`— tiene que decidir a qué schema va, y este test lo obliga
   * a pasar por acá en vez de que caiga en `public` sin que nadie lo mire.
   */
  it('un ambiente nuevo cae en public hasta que alguien decida otra cosa', () => {
    expect(searchPathFor('qa' as never)).toBe('public')
  })
})
