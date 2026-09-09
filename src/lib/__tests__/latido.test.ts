import { afterAll, describe, expect, it, vi } from 'vitest'
import { closeDb } from '@/db/client'
import { RITMO, type EstadoDeLatido, iniciarLatido, latir, resumirLatido } from '@/lib/latido'

/**
 * El latido que evita que Supabase apague el proyecto.
 *
 * El plan gratuito pausa a la semana sin actividad de base de datos, y `api` ya
 * es un proceso de larga vida: hace el trabajo sin una plataforma más.
 */

afterAll(async () => {
  await closeDb()
})

const estado = (e: Partial<EstadoDeLatido> = {}): EstadoDeLatido => ({
  ultimoContacto: null,
  ultimoError: null,
  latidos: 0,
  migraciones: null,
  ...e,
})

const AHORA = new Date('2026-09-05T12:00:00Z')
const haceMinutos = (n: number) => new Date(AHORA.getTime() - n * 60_000)

describe('lo que /health cuenta de la base', () => {
  it('recién arrancado dice «arrancando», no «sin contacto»', () => {
    expect(resumirLatido(estado(), AHORA)).toEqual({ base: 'arrancando', desdeHaceMs: null })
  })

  /*
   * La distinción no es cosmética: «todavía no late» y «dejó de latir» son
   * estados distintos. Reportar el primero como falla enseña a ignorar el valor
   * los primeros segundos de cada deploy — y ahí es cuando más se mira.
   */
  it('pero si YA falló, dice sin-contacto aunque nunca haya latido', () => {
    const r = resumirLatido(estado({ ultimoError: 'connection refused' }), AHORA)

    expect(r.base).toBe('sin-contacto')
    expect(r.error).toBe('connection refused')
  })

  it('con un latido reciente, dice ok', () => {
    const r = resumirLatido(estado({ ultimoContacto: haceMinutos(5), latidos: 3 }), AHORA)

    expect(r.base).toBe('ok')
    expect(r.desdeHaceMs).toBe(5 * 60_000)
  })

  /*
   * El «hace cuánto» se DERIVA del umbral, no se escribe a mano. Con un número
   * fijo, cambiar el ritmo del latido rompe este test por una razón que no
   * tiene nada que ver con lo que prueba — y la tentación es corregir el número
   * sin mirar si la regla sigue valiendo.
   */
  it('pasado el umbral, deja de decir que está bien', () => {
    const viejo = new Date(AHORA.getTime() - RITMO.sinNoticias - 60_000)

    expect(resumirLatido(estado({ ultimoContacto: viejo }), AHORA).base).toBe('sin-contacto')
  })

  it('justo dentro del umbral, sigue diciendo ok', () => {
    const reciente = new Date(AHORA.getTime() - RITMO.sinNoticias + 60_000)

    expect(resumirLatido(estado({ ultimoContacto: reciente }), AHORA).base).toBe('ok')
  })

  /*
   * Un latido viejo con el error del intento fallido es el caso REAL de una
   * caída: hubo contacto ayer, hoy no. Las dos mitades importan.
   */
  it('un latido viejo arrastra el error del último intento', () => {
    const r = resumirLatido(
      estado({ ultimoContacto: haceMinutos(90), ultimoError: 'timeout' }),
      AHORA,
    )

    expect(r.base).toBe('sin-contacto')
    expect(r.error).toBe('timeout')
    expect(r.desdeHaceMs).toBe(90 * 60_000)
  })
})

/**
 * ── Late al arrancar, no solo cada seis horas ───────────────────────────────
 *
 * Si solo latiera en el intervalo, un contenedor que se reinicia seguido —cada
 * deploy lo reinicia— podría no latir NUNCA: el temporizador vuelve a cero
 * antes de cumplirse.
 *
 * El sistema quedaría sin latido justamente mientras más se trabaja en él.
 */
