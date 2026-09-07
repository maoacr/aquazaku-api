import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '@/db/client'
import {
  PARAMETROS_INICIALES,
  cambiarParametro,
  leerParametro,
  listarParametros,
} from '@/modules/alertas/parametros'
import { resetDb } from '@/test/db'

/**
 * Los umbrales de las alertas — M12, RN-STK-11.
 *
 * «Un umbral que avisa tarde no sirve; uno que avisa demasiado pronto entrena a
 * ignorar el aviso, que es peor.» El número correcto depende de la rotación
 * real, que todavía no se midió — así que moverlo no puede exigir un despliegue.
 */

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

describe('los que existen', () => {
  it('los crea la migración, no el seed: el código los lee sin alternativa', async () => {
    expect((await listarParametros()).map((p) => p.clave)).toEqual([
      'dias_aviso_vencimiento',
      'dias_entrega_bases',
    ])
  })

  /*
   * `PARAMETROS_INICIALES` es una lista espejo del SQL de la migración, y las
   * listas espejo se desactualizan en silencio. Este test hace que agregar un
   * parámetro en el SQL y olvidarse de la constante falle acá, y no meses
   * después cuando un reset deje la base a medias.
   */
  it('la lista espejo del reset coincide con lo que dejó la migración', async () => {
    const enLaBase = await listarParametros()

    expect(PARAMETROS_INICIALES.map((p) => p.clave)).toEqual(enLaBase.map((p) => p.clave))
  })

  it('cada uno trae su etiqueta y su ayuda, para que la pantalla no las copie', async () => {
    for (const p of await listarParametros()) {
      expect(p.etiqueta.length).toBeGreaterThan(0)
      expect(p.ayuda.length).toBeGreaterThan(20)
      expect(p.unidad).toBe('días')
    }
  })
})

describe('leer un umbral', () => {
  it('devuelve el número, no un objeto que haya que desarmar', async () => {
    expect(await leerParametro('dias_entrega_bases')).toBe(7)
  })
})

/**
 * ── Los bordes son la garantía, no una molestia ─────────────────────────────
 *
 * Un umbral en 0 apaga la alerta sin decirlo; uno en 9999 la deja siempre
 * encendida. Las dos formas de romperla se ven igual desde afuera —nadie
 * reacciona— y ninguna avisa.
 */
describe('cambiar un umbral', () => {
  it('lo cambia, y eso cambia lo que avisan las pantallas', async () => {
    const p = await cambiarParametro('dias_aviso_vencimiento', 14)

    expect(p.valor).toBe(14)
    expect(await leerParametro('dias_aviso_vencimiento')).toBe(14)
  })

  it('por debajo del mínimo se rechaza, y explica qué apagaría', async () => {
    await expect(cambiarParametro('dias_aviso_vencimiento', 0)).rejects.toThrow('apagaría el aviso')
  })

  it('por encima del máximo también, y explica lo contrario', async () => {
    await expect(cambiarParametro('dias_aviso_vencimiento', 90)).rejects.toThrow(
      'siempre encendido',
    )
  })

  it('el mensaje dice entre qué y qué se puede mover', async () => {
    await expect(cambiarParametro('dias_aviso_vencimiento', 0)).rejects.toThrow(
      'va entre 1 y 30 días',
    )
  })

  it('una clave que no existe responde 404, no crea una fila', async () => {
    await expect(cambiarParametro('inventado', 5)).rejects.toThrow('no existe el parámetro')
    expect(await listarParametros()).toHaveLength(2)
  })

  it('los bordes SÍ se aceptan: el límite es inclusivo', async () => {
    expect((await cambiarParametro('dias_aviso_vencimiento', 1)).valor).toBe(1)
    expect((await cambiarParametro('dias_aviso_vencimiento', 30)).valor).toBe(30)
  })
})
