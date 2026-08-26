import { describe, expect, it } from 'vitest'
import {
  DocumentoInvalido,
  MAXIMO_DE_DIGITOS,
  digitoDeVerificacion,
  documentoParaMostrar,
  normalizarDocumento,
} from '@/modules/clientes/documento'

/**
 * El dígito de verificación — RN-CLI-09.
 *
 * ── Por qué esto se prueba antes que nada ───────────────────────────────────
 *
 * Un DV mal calculado **no falla**. Devuelve un dígito, se imprime en una
 * factura y nadie lo nota hasta que la DIAN rechaza algo o un cliente dice «ese
 * no es mi NIT». No hay excepción, no hay 500, no hay línea en el log.
 *
 * Es el único riesgo de M5 que se descubre afuera del sistema.
 */

describe('los tres vectores de la norma', () => {
  /*
   * Salen de la Orden Administrativa 4 de 1989, transcritos en el dominio con
   * su suma y su resto. Si alguno de estos falla, o cambió la tabla de pesos o
   * cambió el algoritmo — y en los dos casos hay que ir a la norma, no al test.
   */
  it.each([
    ['123456789', 6],
    ['900123456', 8],
    ['79123456', 0],
  ])('%s → DV %i', (base, esperado) => {
    expect(digitoDeVerificacion(base)).toBe(esperado)
  })

  /**
   * El caso que se escribe mal por reflejo: con `resto = 0` el DV **es** cero,
   * no `11 − 0`. Lo mismo con `resto = 1`.
   */
  it('con resto 0 el DV es 0, no 11', () => {
    expect(digitoDeVerificacion('79123456')).toBe(0)
  })
})

/**
 * ── La trampa de los diez dígitos ───────────────────────────────────────────
 *
 * La norma tabula NUEVE pesos. Las cédulas colombianas actuales tienen DIEZ, y
 * el NIT de una persona natural se basa en su cédula.
 *
 * Con nueve pesos el primer dígito queda sin multiplicar: para `1010101010` la
 * suma da 84 en vez de 127. Las dos formas devuelven un dígito, así que el error
 * no se nota nunca.
 */
describe('un documento de diez dígitos usa los diez pesos', () => {
  it('multiplica TODOS los dígitos, incluido el primero', () => {
    // 127 mod 11 = 6 → DV = 11 − 6 = 5. Con la tabla de nueve daría otro.
    expect(digitoDeVerificacion('1010101010')).toBe(5)
  })

  /**
   * La prueba de que el primer dígito entra en la cuenta: cambiarlo tiene que
   * cambiar el resultado. Con nueve pesos, estos dos números darían lo mismo.
   */
  it('cambiar el primer dígito cambia el DV', () => {
    expect(digitoDeVerificacion('1010101010')).not.toBe(digitoDeVerificacion('9010101010'))
  })

  it('acepta hasta el largo que la tabla de pesos cubre', () => {
    const alLimite = '1'.repeat(MAXIMO_DE_DIGITOS)

    expect(() => digitoDeVerificacion(alLimite)).not.toThrow()
    expect(() => normalizarDocumento('1'.repeat(MAXIMO_DE_DIGITOS + 1))).toThrow(DocumentoInvalido)
  })
})

describe('normalizar deja el número base', () => {
  it.each([
    ['900.123.456-8', '9001234568'],
    ['900 123 456', '900123456'],
    ['  79123456  ', '79123456'],
  ])('%s → %s', (crudo, esperado) => {
    expect(normalizarDocumento(crudo)).toBe(esperado)
  })

  /**
   * ── Los ceros a la izquierda son un duplicado esperando ──────────────────
   *
   * Sin quitarlos, `079123456` y `79123456` son dos filas distintas para el
   * UNIQUE de RN-CLI-08 — y son la misma persona. El duplicado entra por la
   * puerta de atrás que esa regla viene justamente a cerrar.
   */
  it('quita los ceros a la izquierda: son la misma persona', () => {
    expect(normalizarDocumento('079123456')).toBe(normalizarDocumento('79123456'))
  })

  it('un documento sin dígitos se rechaza', () => {
    expect(() => normalizarDocumento('sin numero')).toThrow(DocumentoInvalido)
  })

  it('un documento de solo ceros no identifica a nadie', () => {
    expect(() => normalizarDocumento('0000')).toThrow(/no identifica a nadie/)
  })
})

describe('cómo se muestra', () => {
  /**
   * El guion del NIT no separa dos datos: separa el número de su DV. Una cédula
   * se escribe sin guion — el dígito existe igual, pero mostrarlo confundiría
   * los dos documentos.
   */
  it('el NIT lleva su DV; la cédula no', () => {
    expect(documentoParaMostrar('NIT', '900123456')).toBe('900123456-8')
    expect(documentoParaMostrar('CC', '79123456')).toBe('79123456')
  })
})
