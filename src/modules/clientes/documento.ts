/**
 * El documento del cliente — RN-CLI-08, RN-CLI-09 y RN-CLI-13.
 *
 * ── El dígito de verificación NO se guarda ──────────────────────────────────
 *
 * Es la excepción a la regla que este proyecto viene aplicando desde M2: la
 * fecha de vencimiento se guarda en vez de calcularse, la equivalencia
 * kilo→unidad se guarda en el movimiento, el caudal se guarda en el cierre.
 * Tres veces lo mismo — **un hecho de un momento se almacena, nunca se
 * regenera**.
 *
 * El DV no es un hecho de un momento. **No tiene momento.** Es aritmética sobre
 * un número que ya está guardado, definida por la Orden Administrativa 4 de 1989
 * de la DIAN: mismo número, mismo dígito, siempre. Guardarlo duplicaría un dato
 * derivable y abriría la puerta a que las dos copias digan cosas distintas.
 *
 * Y el dominio ya lo resolvió: RN-CLI-09 dice que **no hace falta pedirlo**. Si
 * no se pide, tampoco hay un valor dictado por el cliente que preservar.
 */

/**
 * Los pesos, como primos consecutivos.
 *
 * ── Por qué la lista completa y no la tabla de nueve de la norma ────────────
 *
 * La norma tabula NUEVE pesos: `41, 37, 29, 23, 19, 17, 13, 7, 3`. Pero las
 * cédulas colombianas actuales tienen **diez** dígitos, y el NIT de una persona
 * natural se basa en su cédula.
 *
 * Con nueve pesos, el primer dígito de un número de diez queda **sin
 * multiplicar**. Para `1010101010` la suma truncada da 84 contra 127 de la
 * completa — y las dos formas devuelven un dígito. Ese es el problema: no falla,
 * miente.
 *
 * Aplicados de derecha a izquierda y tomando tantos como dígitos tenga el
 * número, para nueve dan exactamente la tabla de la norma. Para diez entra
 * además el 43.
 */
const PESOS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71] as const

/** El número más largo que se puede calcular con la tabla de pesos. */
export const MAXIMO_DE_DIGITOS = PESOS.length

export class DocumentoInvalido extends Error {
  constructor(readonly motivo: string) {
    super(motivo)
    this.name = 'DocumentoInvalido'
  }
}

/**
 * Deja el número como se guarda: solo dígitos.
 *
 * La gente escribe `900.123.456-8`, `900123456 - 8` o `900 123 456`. Lo que se
 * guarda es el número base, sin puntos, sin espacios y **sin el DV**: el DV se
 * calcula, así que arrastrarlo adentro del número lo convertiría en parte de la
 * identidad y dos escrituras del mismo documento dejarían de ser iguales.
 */
export function normalizarDocumento(crudo: string): string {
  const soloDigitos = crudo.replace(/\D/g, '')

  if (soloDigitos.length === 0) {
    throw new DocumentoInvalido('el documento no tiene ningún dígito')
  }

  /*
   * Los ceros a la izquierda se van. Sin esto, `079123456` y `79123456` serían
   * dos clientes distintos para el UNIQUE, y son la misma persona — el duplicado
   * entraría por la puerta de atrás que RN-CLI-08 justamente viene a cerrar.
   */
  const sinCeros = soloDigitos.replace(/^0+/, '')

  if (sinCeros.length === 0) {
    throw new DocumentoInvalido('un documento de solo ceros no identifica a nadie')
  }

  if (sinCeros.length > MAXIMO_DE_DIGITOS) {
    throw new DocumentoInvalido(
      `un documento de ${sinCeros.length} dígitos no existe: el más largo que la DIAN calcula tiene ${MAXIMO_DE_DIGITOS}`,
    )
  }

  return sinCeros
}

/**
 * El dígito de verificación de un número base — módulo 11 con pesos primos.
 *
 * ```
 * 900123456  →  suma 586  →  586 mod 11 = 3  →  DV = 11 − 3 = 8
 * 79123456   →  suma 737  →  737 mod 11 = 0  →  DV = 0
 * ```
 *
 * El caso `resto = 0` es el que se escribe mal por reflejo: ahí el DV **es**
 * cero, no `11 − 0`. Lo mismo con `resto = 1`.
 *
 * Recibe el número YA normalizado. Pedirlo así y no normalizar acá deja una sola
 * definición de qué es el número base — la de `normalizarDocumento`.
 */
export function digitoDeVerificacion(numeroBase: string): number {
  const suma = [...numeroBase]
    .reverse()
    .reduce((total, digito, i) => total + Number(digito) * PESOS[i]!, 0)

  const resto = suma % 11

  return resto < 2 ? resto : 11 - resto
}

export type TipoDeDocumento = 'CC' | 'NIT'

/**
 * El documento como se muestra.
 *
 * El guion del NIT no separa dos datos: separa el número de su DV. Una CC se
 * escribe sin DV — el dígito existe igual (el NIT de esa persona lo usa) pero
 * nadie escribe una cédula con guion, y mostrarlo así confundiría los dos
 * documentos.
 */
export function documentoParaMostrar(tipo: TipoDeDocumento, numeroBase: string): string {
  return tipo === 'NIT' ? `${numeroBase}-${digitoDeVerificacion(numeroBase)}` : numeroBase
}
