import { describe, expect, it } from 'vitest'
import { codigoBase, generarCodigo } from '../codigo'

const PACA_600 = { presentacion: 'paca', contenidoMl: 600, unidades: 20 } as const
const PACA_300 = { presentacion: 'paca', contenidoMl: 300, unidades: 50 } as const
const BOTELLON = { presentacion: 'botellon', contenidoMl: 20000, unidades: 1 } as const

describe('codigoBase — RN-CAT-11', () => {
  it('genera los tres productos reales de Aquazaku', () => {
    expect(codigoBase(PACA_600)).toBe('P20U_600ML')
    expect(codigoBase(PACA_300)).toBe('P50U_300ML')
    expect(codigoBase(BOTELLON)).toBe('BOT_20L')
  })

  it('el botellón no lleva cantidad: siempre es uno y no distingue nada', () => {
    expect(codigoBase(BOTELLON)).not.toContain('1U')
  })

  describe('el botellón cae a mililitros si no da litros exactos', () => {
    it('usa litros cuando el contenido es múltiplo de 1000', () => {
      expect(codigoBase({ ...BOTELLON, contenidoMl: 12000 })).toBe('BOT_12L')
    })

    it('usa mililitros cuando no lo es, para no meter un punto decimal', () => {
      expect(codigoBase({ ...BOTELLON, contenidoMl: 20500 })).toBe('BOT_20500ML')
    })
  })
})

describe('dos productos distintos nunca generan el mismo código', () => {
  it('la paca de 24 que anticipa RN-PRD-01 no choca con la de 20', () => {
    const veinte = codigoBase(PACA_600)
    const veinticuatro = codigoBase({ ...PACA_600, unidades: 24 })

    expect(veinticuatro).toBe('P24U_600ML')
    expect(veinticuatro).not.toBe(veinte)
  })

  it('una bolsa de 500 ml tampoco choca', () => {
    expect(codigoBase({ presentacion: 'paca', contenidoMl: 500, unidades: 24 })).toBe('P24U_500ML')
  })

  it('el generador no agrega sufijo cuando no hay colisión real', () => {
    expect(generarCodigo({ ...PACA_600, unidades: 24 }, ['P20U_600ML'])).toBe('P24U_600ML')
  })
})

describe('generarCodigo — colisión', () => {
  it('devuelve el código base cuando está libre', () => {
    expect(generarCodigo(PACA_600, [])).toBe('P20U_600ML')
  })

  it('un producto idéntico reintroducido es la segunda encarnación', () => {
    expect(generarCodigo(PACA_600, ['P20U_600ML'])).toBe('P20U_600ML_2')
  })

  it('sigue contando si hubo varias reintroducciones', () => {
    const tomados = ['P20U_600ML', 'P20U_600ML_2', 'P20U_600ML_3']

    expect(generarCodigo(PACA_600, tomados)).toBe('P20U_600ML_4')
  })

  it('toma el primer sufijo libre, aunque quede un hueco intermedio', () => {
    // Un hueco solo puede significar que ese código nunca se usó: no existe
    // DELETE sobre productos (RN-CAT-02), así que ningún código desaparece de
    // la tabla. Ocuparlo no pisa el pasado de nadie.
    const tomados = ['P20U_600ML', 'P20U_600ML_3']

    expect(generarCodigo(PACA_600, tomados)).toBe('P20U_600ML_2')
  })

  it('el código de un producto DESACTIVADO sigue tomado — RN-CAT-11', () => {
    // Quien llame al generador tiene que pasar también los inactivos.
    const tomadosIncluyendoInactivos = ['P20U_600ML']

    expect(generarCodigo(PACA_600, tomadosIncluyendoInactivos)).toBe('P20U_600ML_2')
  })
})
