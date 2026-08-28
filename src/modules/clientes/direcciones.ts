import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Direccion, direcciones } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
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
  direccion: string
  indicaciones?: string
}

export async function agregarDireccion(
  clienteId: string,
  datos: DatosDeDireccion,
): Promise<Direccion> {
  await clientePorId(clienteId)

  const etiqueta = datos.etiqueta.trim()
  const direccion = datos.direccion.trim()

  if (etiqueta.length === 0 || direccion.length === 0) {
    throw new ErrorDeNegocio(
      'DIRECCION_INCOMPLETA',
      422,
      'una dirección necesita cómo la llaman y dónde queda. Sin las dos cosas nadie sabe a dónde ir',
    )
  }

  const [creada] = await db
    .insert(direcciones)
    .values({
      clienteId,
      etiqueta,
      direccion,
      ...(datos.indicaciones?.trim() && { indicaciones: datos.indicaciones.trim() }),
    })
    .returning()

  return creada!
}

export async function direccionesDe(clienteId: string, soloActivas = true): Promise<Direccion[]> {
  const condiciones = [eq(direcciones.clienteId, clienteId)]
  if (soloActivas) condiciones.push(eq(direcciones.activa, true))

  return db.select().from(direcciones).where(and(...condiciones)).orderBy(direcciones.createdAt)
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
