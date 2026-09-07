import { describe, expect, it } from 'vitest'
import { direccionLegible } from '@/modules/clientes/direccion-legible'

/**
 * Cómo se escribe una dirección — M14.
 *
 * Ningún campo es obligatorio, así que lo que se prueba acá es qué muestra el
 * sistema con cada combinación de lo que falta. Compuesta en cada pantalla, en
 * tres meses habría tres formatos — y quien maneja el camión los leería como
 * direcciones distintas.
 */

describe('la nomenclatura completa', () => {
  it('se escribe como la escribe la gente', () => {
    expect(
      direccionLegible({
        viaTipo: 'CL',
        viaNumero: '45',
        viaLetra: 'A',
        placaNumero: '12',
        placaLetra: 'B',
        placaSegundo: '34',
        municipio: 'Campo de la Cruz',
      }),
    ).toBe('CL 45 A # 12 B - 34, Campo de la Cruz')
  })

  it('el departamento va al final, cuando está', () => {
    expect(
      direccionLegible({
        viaTipo: 'CL',
        viaNumero: '5',
        placaNumero: '3',
        placaSegundo: '24',
        municipio: 'Suan',
        departamento: 'Atlántico',
      }),
    ).toBe('CL 5 # 3 - 24, Suan, Atlántico')
  })

  /*
   * En el 99% de los casos el departamento es «Atlántico» y repetirlo alarga la
   * línea sin informar. Cuando aparece es porque alguien lo cargó a propósito.
   */
  it('sin departamento no deja una coma colgando', () => {
    expect(direccionLegible({ viaTipo: 'CL', viaNumero: '5', municipio: 'Suan' })).toBe(
      'CL 5, Suan',
    )
  })

  it('el complemento va después de la placa y antes del municipio', () => {
    expect(
      direccionLegible({
        viaTipo: 'KR',
        viaNumero: '7',
        placaNumero: '32',
        placaSegundo: '16',
        complemento: 'Apto 302',
        municipio: 'Suan',
      }),
    ).toBe('KR 7 # 32 - 16, Apto 302, Suan')
  })
})

/**
 * ── Lo que falta no puede dejar signos huérfanos ────────────────────────────
 *
 * `CL 45 #` es una dirección a medias que se lee como un error de tipeo, y
 * `# 12 -` deja a quien la lee esperando un número que no viene.
 */
describe('con la estructura a medias', () => {
  it('sin placa no aparece el numeral', () => {
    expect(direccionLegible({ viaTipo: 'CL', viaNumero: '45' })).toBe('CL 45')
  })

  it('sin segundo número no aparece el guion', () => {
    expect(
      direccionLegible({ viaTipo: 'CL', viaNumero: '45', placaNumero: '12' }),
    ).toBe('CL 45 # 12')
  })

  it('solo el tipo de vía tampoco inventa nada', () => {
    expect(direccionLegible({ viaTipo: 'CL', municipio: 'Suan' })).toBe('CL, Suan')
  })
})

/**
 * ── El orden de los respaldos ───────────────────────────────────────────────
 *
 * De lo más preciso a lo menos. Es la decisión que hace que una dirección de
 * vereda se vea bien en vez de verse rota.
 */
describe('cuando no hay nomenclatura', () => {
  it('usa la línea libre', () => {
    expect(
      direccionLegible({ direccion: 'Vereda La Peña, casa de tabla azul', municipio: 'Suan' }),
    ).toBe('Vereda La Peña, casa de tabla azul, Suan')
  })

  it('la estructura le gana a la línea libre: es más precisa', () => {
    expect(
      direccionLegible({ viaTipo: 'CL', viaNumero: '5', direccion: 'por ahí cerca' }),
    ).toBe('CL 5')
  })

  it('sin dirección ninguna, sirven las indicaciones', () => {
    expect(direccionLegible({ indicaciones: 'al lado de la panadería' })).toBe(
      'al lado de la panadería',
    )
  })

  /*
   * Un pin ubica aunque nadie haya sabido decirlo con palabras. Es justamente
   * el caso que este modelo vino a permitir.
   */
  it('con solo el pin, muestra el pin', () => {
    expect(direccionLegible({ latitud: '10.376900', longitud: '-74.882500' })).toContain(
      '10.37690, -74.88250',
    )
  })

  it('nunca devuelve vacío: un renglón en blanco se lee como un error', () => {
    expect(direccionLegible({})).toBe('Sin datos de ubicación')
  })
})

describe('los espacios que la gente deja de más', () => {
  it('no producen dobles separadores', () => {
    expect(direccionLegible({ direccion: '  Vereda La Peña  ', municipio: '  Suan  ' })).toBe(
      'Vereda La Peña, Suan',
    )
  })

  it('un campo en blanco cuenta como ausente', () => {
    expect(direccionLegible({ viaTipo: '   ', direccion: 'la casa de la esquina' })).toBe(
      'la casa de la esquina',
    )
  })
})
