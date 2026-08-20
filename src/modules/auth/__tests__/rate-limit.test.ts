import { beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITE_LOGIN,
  LIMITE_RESET,
  _reiniciarLimites,
  claveDeIntento,
  limpiarIntentos,
  registrarIntento,
} from '../rate-limit'

const rapido = { max: 3, ventanaMs: 60_000 }

beforeEach(() => {
  _reiniciarLimites()
})

describe('registrarIntento()', () => {
  it('permite hasta el máximo', () => {
    for (let i = 0; i < rapido.max; i++) {
      expect(registrarIntento('k', rapido).permitido, `intento ${i + 1}`).toBe(true)
    }
  })

  it('bloquea a partir del siguiente', () => {
    for (let i = 0; i < rapido.max; i++) registrarIntento('k', rapido)

    expect(registrarIntento('k', rapido).permitido).toBe(false)
  })

  it('sigue bloqueando mientras dura la ventana', () => {
    for (let i = 0; i < rapido.max + 5; i++) registrarIntento('k', rapido)

    expect(registrarIntento('k', rapido).permitido).toBe(false)
  })

  it('dice cuántos segundos faltan para reintentar', () => {
    for (let i = 0; i < rapido.max; i++) registrarIntento('k', rapido)

    const resultado = registrarIntento('k', rapido)

    expect(resultado.reintentarEn).toBeGreaterThan(0)
    expect(resultado.reintentarEn).toBeLessThanOrEqual(60)
  })

  it('las claves distintas no se afectan entre sí', () => {
    for (let i = 0; i < rapido.max; i++) registrarIntento('uno', rapido)

    expect(registrarIntento('uno', rapido).permitido).toBe(false)
    expect(registrarIntento('otro', rapido).permitido).toBe(true)
  })

  it('la ventana se reinicia cuando vence', () => {
    const brevisima = { max: 2, ventanaMs: 30 }

    registrarIntento('k', brevisima)
    registrarIntento('k', brevisima)
    expect(registrarIntento('k', brevisima).permitido).toBe(false)

    return new Promise<void>((resolver) => {
      setTimeout(() => {
        expect(registrarIntento('k', brevisima).permitido).toBe(true)
        resolver()
      }, 50)
    })
  })

  it('cuenta TODOS los intentos, no solo los fallidos', () => {
    // Contar solo los fallidos permitiría alternar con logins correctos de una
    // cuenta propia para mantener vivo el contador de otra.
    expect(registrarIntento('k', { max: 1, ventanaMs: 60_000 }).permitido).toBe(true)
    expect(registrarIntento('k', { max: 1, ventanaMs: 60_000 }).permitido).toBe(false)
  })
})

describe('limpiarIntentos()', () => {
  it('deja la cuenta en cero', () => {
    for (let i = 0; i < rapido.max; i++) registrarIntento('k', rapido)
    expect(registrarIntento('k', rapido).permitido).toBe(false)

    limpiarIntentos('k')

    // Quien finalmente entra bien no arrastra el castigo de haberse equivocado.
    expect(registrarIntento('k', rapido).permitido).toBe(true)
  })

  it('borrar una clave que no existe no rompe nada', () => {
    expect(() => limpiarIntentos('inexistente')).not.toThrow()
  })
})

describe('claveDeIntento()', () => {
  it('combina IP y email', () => {
    expect(claveDeIntento('1.2.3.4', 'mao@aquazaku.com')).toBe('1.2.3.4|mao@aquazaku.com')
  })

  it('normaliza el email: cambiarle el case no evade el límite', () => {
    expect(claveDeIntento('1.2.3.4', 'MAO@Aquazaku.COM')).toBe(
      claveDeIntento('1.2.3.4', 'mao@aquazaku.com'),
    )
  })

  it('ignora espacios alrededor', () => {
    expect(claveDeIntento('1.2.3.4', '  mao@aquazaku.com  ')).toBe(
      claveDeIntento('1.2.3.4', 'mao@aquazaku.com'),
    )
  })

  it('la misma IP con emails distintos son contadores distintos', () => {
    // Si no, una oficina detrás del mismo NAT se bloquea entera por una persona.
    expect(claveDeIntento('1.2.3.4', 'a@x.com')).not.toBe(claveDeIntento('1.2.3.4', 'b@x.com'))
  })

  it('el mismo email desde IPs distintas son contadores distintos', () => {
    // Y si no, un atacante distribuye el ataque entre miles de IPs.
    expect(claveDeIntento('1.1.1.1', 'a@x.com')).not.toBe(claveDeIntento('2.2.2.2', 'a@x.com'))
  })
})

describe('los límites configurados', () => {
  it('login: 5 intentos cada 15 minutos, como pide el spec', () => {
    expect(LIMITE_LOGIN).toEqual({ max: 5, ventanaMs: 15 * 60 * 1000 })
  })

  it('recuperación: más estricto, porque el riesgo es bombardear una casilla ajena', () => {
    expect(LIMITE_RESET.max).toBeLessThan(LIMITE_LOGIN.max)
  })
})
