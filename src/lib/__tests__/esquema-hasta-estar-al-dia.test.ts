import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { closeDb } from '@/db/client'
import type { EstadoDeMigraciones } from '@/lib/migraciones'

vi.mock('@/lib/migraciones', () => ({ revisarMigraciones: vi.fn() }))

/**
 * El estado del esquema se revisa hasta estar al día — y después, nunca más.
 *
 * ── De dónde salió este archivo ─────────────────────────────────────────────
 *
 * De un despliegue real, el 13-oct-2026. `/health` siguió diciendo
 * `faltan: ["0027_base_dispensadora"]` media hora después de que la migración
 * hubiera entrado bien, porque el proceso repetía la foto de su arranque.
 *
 * Durante el incidente no había forma de confirmar la corrección sin reiniciar
 * el servicio — y reiniciar producción para leer un indicador es exactamente lo
 * que un indicador debería evitar.
 *
 * ── Por qué «al día» es terminal ────────────────────────────────────────────
 *
 * Para un proceso dado, las migraciones esperadas son fijas (el journal viaja
 * dentro de la imagen) y las aplicadas solo crecen. Entonces `al-dia` no puede
 * revertirse, y dejar de revisar ahí no es una optimización: es la verdad del
 * dominio. El costo en el caso sano queda en una sola consulta, la del arranque.
 */

const PENDIENTES: EstadoDeMigraciones = {
  estado: 'pendientes',
  faltan: ['0027_base_dispensadora'],
}
const AL_DIA: EstadoDeMigraciones = { estado: 'al-dia', faltan: [] }
const NO_VERIFICABLE: EstadoDeMigraciones = {
  estado: 'no-verificable',
  faltan: [],
  motivo: 'no se pudo leer el registro de migraciones',
}

const registro = () => ({ info: vi.fn(), warn: vi.fn() })

/**
 * Un `latido` recién importado, con su estado en cero.
 *
 * ── Por qué hace falta ─────────────────────────────────────────────────────
 *
 * `estado` es un singleton del módulo: el primer test que lo deja en `al-dia`
 * hace que el siguiente arranque con la guarda ya satisfecha y `revisarMigraciones`
 * no se llame nunca. La primera versión de este archivo tenía tres tests que
 * pasaban o fallaban según el orden — peor que no tenerlos.
 *
 * `resetModules` devuelve un registro limpio para `latido`, pero el módulo
 * mockeado lo reusa: el `vi.fn()` es el MISMO en todos los tests, así que su
 * contador de llamadas viene sumado de los anteriores. Por eso el `mockReset`
 * acá y no en un `afterEach` — el contador tiene que arrancar en cero junto con
 * el estado, o «revisa una sola vez» mide la suma del archivo (medido: daba 7).
 */
async function fresco() {
  vi.resetModules()
  const { revisarMigraciones } = await import('@/lib/migraciones')
  const mock = vi.mocked(revisarMigraciones)
  mock.mockReset()
  const { iniciarLatido, leerEstado } = await import('@/lib/latido')
  return { revisarMigraciones: mock, iniciarLatido, leerEstado }
}

/** Un intervalo corto: lo que se mide es cuántas veces revisa, no cada cuánto. */
const CADA = 60

afterAll(async () => {
  await closeDb()
})

