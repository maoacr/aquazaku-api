import { describe, expect, it } from 'vitest'
import { aCentavos, aMonto, calcularPrecio, totalDeLinea } from '@/modules/ventas/precio'

/**
 * El cálculo del precio — RN-VEN-12 y RN-VEN-13.
 *
 * Lo que se prueba no es la aritmética: es que **el piso no se pueda perforar**
 * y que el comprobante pueda explicarse a sí mismo. Un precio mal calculado no
 * lanza — devuelve un número, se cobra, y aparece en el arqueo.
 */

const LISTA = '10000.00'
const MINIMO = '8000.00'

describe('sin descuento', () => {
  it('se cobra el precio de lista', () => {
    const p = calcularPrecio(LISTA, MINIMO)

    expect(p.precioFinal).toBe('10000.00')
    expect(p.descuentoMonto).toBe('0.00')
    expect(p.aplicadoParcialmente).toBe(false)
  })
})

describe('el descuento que entra completo', () => {
  it('un monto fijo se resta tal cual', () => {
    const p = calcularPrecio(LISTA, MINIMO, { tipo: 'monto_fijo', valor: '1500.00' })

    expect(p.precioFinal).toBe('8500.00')
    expect(p.descuentoMonto).toBe('1500.00')
    expect(p.aplicadoParcialmente).toBe(false)
  })

  it('un porcentaje se calcula sobre la lista', () => {
    const p = calcularPrecio(LISTA, MINIMO, { tipo: 'porcentaje', valor: '15' })

    expect(p.descuentoMonto).toBe('1500.00')
    expect(p.precioFinal).toBe('8500.00')
  })
})

/**
 * ── El piso absoluto — RN-VEN-13 ────────────────────────────────────────────
 *
 * Un código mal definido no puede dejar una venta en cero o en negativo. Y la
 * venta NO se rechaza: se cobra el piso y se avisa. El cliente ya está ahí con
 * el botellón en la mano, y rechazarle la venta por un código que definió mal
 * un admin es cobrarle a él un error de otro.
 */
describe('el piso absoluto', () => {
  it('un descuento que lo perforaría cobra el piso, no menos', () => {
    const p = calcularPrecio(LISTA, MINIMO, { tipo: 'monto_fijo', valor: '5000.00' })

    expect(p.precioFinal).toBe('8000.00')
    expect(p.aplicadoParcialmente).toBe(true)
  })

  it('y el descuento que informa es el que SE APLICÓ, no el que prometía', () => {
    const p = calcularPrecio(LISTA, MINIMO, { tipo: 'monto_fijo', valor: '5000.00' })

    // La identidad que hace verificable el comprobante:
    // precioFinal = precioLista − descuentoMonto, siempre.
    expect(p.descuentoMonto).toBe('2000.00')
    expect(aCentavos(p.precioLista) - aCentavos(p.descuentoMonto)).toBe(
      aCentavos(p.precioFinal),
    )
  })

  it('un 100 % tampoco llega a cero', () => {
    const p = calcularPrecio(LISTA, MINIMO, { tipo: 'porcentaje', valor: '100' })

    expect(p.precioFinal).toBe('8000.00')
    expect(p.aplicadoParcialmente).toBe(true)
  })

  it('con el piso igual a la lista, ningún descuento entra', () => {
    const p = calcularPrecio(LISTA, LISTA, { tipo: 'porcentaje', valor: '50' })

    expect(p.precioFinal).toBe('10000.00')
    expect(p.descuentoMonto).toBe('0.00')
    expect(p.aplicadoParcialmente).toBe(true)
  })

  /**
   * Un piso por encima de la lista no es un caso de venta: es un catálogo mal
   * cargado. Cobrar el piso sería cobrarle al cliente MÁS que el precio
   * publicado, y en silencio.
   */
  it('un piso mayor que la lista es un error, no un precio', () => {
    expect(() => calcularPrecio('5000.00', '8000.00')).toThrow(/catálogo está mal cargado/)
  })
})

/**
 * ── Por qué todo se calcula en centavos enteros ─────────────────────────────
 *
 * `0.1 + 0.2 !== 0.3` también con pesos. Este test es el que se pondría en rojo
 * si alguien pasara la cuenta a floats: aparecerían centavos que no cierran en
 * un arqueo donde nadie los puede explicar.
 */
describe('la plata no se calcula con decimales', () => {
  it('un 15 % sobre tres ventas da lo mismo que sobre la suma', () => {
    const unaVez = calcularPrecio('30000.00', '0.01', { tipo: 'porcentaje', valor: '15' })
    const tresVeces = [0, 1, 2].reduce(
      (total, _) =>
        total + aCentavos(calcularPrecio('10000.00', '0.01', { tipo: 'porcentaje', valor: '15' }).descuentoMonto),
      0,
    )

    expect(tresVeces).toBe(aCentavos(unaVez.descuentoMonto))
  })

  it('los montos con centavos sobreviven la ida y la vuelta', () => {
    expect(aMonto(aCentavos('10000.05'))).toBe('10000.05')
    expect(aMonto(aCentavos('0.01'))).toBe('0.01')
  })

  /**
   * ── El test que de verdad protege el redondeo ────────────────────────────
   *
   * El primer test que escribí acá usaba montos demasiado limpios: pasaba
   * igual con el `Math.round` borrado. Buscando de verdad aparecieron **1.484**
   * combinaciones donde el redondeo cambia la salida.
   *
   * La peor es esta: $4,50 con 3 % da, sin redondear, `4.37 + 0.14 = 4.51`. El
   * comprobante deja de cuadrar consigo mismo por un centavo — y un centavo que
   * no cierra en un arqueo cuesta más tiempo de explicar que la venta entera.
   */
  it.each([
    ['4.50', '3'],
    ['2.75', '66'],
    ['6.25', '66'],
    ['4.50', '33'],
  ])('%s con %s por ciento cierra: lista − descuento = final', (lista, valor) => {
    const p = calcularPrecio(lista, '0.01', { tipo: 'porcentaje', valor })

    expect(aCentavos(p.precioLista) - aCentavos(p.descuentoMonto)).toBe(
      aCentavos(p.precioFinal),
    )
  })
})

describe('el total de la línea', () => {
  it('multiplica sin volver a decimales', () => {
    expect(totalDeLinea('8500.50', 3)).toBe('25501.50')
  })

  it('una cantidad de cero o fraccionaria no es una línea', () => {
    expect(() => totalDeLinea('100.00', 0)).toThrow()
    expect(() => totalDeLinea('100.00', 1.5)).toThrow()
  })
})

describe('un porcentaje inválido no se calcula a medias', () => {
  it.each([['-5'], ['101'], ['mucho']])('%s se rechaza', (valor) => {
    expect(() => calcularPrecio(LISTA, MINIMO, { tipo: 'porcentaje', valor })).toThrow()
  })
})
