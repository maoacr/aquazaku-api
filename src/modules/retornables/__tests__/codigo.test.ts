import { describe, expect, it } from 'vitest'
import { ErrorDeNegocio } from '@/lib/errors'
import { PRIMER_CODIGO, esCodigoDeBase, proximoCodigo } from '../codigo'

describe('esCodigoDeBase — RN-BAS-10', () => {
  it('acepta exactamente cuatro dígitos', () => {
    expect(esCodigoDeBase('0001')).toBe(true)
    expect(esCodigoDeBase('0040')).toBe(true)
    expect(esCodigoDeBase('9999')).toBe(true)
  })

  it('rechaza lo que tiene menos o más de cuatro', () => {
    expect(esCodigoDeBase('1')).toBe(false)
    expect(esCodigoDeBase('001')).toBe(false)
    expect(esCodigoDeBase('00001')).toBe(false)
  })

  it('rechaza cualquier cosa que no sea dígito', () => {
    expect(esCodigoDeBase('A-13')).toBe(false)
    expect(esCodigoDeBase('00 1')).toBe(false)
    expect(esCodigoDeBase('')).toBe(false)
  })
})

describe('proximoCodigo — el sistema propone', () => {
  it('arranca en 0001 cuando el parque está vacío', () => {
    expect(proximoCodigo([])).toBe(PRIMER_CODIGO)
    expect(PRIMER_CODIGO).toBe('0001')
  })

  it('sigue al que más alto esté', () => {
    expect(proximoCodigo(['0001', '0002', '0003'])).toBe('0004')
  })

  it('conserva los ceros a la izquierda al cruzar una decena', () => {
    expect(proximoCodigo(['0009'])).toBe('0010')
    expect(proximoCodigo(['0099'])).toBe('0100')
    expect(proximoCodigo(['0999'])).toBe('1000')
  })

  /*
   * La razón de fondo por la que esto sale del MÁXIMO y no del conteo. Son dos
   * causas distintas y las dos ocurren:
   *
   *   1. El operario puede pisar el número propuesto — las 40 bases que ya
   *      existen llegan con su sticker puesto.
   *   2. Un número descartado no se recicla (RN-CAT-11 aplicado a bases).
   *
   * Con `tomados.length + 1` el parque de abajo propondría `0003`, que ya está
   * tomado: el alta fallaría con STICKER_DUPLICADO y el operario no tendría
   * forma de saber por qué.
   */
  it('no cuenta: salta el hueco que deja un número pisado', () => {
    expect(proximoCodigo(['0001', '0002', '0040'])).toBe('0041')
  })

  it('tampoco recicla el número de una base descartada', () => {
    // 0002 se descartó y su fila sigue existiendo con `activa: false`.
    expect(proximoCodigo(['0001', '0002', '0003'])).toBe('0004')
  })

  it('no depende del orden en que vengan', () => {
    expect(proximoCodigo(['0040', '0001', '0002'])).toBe('0041')
  })

  /*
   * Con 9.999 bases el formato se quedó sin lugar. Preferimos que reviente acá
   * —donde el mensaje puede decir qué pasó— antes que devolver `10000` y que
   * el alta lo rechace por formato, o peor: que entre y rompa la convención
   * para todos los stickers impresos.
   */
  it('avisa cuando el formato de cuatro dígitos se agotó', () => {
    expect(() => proximoCodigo(['9999'])).toThrow(ErrorDeNegocio)
    expect(() => proximoCodigo(['9999'])).toThrow(/9999/)
  })

  it('ignora lo que no tenga forma de código, en vez de contarlo mal', () => {
    expect(proximoCodigo(['0001', 'BASE-VIEJA', '0002'])).toBe('0003')
  })
})
