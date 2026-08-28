import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Proveedor, proveedores } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'

/**
 * Proveedores — RN-PRO-01.
 *
 * No expone borrado. No es un olvido: un proveedor con historial de compras se
 * desactiva, y la base ya le revocó el `DELETE` al rol de la aplicación
 * (migración 0011). Que acá tampoco exista el método cierra el círculo — no hay
 * forma de llamarlo por accidente.
 */

export async function listarProveedores(incluirInactivos = false): Promise<Proveedor[]> {
  const consulta = db.select().from(proveedores)

  if (incluirInactivos) return consulta.orderBy(asc(proveedores.nombre))

  return consulta.where(eq(proveedores.activo, true)).orderBy(asc(proveedores.nombre))
}

export async function crearProveedor(datos: {
  nombre: string
  nit?: string | undefined
  contacto?: string | undefined
}): Promise<Proveedor> {
  const nit = datos.nit?.trim() || null

  if (nit) {
    const [existente] = await db.select().from(proveedores).where(eq(proveedores.nit, nit))

    if (existente) {
      /*
       * Dos proveedores con el mismo NIT son el mismo cargado dos veces, y el
       * historial de compras queda partido entre los dos. El mensaje nombra al
       * que ya está para que quede claro que no hay que crear otro.
       */
      throw new ErrorDeNegocio(
        'NIT_DUPLICADO',
        409,
        `${existente.nombre} ya está cargado con ese NIT${existente.activo ? '' : ', desactivado'}`,
      )
    }
  }

  const [creado] = await db
    .insert(proveedores)
    .values({ nombre: datos.nombre.trim(), nit, contacto: datos.contacto?.trim() || null })
    .returning()

  return creado!
}

/**
 * Activar o desactivar — RN-PRO-01.
 *
 * Reactivar existe porque el caso real es «le volvimos a comprar»: la compra a
 * un proveedor inactivo se rechaza, y el camino correcto es reactivarlo, no
 * crear un duplicado con el mismo NIT.
 */
export async function cambiarEstado(id: string, activo: boolean): Promise<Proveedor> {
  const [cambiado] = await db
    .update(proveedores)
    .set({ activo })
    .where(eq(proveedores.id, id))
    .returning()

  if (!cambiado) throw new ErrorDeNegocio('PROVEEDOR_NO_ENCONTRADO', 404, 'ese proveedor no existe')

  return cambiado
}
