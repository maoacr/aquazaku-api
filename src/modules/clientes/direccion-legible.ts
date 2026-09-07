/**
 * Cómo se escribe una dirección — M14.
 *
 * ── Por qué esto es una función y no un `.join()` en cada pantalla ──────────
 *
 * La dirección se muestra en la ficha del cliente, en el despacho, en el
 * préstamo de una base y en la lista de direcciones. Compuesta en cada lugar,
 * en tres meses hay tres formatos — y quien maneja el camión los lee como si
 * fueran direcciones distintas.
 *
 * ── El orden de los respaldos importa ───────────────────────────────────────
 *
 * Ningún campo es obligatorio, así que hay que decidir qué mostrar cuando falta
 * lo de arriba. El orden va de lo más preciso a lo menos:
 *
 *   1. La estructura —`CL 45 A # 12 B - 34`— si hay algo de ella
 *   2. La línea libre, para lo que no se descompone
 *   3. Las indicaciones: «al lado de la panadería»
 *   4. Las coordenadas, que ubican aunque nadie sepa decirlo con palabras
 *
 * Nunca devuelve vacío: la base garantiza que al menos uno existe
 * (`direcciones_ubicable`), y si aun así llegara vacía, decirlo es mejor que
 * pintar un renglón en blanco que se lee como un error de la pantalla.
 */

export interface PartesDeDireccion {
  viaTipo?: string | null
  viaNumero?: string | null
  viaLetra?: string | null
  placaNumero?: string | null
  placaLetra?: string | null
  placaSegundo?: string | null
  placaLetraFinal?: string | null
  complemento?: string | null
  municipio?: string | null
  departamento?: string | null
  direccion?: string | null
  indicaciones?: string | null
  latitud?: string | null
  longitud?: string | null
}

const hay = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== ''

/** `CL 45 A # 12 B - 34`, con lo que haya. */
function estructura(d: PartesDeDireccion): string {
  const via = [d.viaTipo, d.viaNumero, d.viaLetra].filter(hay).join(' ')
  const placa = [d.placaNumero, d.placaLetra].filter(hay).join(' ')
  const segundo = [d.placaSegundo, d.placaLetraFinal].filter(hay).join(' ')

  if (via === '' && placa === '' && segundo === '') return ''

  /*
   * El `#` solo aparece si hay algo después. `CL 45 #` es una dirección a
   * medias que se lee como un error de tipeo, y el guion igual: `# 12 -` deja
   * a quien la lee esperando un número que no viene.
   */
  const derecha = [placa, segundo].filter((p) => p !== '').join(' - ')

  return [via, derecha].filter((p) => p !== '').join(' # ')
}

export function direccionLegible(d: PartesDeDireccion): string {
  const partes: string[] = []

  const nomenclatura = estructura(d)
  if (nomenclatura !== '') partes.push(nomenclatura)
  else if (hay(d.direccion)) partes.push(d.direccion.trim())

  if (hay(d.complemento)) partes.push(d.complemento.trim())
  if (hay(d.municipio)) partes.push(d.municipio.trim())
  /*
   * El departamento va al final y solo si está: en el 99% de los casos es
   * «Atlántico» y repetirlo alarga la línea sin informar. Cuando aparece es
   * porque alguien lo cargó a propósito, y ahí sí distingue.
   */
  if (hay(d.departamento)) partes.push(d.departamento.trim())

  if (partes.length > 0) return partes.join(', ')

  // Sin nada que se parezca a una dirección, sirven las indicaciones.
  if (hay(d.indicaciones)) return d.indicaciones.trim()

  /*
   * Y si solo hay un pin: se muestra el pin. Ubica, aunque nadie haya sabido
   * decirlo con palabras — que es justamente el caso que este modelo vino a
   * permitir.
   */
  if (hay(d.latitud) && hay(d.longitud)) {
    return `Ubicación en el mapa (${Number(d.latitud).toFixed(5)}, ${Number(d.longitud).toFixed(5)})`
  }

  return 'Sin datos de ubicación'
}
