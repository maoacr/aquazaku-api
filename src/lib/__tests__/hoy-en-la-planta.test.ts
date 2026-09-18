import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ZONA_DE_LA_PLANTA, hoyEnLaPlanta } from '@/lib/dia'

/**
 * Qué día es hoy, visto desde la planta — el gemelo en JS de `diaEnLaPlanta`.
 *
 * ── El bug que esto evita ───────────────────────────────────────────────────
 *
 * Cinco rutas calculaban el día con `new Date().toISOString().slice(0, 10)`.
 * `toISOString()` es UTC **siempre**, sin importar la zona del proceso:
 *
 * | A las 19:30 del 31-ago en la planta | Devolvía |
 * | --- | --- |
 * | `new Date().toISOString().slice(0, 10)` | **2026-09-01** ✗ |
 * | El día que es en Campo de la Cruz       | 2026-08-31 ✓ |
 *
 * Y ese string no se muestra: se COMPARA. Decide si un código de descuento
 * sigue vigente, si un lote ya venció, y cuántos días lleva un cliente sin
 * comprar. Un código que vence el 31 se rechazaba desde las 19:00 del 31, con
 * el cliente en el mostrador y el cupón en la mano.
 *
 * `diaEnLaPlanta` ya resolvía esto del lado de SQL. Faltaba el lado de JS, que
 * es donde se lee el reloj.
 */

/** 31 de agosto, 19:30 en la planta. En UTC ya es el 1 de septiembre. */
const CAE_EN_OTRO_DIA = new Date('2026-08-31T19:30:00-05:00')

beforeAll(() => {
  vi.useFakeTimers()
})

afterAll(() => {
  vi.useRealTimers()
})

describe('el día que es en la planta', () => {
  it('a las 19:30 del 31 todavía es el 31, no el 1', () => {
    vi.setSystemTime(CAE_EN_OTRO_DIA)

    expect(hoyEnLaPlanta()).toBe('2026-08-31')
  })

  /** La forma vieja, para que quede escrito qué devolvía. */
  it('la forma vieja devolvía el día siguiente', () => {
    vi.setSystemTime(CAE_EN_OTRO_DIA)

    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-01')
  })

  it('a las 23:59 del último día del mes sigue siendo ese mes', () => {
    vi.setSystemTime(new Date('2026-08-31T23:59:00-05:00'))

    expect(hoyEnLaPlanta()).toBe('2026-08-31')
  })

  it('pasada la medianoche de la planta sí cambia el día', () => {
    vi.setSystemTime(new Date('2026-09-01T00:01:00-05:00'))

    expect(hoyEnLaPlanta()).toBe('2026-09-01')
  })

  /** Antes de las 19:00 las dos zonas coinciden: un test que solo usara
   *  el mediodía pasaría con el bug puesto. */
  it('al mediodía, donde las dos zonas coinciden, también acierta', () => {
    vi.setSystemTime(new Date('2026-08-31T12:00:00-05:00'))

    expect(hoyEnLaPlanta()).toBe('2026-08-31')
  })

  it('el formato es AAAA-MM-DD, que es como se compara contra la base', () => {
    vi.setSystemTime(CAE_EN_OTRO_DIA)

    expect(hoyEnLaPlanta()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('la zona', () => {
  it('es la misma que usa el lado de SQL', () => {
    expect(ZONA_DE_LA_PLANTA).toBe('America/Bogota')
  })
})