describe('mientras falte una migración, se vuelve a revisar', () => {
  /*
   * El caso del 13-oct: al arrancar faltaba, después alguien migró. Sin
   * reiniciar nada, el siguiente latido tiene que ver la realidad nueva.
   */
  /*
   * ── Por qué NO se afirma haber visto el estado intermedio ─────────────────
   *
   * La primera versión esperaba con un `waitFor` a ver `PENDIENTES` y después
   * `AL_DIA`. Pasaba sola y falló en la suite completa: el `waitFor` polea cada
   * 50 ms sobre una ventana de 60, así que bajo carga se la saltea y nunca ve
   * el intermedio. Estaba afirmando un INSTANTE, no un hecho.
   *
   * Lo que importa es determinista: la primera revisión devuelve `pendientes`,
   * así que llegar a `al-dia` EXIGE una segunda. El contador lo deja explícito.
   */
  it('después de migrar, el estado se corrige solo sin reiniciar nada', async () => {
    const { revisarMigraciones, iniciarLatido, leerEstado } = await fresco()
    revisarMigraciones.mockResolvedValueOnce(PENDIENTES).mockResolvedValue(AL_DIA)

    const detener = iniciarLatido(registro(), CADA)

    await vi.waitFor(() => expect(leerEstado().migraciones).toEqual(AL_DIA), { timeout: 5000 })
    detener()

    expect(revisarMigraciones.mock.calls.length).toBeGreaterThan(1)
  })

  it('y lo anuncia en el log, para que se vea CUÁNDO se resolvió', async () => {
    const { revisarMigraciones, iniciarLatido } = await fresco()
    revisarMigraciones.mockResolvedValueOnce(PENDIENTES).mockResolvedValue(AL_DIA)

    const log = registro()
    const detener = iniciarLatido(log, CADA)

    await vi.waitFor(
      () => {
        const anuncio = log.info.mock.calls.find((c) => String(c[1]).includes('al día'))
        expect(anuncio).toBeDefined()
      },
      { timeout: 3000 },
    )

    detener()
  })

  /*
   * `no-verificable` no es «está bien»: puede ser el GRANT de la 0013 que falta,
   * y eso se arregla sin reiniciar. Así que también se reintenta.
   */
  it('no-verificable también se reintenta', async () => {
    const { revisarMigraciones, iniciarLatido, leerEstado } = await fresco()
    revisarMigraciones.mockResolvedValueOnce(NO_VERIFICABLE).mockResolvedValue(AL_DIA)

    const detener = iniciarLatido(registro(), CADA)

    await vi.waitFor(() => expect(leerEstado().migraciones).toEqual(AL_DIA), { timeout: 3000 })

    detener()
  })
})

describe('una vez al día, no se vuelve a revisar', () => {
  /*
   * Esto es lo que mantiene el costo en cero cuando todo está bien. Si alguien
   * «simplifica» quitando la guarda, este test lo encuentra.
   */
  it('revisa una sola vez y deja de consultar', async () => {
    const { revisarMigraciones, iniciarLatido, leerEstado } = await fresco()
    revisarMigraciones.mockResolvedValue(AL_DIA)

    const detener = iniciarLatido(registro(), CADA)

    await vi.waitFor(() => expect(leerEstado().migraciones).toEqual(AL_DIA))

    /* Tres intervalos de margen: si siguiera revisando, acá se vería. */
    await new Promise((listo) => setTimeout(listo, CADA * 4))
    detener()

    expect(revisarMigraciones).toHaveBeenCalledTimes(1)
  })

  it('no avisa nada cuando arranca ya al día: el sistema no felicita', async () => {
    const { revisarMigraciones, iniciarLatido, leerEstado } = await fresco()
    revisarMigraciones.mockResolvedValue(AL_DIA)

    const log = registro()
    const detener = iniciarLatido(log, CADA)

    await vi.waitFor(() => expect(leerEstado().migraciones).toEqual(AL_DIA))
    detener()

    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info.mock.calls.filter((c) => String(c[1]).includes('al día'))).toHaveLength(0)
  })
})

describe('una revisión que falla no voltea el latido', () => {
  it('se registra el error y el proceso sigue latiendo', async () => {
    const { revisarMigraciones, iniciarLatido } = await fresco()
    revisarMigraciones.mockRejectedValue(new Error('la base cerró la conexión'))

    const log = registro()
    const detener = iniciarLatido(log, CADA)

    await vi.waitFor(() => {
      const aviso = log.warn.mock.calls.find((c) => String(c[1]).includes('falló la revisión'))
      expect(aviso).toBeDefined()
    })

    /* El latido sigue: lo que falló fue la revisión del esquema, no el pulso. */
    expect(log.info.mock.calls.some((c) => String(c[1]).includes('sigue despierto'))).toBe(true)

    detener()
  })
})