describe('cuándo late', () => {
  const registro = () => ({ info: vi.fn(), warn: vi.fn() })

  it('late apenas arranca, sin esperar el intervalo', async () => {
    const log = registro()

    const detener = iniciarLatido(log, 60_000)
    await vi.waitFor(() => expect(log.info).toHaveBeenCalled())
    detener()

    expect(log.info.mock.calls[0]![1]).toContain('sigue despierto')
  })

  it('el intervalo no mantiene vivo al proceso', () => {
    const detener = iniciarLatido(registro(), 60_000)

    // Sin `unref`, un redeploy esperaría hasta seis horas para poder apagarse.
    expect(process.listenerCount('beforeExit')).toBe(0)
    detener()
  })
})

describe('la consulta', () => {
  it('devuelve el reloj de la base, que prueba que contestó', async () => {
    const enLaBase = await latir()

    expect(enLaBase).toBeInstanceOf(Date)
    expect(Math.abs(Date.now() - enLaBase.getTime())).toBeLessThan(5 * 60_000)
  })
})

/**
 * ── El esquema viaja en el mismo reporte que la base ────────────────────────
 *
 * Son la misma pregunta: «¿este proceso puede hacer su trabajo?»
 *
 * El 7-sep-2026 se desplegó código que leía una tabla que la migración todavía
 * no había creado. El servidor arrancó sano, `/health` dio verde, y los dos
 * módulos afectados fallaron recién cuando alguien los abrió — en una demo con
 * el cliente.
 */
describe('si faltan migraciones', () => {
  it('lo dice en el mismo /health, aunque la base responda', () => {
    const r = resumirLatido(
      estado({
        ultimoContacto: haceMinutos(1),
        migraciones: { estado: 'pendientes', faltan: ['0012_parametros'] },
      }),
      AHORA,
    )

    expect(r.base).toBe('ok')
    expect(r.esquema).toBe('pendientes')
    expect(r.faltan).toEqual(['0012_parametros'])
  })

  /*
   * «No se pudo mirar» no es «está todo bien». Decirlo al revés es exactamente
   * la mentira que este chequeo vino a eliminar.
   */
  it('no-verificable se reporta, no se calla', () => {
    const r = resumirLatido(
      estado({
        ultimoContacto: haceMinutos(1),
        migraciones: { estado: 'no-verificable', faltan: [], motivo: 'permission denied' },
      }),
      AHORA,
    )

    expect(r.esquema).toBe('no-verificable')
  })

  it('al día no ensucia la respuesta con campos vacíos', () => {
    const r = resumirLatido(
      estado({ ultimoContacto: haceMinutos(1), migraciones: { estado: 'al-dia', faltan: [] } }),
      AHORA,
    )

    expect(r.esquema).toBeUndefined()
    expect(r.faltan).toBeUndefined()
  })
})

/**
 * ── El umbral tiene que ser MAYOR que el intervalo ──────────────────────────
 *
 * La primera versión latía cada seis horas y declaraba «sin contacto» a los
 * treinta minutos: `/health` decía que la base estaba caída durante 5,5 de cada
 * 6 horas, con todo funcionando.
 *
 * Un aviso que suena el 92% del tiempo enseña a ignorarlo — que es exactamente
 * lo que dice RN-STK-11 sobre los umbrales, y lo que este proyecto acababa de
 * documentar cuando construyó el bug.
 *
 * Se descubrió mirando producción, no leyendo el código. Este test lo fija.
 */
describe('el ritmo', () => {
  it('el umbral es mayor que el intervalo: si no, avisa con todo bien', () => {
    expect(RITMO.sinNoticias).toBeGreaterThan(RITMO.cada)
  })

  /*
   * Con margen para más de un latido perdido. Uno solo haría que un reintento
   * lento —o un redespliegue— dispare el aviso sin que nada esté roto.
   */
  it('tolera más de un latido perdido antes de avisar', () => {
    expect(RITMO.sinNoticias / RITMO.cada).toBeGreaterThanOrEqual(2)
  })

  /*
   * El latido también mantiene despierto el proyecto en Supabase, que pausa a
   * los siete días sin actividad. Cualquier ritmo por debajo de un día sobra,
   * pero el número no puede quedar suelto sin que nadie lo mire.
   */
  it('late muchas veces dentro de la ventana de siete días de Supabase', () => {
    const enUnaSemana = (7 * 24 * 60 * 60 * 1000) / RITMO.cada

    expect(enUnaSemana).toBeGreaterThan(100)
  })
})
