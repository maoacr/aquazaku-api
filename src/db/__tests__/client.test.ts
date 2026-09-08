import { describe, expect, it } from 'vitest'
import { searchPathFor } from '@/db/client'

/**
 * El contrato `AQUAZAKU_ENV → search_path` está duplicado en dos archivos:
 *
 * - `src/lib/env.ts` define el enum `'production' | 'preview' | 'development'`.
 * - `src/db/client.ts` mapea ese enum al schema de postgres que el pool usa.
 *
 * Si alguien agrega un valor al enum sin tocar `searchPathFor`, el pool queda
 * con un `search_path` que no apunta a ningún lado (o al revés). Estos tests
 * son la red de seguridad barata: como `searchPathFor` es pura, se testea
 * directo, sin necesidad de abrir un pool real contra Postgres.
 *
 * Si se agrega un nuevo `AQUAZAKU_ENV`, este test va a fallar y va a forzar
 * la decisión explícita de a qué schema mapea.
 */
describe('searchPathFor (AQUAZAKU_ENV → search_path)', () => {
  it('production mapea a `public`', () => {
    expect(searchPathFor('production')).toBe('public')
  })

  it('preview mapea a `preview`', () => {
    expect(searchPathFor('preview')).toBe('preview')
  })

  it('development mapea a `public`', () => {
    expect(searchPathFor('development')).toBe('public')
  })
})
