import { DEPARTAMENTOS, MUNICIPIOS } from './catalogo'

/**
 * De lo que se guarda a lo que se muestra — M14.
 *
 * ── El contrato ─────────────────────────────────────────────────────────────
 *
 * En la base, todo en minúscula: `campo de la cruz`. Así dos filas que dicen lo
 * mismo son iguales, y buscar «suan» encuentra «Suan».
 *
 * En pantalla, la ortografía del DANE: `Campo de la Cruz`.
 *
 * ── Por qué hace falta el catálogo para volver ──────────────────────────────
 *
 * «Campo de la Cruz» NO se reconstruye desde `campo de la cruz`: un título
 * automático daría «Campo De La Cruz». Las preposiciones en minúscula no siguen
 * ninguna regla que se pueda aplicar a ciegas — dependen de cuál palabra es.
 *
 * Que dos municipios de departamentos distintos compartan nombre no importa
 * acá: se escriben igual, así que se muestran igual.
 *
 * ── Y lo que NO está en el catálogo ─────────────────────────────────────────
 *
 * Las veredas. El DANE lista municipios, no veredas, y Aquazaku reparte en
 * algunas. Un nombre que no está se muestra con la primera letra en mayúscula:
 * imperfecto, pero mejor que mostrar `vereda la peña` en una ficha.
 */

/** Sin tildes ni mayúsculas, para comparar lo que la gente escribe. */
function comparable(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const PROPIOS = new Map<string, string>()
for (const m of MUNICIPIOS) PROPIOS.set(comparable(m.nombre), m.nombre)
for (const d of DEPARTAMENTOS) PROPIOS.set(comparable(d.nombre), d.nombre)

/**
 * Cómo se guarda: minúscula, sin espacios de más.
 *
 * Las tildes se CONSERVAN. Sacarlas haría que `bogota` y `bogotá` sean la misma
 * fila —que es lo que se busca— pero también que lo guardado deje de ser el
 * nombre del lugar, y quien mire la base directamente vea algo mal escrito.
 * La comparación insensible a tildes vive en `comparable`, no en el dato.
 */
export function paraGuardar(nombre: string): string {
  return nombre.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Cómo se muestra: la ortografía del DANE si el nombre está en el catálogo. */
export function paraMostrar(guardado: string | null | undefined): string | null {
  if (!guardado || guardado.trim() === '') return null

  const propio = PROPIOS.get(comparable(guardado))
  if (propio) return propio

  // Una vereda, o cualquier cosa que el DANE no lista.
  return guardado.trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase())
}
