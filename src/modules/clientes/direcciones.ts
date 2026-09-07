import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Direccion, direcciones } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { paraGuardar } from '@/modules/geografia/nombres'
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

  const { etiqueta, limpios, coordenadas } = normalizar(datos)

  const [creada] = await db
    .insert(direcciones)
    .values({ clienteId, etiqueta, ...limpios, ...coordenadas })
    .returning()

  return creada!
}

/**
 * Las reglas que comparten el alta y la edición.
 *
 * Duplicadas, la edición podría aceptar una dirección que el alta rechaza —y
 * nadie lo notaría hasta que alguien edite una y la deje sin nada que la
 * ubique.
 */
function normalizar(datos: DatosDeDireccion): {
  etiqueta: string
  limpios: Record<string, string | null>
  coordenadas: Record<string, string>
} {
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
    if (!valor || valor.length === 0) {
      limpios[campo] = null
      continue
    }

    /*
     * Municipio y departamento van en MINÚSCULA. Así dos filas que dicen lo
     * mismo son iguales, y buscar «suan» encuentra «Suan». La ortografía buena
     * se recupera del catálogo del DANE al mostrarlas.
     */
    limpios[campo] =
      campo === 'municipio' || campo === 'departamento' ? paraGuardar(valor) : valor
  }

  /*
   * ── Qué cuenta como «ubica» ───────────────────────────────────────────────
   *
   * La MISMA lista que el CHECK `direcciones_ubicable` de la migración 0014.
   * No es «cualquier campo lleno»: un municipio solo no ubica nada — a «Suan»
   * no se le puede entregar agua.
   *
   * Esta lista y la del CHECK tienen que decir lo mismo. Antes no lo decían: el
   * servicio aceptaba una dirección con solo municipio y la base la rechazaba,
   * así que el operador veía un error de constraint sin explicación. Lo
   * encontró un test, no una lectura.
   */
  const UBICAN = ['viaTipo', 'viaNumero', 'placaNumero', 'direccion', 'indicaciones'] as const

  const ubicable =
    UBICAN.some((campo) => limpios[campo] !== null) || typeof datos.latitud === 'number'

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

  return {
    etiqueta,
    limpios,
    /*
     * Las coordenadas van de a dos o no van: media coordenada no ubica nada, y
     * la base lo vuelve a exigir con un CHECK.
     */
    coordenadas:
      typeof datos.latitud === 'number' && typeof datos.longitud === 'number'
        ? { latitud: String(datos.latitud), longitud: String(datos.longitud) }
        : {},
  }
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

/**
 * Editar una dirección — M14.
 *
 * ── Se reemplaza entera, no campo por campo ─────────────────────────────────
 *
 * El formulario manda todo lo que tiene, y lo que el operador borró llega
 * ausente. Con un merge parcial, vaciar un campo sería imposible: mandar
 * «municipio: nada» se interpretaría como «no lo toques», y el dato viejo
 * quedaría para siempre.
 *
 * La invariante se revalida: una edición puede dejar la dirección sin nada que
 * la ubique, igual que un alta.
 */
export async function editarDireccion(
  id: string,
  datos: DatosDeDireccion,
): Promise<DireccionLegible> {
  const [existe] = await db.select().from(direcciones).where(eq(direcciones.id, id))

  if (!existe) {
    throw new ErrorDeNegocio('DIRECCION_NO_ENCONTRADA', 404, 'esa dirección no existe')
  }

  const { etiqueta, limpios, coordenadas } = normalizar(datos)

  const [actualizada] = await db
    .update(direcciones)
    .set({ etiqueta, ...limpios, ...coordenadas })
    .where(eq(direcciones.id, id))
    .returning()

  return { ...actualizada!, legible: direccionLegible(actualizada!) }
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
