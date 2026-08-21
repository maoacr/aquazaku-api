import type { Producto } from '@/db/schema'

/**
 * Generación del código de producto — RN-CAT-11.
 *
 * El código NO es la identidad: esa es el `id`, igual que el documento no
 * identifica al cliente (RN-CLI-01). Sirve para que una persona lea, diga y
 * busque un producto — nada más. Si no se puede leer en voz alta, no hace falta
 * que exista: el UUID ya garantiza unicidad.
 *
 *   P20U_600ML   paca de 20 bolsas de 600 ml
 *   P50U_300ML   paca de 50 bolsas de 300 ml
 *   BOT_20L      recarga de botellón de 20 L
 *
 * Cada número trae su unidad pegada. Un `PACA-20-600` obliga a saber cuál de
 * los dos números es cuál; `P20U_600ML` se lee sin conocer la convención.
 */

export type PresentacionProducto = Producto['presentacion']

export interface DatosDeCodigo {
  presentacion: PresentacionProducto
  contenidoMl: number
  unidades: number
}

const ML_POR_LITRO = 1000

/**
 * El código lleva **cantidad y contenido**, que es justo lo que distingue un
 * producto de otro. Por eso dos productos distintos nunca generan el mismo
 * código y no hace falta desambiguar: la paca de 24 es `P24U_600ML`, no
 * `P20U_600ML-2`.
 *
 * Eso importa porque un sufijo contador no informa nada. Un `pos` que lee
 * `PACA-600-2` en pantalla no sabe si es la de 24, la reintroducida o la de
 * otra marca: tiene que abrir el detalle igual, y ahí el código ya falló.
 */
export function codigoBase({ presentacion, contenidoMl, unidades }: DatosDeCodigo): string {
  if (presentacion === 'botellon') {
    // El botellón se nombra en litros —"botellón de veinte litros"— y no lleva
    // cantidad porque siempre es uno: no distingue nada.
    return `BOT_${contenido(contenidoMl)}`
  }

  return `P${unidades}U_${contenidoMl}ML`
}

/**
 * Litros solo si el contenido es múltiplo exacto de 1000.
 *
 * Un `BOT_20.5L` metería un punto decimal adentro del código, y ahí nacen las
 * variantes al escribirlo a mano: `BOT_20,5L`, `BOT_205L`, `BOT_20_5L`. Se cae
 * a mililitros, que siempre son enteros.
 */
function contenido(contenidoMl: number): string {
  return contenidoMl % ML_POR_LITRO === 0
    ? `${contenidoMl / ML_POR_LITRO}L`
    : `${contenidoMl}ML`
}

/**
 * Resuelve la colisión contra los códigos ya tomados.
 *
 * `tomados` tiene que incluir **los productos inactivos** — RN-CAT-11: el
 * código de un producto desactivado sigue reservado. Reciclarlo haría que un
 * comprobante viejo parezca referirse al producto nuevo.
 *
 * Con el código llevando cantidad y contenido, la colisión queda para un solo
 * caso real: un producto que se desactivó y se reintroduce idéntico. Ahí el
 * sufijo sí significa algo — es la segunda encarnación, no un desempate
 * arbitrario.
 */
export function generarCodigo(datos: DatosDeCodigo, tomados: Iterable<string>): string {
  const base = codigoBase(datos)
  const ocupados = new Set(tomados)

  if (!ocupados.has(base)) return base

  let encarnacion = 2
  while (ocupados.has(`${base}_${encarnacion}`)) encarnacion++

  return `${base}_${encarnacion}`
}
