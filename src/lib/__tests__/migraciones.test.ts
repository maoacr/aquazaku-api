import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '@/db/client'
import { revisarMigraciones } from '@/lib/migraciones'

/**
 * ¿Le falta una migración a esta base?
 *
 * Existe por un caso real: se desplegó código que leía una tabla que la
 * migración todavía no había creado. El servidor arrancó sano, el healthcheck
 * dio verde, y dos módulos fallaron recién cuando alguien los abrió en una demo
 * con el cliente.
 */

afterAll(async () => {
  await closeDb()
})

describe('contra una base migrada', () => {
  it('dice que está al día, sin faltantes', async () => {
    expect(await revisarMigraciones()).toEqual({ estado: 'al-dia', faltan: [] })
  })

  /*
   * El journal viaja en la imagen —el Dockerfile copia `src` entero— así que
   * esto también prueba que el archivo está donde el código lo busca. Si alguien
   * cambia el Dockerfile y deja de copiarlo, este test cae.
   */
  it('encuentra el journal donde el Dockerfile lo deja', async () => {
    expect((await revisarMigraciones()).estado).not.toBe('no-verificable')
  })
})
