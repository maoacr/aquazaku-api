import { ErrorDeNegocio } from '@/lib/errors'

/**
 * El código de la base — RN-BAS-10.
 *
 * ── Por qué NO se parece al código de producto ──────────────────────────────
 *
 * `productos/codigo.ts` genera `P20U_600ML` codificando **en qué se diferencia**
 * ese producto de los demás: presentación, unidades y contenido. Un `pos` lee el
 * código y sabe qué es sin abrir el detalle.
 *
 * Acá eso es imposible, y no por una limitación técnica: `RN-BAS-09` dice que hay
 * **una sola clase de base, sin SKU**. Todas son idénticas. No existe atributo
 * que codificar, así que el número no puede significar nada más que «la
 * siguiente».
 *
 * Copiar el patrón de productos habría producido el mismo string para las
 * cuarenta.
 *
 * ── Cuatro dígitos, y el sticker manda ──────────────────────────────────────
 *
 * `0001` a `9999`. Aquazaku ya tiene 40 bases con su sticker pegado, así que el
 * mundo físico es dueño del número de esas: el sistema **propone** el próximo y
 * el operario puede pisarlo con lo que dice el sticker que tiene en la mano.
 *
 * Ese mismo camino cubre el caso que `RN-BAS-10` ya advierte —un sticker
 * ilegible que hay que reemplazar— sin necesitar un parche después.
 */

/** Cuatro dígitos exactos. Los ceros a la izquierda son parte del código. */
const FORMATO = /^\d{4}$/

export const PRIMER_CODIGO = '0001'

const DIGITOS = 4
const ULTIMO = 9999

export function esCodigoDeBase(valor: string): boolean {
  return FORMATO.test(valor)
}

/**
 * El próximo código sale del **máximo**, nunca del conteo.
 *
 * Son dos causas distintas y las dos pasan de verdad:
 *
 *   1. El operario pisa el número propuesto, porque el sticker ya estaba pegado.
 *   2. Un número descartado no se recicla. `RN-CAT-11` ya lo resolvió para
 *      productos —«el código de un producto desactivado sigue reservado»— y acá
 *      pesa más: una base descartada puede tener un recargo por daño de
 *      RN-BAS-08 apuntándole. Si una base nueva tomara ese número, el cobro
 *      quedaría ambiguo.
 *
 * Las dos dejan huecos. Con `tomados.length + 1`, un parque `0001, 0002, 0040`
 * propondría `0003` —ya tomado—, y el alta fallaría con `STICKER_DUPLICADO`
 * sin que el operario pueda entender por qué.
 */
export function proximoCodigo(tomados: Iterable<string>): string {
  let maximo = 0

  for (const codigo of tomados) {
    /*
     * Lo que no tenga forma de código se ignora en vez de romper el `parseInt`.
     * No debería existir —la validación no lo deja entrar—, pero si alguna vez
     * entra por una migración, es preferible proponer un número usable a caerse.
     */
    if (!esCodigoDeBase(codigo)) continue

    const numero = Number.parseInt(codigo, 10)
    if (numero > maximo) maximo = numero
  }

  if (maximo >= ULTIMO) {
    throw new ErrorDeNegocio(
      'CODIGOS_AGOTADOS',
      422,
      `el parque llegó a la base 9999 y el formato de cuatro dígitos no da para más. Ampliarlo obliga a reimprimir la convención de los stickers, así que es una decisión, no un ajuste`,
    )
  }

  return String(maximo + 1).padStart(DIGITOS, '0')
}
