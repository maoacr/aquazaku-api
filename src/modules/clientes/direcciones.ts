import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Direccion, direcciones } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { direccionLegible } from './direccion-legible'
import { clientePorId } from './service'

/**
 * Las direcciones de un cliente — RN-CLI-07.
 *
 * `Cliente 1—N Dirección`. Una base prestada se asigna a una dirección concreta,
 * no al cliente: sin eso no se puede contestar «¿a cuál de sus tres locales voy
 * a buscar la base #0913?», y el préstamo deja de ser reclamable.
 *
 * **Sin `ruta_id`**: las rutas son M8.
 */

export interface DatosDeDireccion {
  etiqueta: string

  /*
   * ── Todo lo demás es opcional, y es una decisión ─────────────────────────
   *
   * Aquazaku reparte en Campo de la Cruz y en pueblos vecinos. La nomenclatura
   * `CL 45 A # 12 B - 34` es urbana: hay direcciones que son «Vereda La Peña,
   * casa de tabla azul» y no se dejan descomponer.
   *
   * Exigir la estructura bloquearía el registro de un cliente REAL, y el
   * operador inventaría `CL 1 # 1-1` para poder guardar — perdiendo el dato y
   * ensuciando la base.
   */
  viaTipo?: string
  viaNumero?: string
  viaLetra?: string
  placaNumero?: string
  placaLetra?: string
  placaSegundo?: string
  placaLetraFinal?: string
  complemento?: string
  municipio?: string
  departamento?: string
  direccion?: string
  indicaciones?: string
  latitud?: number
  longitud?: number
}

/** Los campos de texto, para limpiarlos de una y no de a uno. */
const TEXTOS = [
  'viaTipo',
  'viaNumero',
  'viaLetra',
  'placaNumero',
  'placaLetra',
  'placaSegundo',
  'placaLetraFinal',
  'complemento',
  'municipio',
  'departamento',
  'direccion',
  'indicaciones',
] as const

export async function agregarDireccion(
  clienteId: string,
  datos: DatosDeDireccion,
): Promise<Direccion> {
  await clientePorId(clienteId)

  const etiqueta = datos.etiqueta.trim()

  if (etiqueta.length === 0) {
    throw new ErrorDeNegocio(
      'DIRECCION_SIN_ETIQUETA',
      422,
      'la dirección necesita cómo la llaman: «la casa», «el depósito». Es lo que el operador va a buscar en una lista',
    )
  }

  /*
   * Un campo con espacios no es un campo: se guarda como `null` para que la
   * invariante de la base lo cuente como ausente. Guardar `'  '` haría que una
   * dirección vacía pasara el CHECK diciendo que tiene municipio.
   */
  const limpios: Record<string, string | null> = {}
  for (const campo of TEXTOS) {
    const valor = datos[campo]?.trim()
    limpios[campo] = valor && valor.length > 0 ? valor : null
  }

  const ubicable =
    Object.values(limpios).some((v) => v !== null) || typeof datos.latitud === 'number'

  /*
   * ── La invariante, explicada ──────────────────────────────────────────────
   *
   * El CHECK de la base es la garantía; esto es el mensaje. Sin él, una
   * dirección vacía llega como un error de constraint que nadie puede leer, y
   * quien la escribió no sabe qué le falta (ADR-0006).
   */
  if (!ubicable) {
    throw new ErrorDeNegocio(
      'DIRECCION_NO_UBICABLE',
      422,
      'la dirección no dice dónde queda. Alcanza con cualquiera de estas: la nomenclatura, una línea escrita a mano, indicaciones para llegar, o el punto en el mapa',
    )
  }

  const [creada] = await db
    .insert(direcciones)
    .values({
      clienteId,
      etiqueta,
      ...limpios,
      ...(typeof datos.latitud === 'number' && {
        latitud: String(datos.latitud),
        longitud: String(datos.longitud),
      }),
    })
    .returning()

  return creada!
}

/**
 * La dirección, más cómo se escribe.
 *
 * `legible` viaja con el dato porque la función que la arma vive en `api` y
 * `web` no puede importarla. Si cada pantalla la compusiera, en tres meses
 * habría tres formatos — y quien maneja el camión los leería como direcciones
 * distintas.
 */
export type DireccionLegible = Direccion & { legible: string }

export async function direccionesDe(
  clienteId: string,
  soloActivas = true,
): Promise<DireccionLegible[]> {
  const condiciones = [eq(direcciones.clienteId, clienteId)]
  if (soloActivas) condiciones.push(eq(direcciones.activa, true))

  const filas = await db
    .select()
    .from(direcciones)
    .where(and(...condiciones))
    .orderBy(direcciones.createdAt)

  return filas.map((d) => ({ ...d, legible: direccionLegible(d) }))
}

/** Una dirección no se borra: se desactiva. Puede tener bases prestadas. */
export async function desactivarDireccion(id: string): Promise<Direccion> {
  const [direccion] = await db
    .update(direcciones)
    .set({ activa: false })
    .where(eq(direcciones.id, id))
    .returning()

  if (!direccion) {
    throw new ErrorDeNegocio('DIRECCION_NO_ENCONTRADA', 404, 'esa dirección no existe')
  }
  return direccion
}
