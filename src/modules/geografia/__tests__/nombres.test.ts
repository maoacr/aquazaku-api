import { describe, expect, it } from 'vitest'
import { paraGuardar, paraMostrar } from '@/modules/geografia/nombres'

/**
 * De lo que se guarda a lo que se muestra — M14.
 *
 * En la base, minúscula. En pantalla, la ortografía del DANE. El catálogo es lo
 * que hace posible el viaje de vuelta.
 */

describe('lo que se guarda', () => {
  it('va en minúscula, para que dos filas iguales lo sean', () => {
    expect(paraGuardar('Campo de la Cruz')).toBe('campo de la cruz')
    expect(paraGuardar('CAMPO DE LA CRUZ')).toBe('campo de la cruz')
  })

  it('sin espacios de más', () => {
    expect(paraGuardar('  Santa   Lucía  ')).toBe('santa lucía')
  })

  /*
   * Sacar las tildes haría que lo guardado deje de ser el nombre del lugar, y
   * quien mire la base vería algo mal escrito. La comparación insensible a
   * tildes vive en la búsqueda, no en el dato.
   */
  it('pero conserva las tildes', () => {
    expect(paraGuardar('Atlántico')).toBe('atlántico')
  })
})

/**
 * ── El caso que justifica todo el catálogo ──────────────────────────────────
 *
 * Un título automático sobre `campo de la cruz` daría «Campo De La Cruz». Las
 * preposiciones en minúscula no siguen una regla aplicable a ciegas: dependen
 * de cuál palabra es.
 */
describe('lo que se muestra', () => {
  it('devuelve la ortografía del DANE, no un título automático', () => {
    expect(paraMostrar('campo de la cruz')).toBe('Campo de la Cruz')
    expect(paraMostrar('palmar de varela')).toBe('Palmar de Varela')
  })

  it('con tildes, aunque se hayan escrito sin ellas', () => {
    expect(paraMostrar('santa lucia')).toBe('Santa Lucía')
    expect(paraMostrar('atlantico')).toBe('Atlántico')
  })

  it('las siglas quedan intactas', () => {
    expect(paraMostrar('bogotá, d.c.')).toBe('Bogotá, D.C.')
  })

  /*
   * El DANE lista municipios, no veredas — y Aquazaku reparte en algunas.
   */
  it('lo que no está en el catálogo se muestra igual, capitalizado', () => {
    expect(paraMostrar('vereda la peña')).toBe('Vereda la peña')
  })

  it('vacío es null, no una cadena en blanco', () => {
    expect(paraMostrar('')).toBeNull()
    expect(paraMostrar(null)).toBeNull()
  })
})
