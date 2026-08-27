/**
 * El precio de una línea de venta — RN-VEN-12 y RN-VEN-13.
 *
 * ── Por qué esto es una compuerta ───────────────────────────────────────────
 *
 * Como el dígito de verificación en M5, **un precio mal calculado no falla**:
 * devuelve un número. Un descuento aplicado de más cobra de menos y aparece
 * recién en el arqueo; uno que perfora el piso deja una venta bajo costo que
 * solo se ve sumando el mes.
 *
 * Por eso vive acá, sin base de datos, y se prueba antes de que nada dependa
 * de él.
 *
 * ── Todo se calcula en CENTAVOS enteros ─────────────────────────────────────
 *
 * `0.1 + 0.2 !== 0.3` también con pesos. Con floats, un 15 % sobre tres ventas
 * de $10.000 no da lo mismo que sobre una de $30.000, y la diferencia aparece
 * como centavos que no cierran en un arqueo donde nadie los puede explicar.
 *
 * La base guarda `numeric(12,2)`, que es exacto. El agujero está en el medio —
 * en JavaScript— y se tapa no usando decimales adentro.
 */

export type TipoDeDescuento = 'porcentaje' | 'monto_fijo'

export interface Descuento {
  tipo: TipoDeDescuento
  /** `'15'` para 15 %, o `'2000.00'` para un monto fijo. */
  valor: string
}

export interface PrecioCalculado {
  precioLista: string
  /**
   * Lo que REALMENTE se descontó, no lo que el código prometía.
   *
   * Si el descuento nominal habría perforado el piso, acá va el recorte que sí
   * se aplicó. Eso mantiene una identidad que hace verificable el comprobante:
   * `precioFinal = precioLista − descuentoMonto`, siempre.
   */
  descuentoMonto: string
  /** Congelado en la línea: es lo que hace intra-fila el `CHECK` del piso. */
  precioMinimo: string
  precioFinal: string
  /**
   * `true` cuando el código valía más de lo que el piso permitía descontar.
   *
   * La venta NO se rechaza: se cobra el piso y se avisa. El cliente ya está ahí
   * con el botellón en la mano, y rechazarle la venta por un código mal
   * definido por un admin es cobrarle a él un error de otro.
   */
  aplicadoParcialmente: boolean
}

/** `'10000.50'` → `1000050`. Redondea al centavo: la base no guarda más. */
export function aCentavos(monto: string): number {
  const numero = Number(monto)

  if (!Number.isFinite(numero)) {
    throw new Error(`«${monto}» no es un monto`)
  }
  return Math.round(numero * 100)
}

/** `1000050` → `'10000.50'`, que es como la base lo espera. */
export function aMonto(centavos: number): string {
  return (centavos / 100).toFixed(2)
}

/**
 * Cuánto descuenta un código, en centavos, **antes** de mirar el piso.
 *
 * El porcentaje se redondea al centavo más cercano. Redondear siempre hacia
 * abajo favorecería sistemáticamente a la empresa por fracciones que nadie
 * decidió; hacia arriba, al revés. El redondeo simétrico no favorece a nadie.
 */
function descuentoEnCentavos(listaCentavos: number, descuento: Descuento): number {
  if (descuento.tipo === 'monto_fijo') return aCentavos(descuento.valor)

  const porcentaje = Number(descuento.valor)

  if (!Number.isFinite(porcentaje) || porcentaje < 0 || porcentaje > 100) {
    throw new Error(`«${descuento.valor}» no es un porcentaje entre 0 y 100`)
  }

  return Math.round((listaCentavos * porcentaje) / 100)
}

/**
 * El cálculo de RN-VEN-13, en una función.
 *
 * ```
 * precio_final = max(precio_lista − descuento, precio_minimo)
 * ```
 *
 * El piso es la red de seguridad: un código mal definido no puede dejar una
 * venta en cero o en negativo. Y es un PISO y no un interruptor «puede llegar a
 * cero» porque el piso es un número que alguien decidió por producto — el
 * interruptor sería una decisión tomada una vez para todos.
 */
export function calcularPrecio(
  precioLista: string,
  precioMinimo: string,
  descuento?: Descuento,
): PrecioCalculado {
  const lista = aCentavos(precioLista)
  const minimo = aCentavos(precioMinimo)

  if (minimo > lista) {
    /*
     * Un piso por encima del precio de lista no es un caso de venta: es un
     * catálogo mal cargado. `api/` ya lo impide al fijar precios, pero si
     * llegara igual, cobrar el piso sería cobrarle al cliente MÁS que el precio
     * publicado — y en silencio.
     */
    throw new Error(
      `el precio mínimo (${precioMinimo}) es mayor que el de lista (${precioLista}): el catálogo está mal cargado`,
    )
  }

  const nominal = descuento ? descuentoEnCentavos(lista, descuento) : 0
  const permitido = Math.min(nominal, lista - minimo)
  const aplicado = Math.max(0, permitido)

  return {
    precioLista: aMonto(lista),
    descuentoMonto: aMonto(aplicado),
    precioMinimo: aMonto(minimo),
    precioFinal: aMonto(lista - aplicado),
    aplicadoParcialmente: aplicado < nominal,
  }
}

/** El total de una línea: precio final × cantidad, sin volver a decimales. */
export function totalDeLinea(precioFinal: string, cantidad: number): string {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error('la cantidad de una línea es un entero positivo')
  }

  return aMonto(aCentavos(precioFinal) * cantidad)
}
