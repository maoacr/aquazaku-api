import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Proveedor, proveedores } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'

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

/**
 * El alta y su fila, una sola escritura — ADR-0007.
 *
 * Se clasificó sensible el 10-oct-2026: el NIT es lo que hace rastreable al
 * proveedor en la contabilidad, y si mañana aparecen dos filas con el mismo
 * NIT, esta bitácora es la que dice cuál se cargó primero y quién la cargó. Sin
 * ella, la única pista sería el duplicado.
 *
 * La transacción se crea acá: el alta era un `INSERT` suelto, y un INSERT
 * suelto no puede compartir destino con nada. De paso, el chequeo del NIT pasa
 * a leer DENTRO de la transacción.
 */
export async function crearProveedor(
  datos: {
    nombre: string
    nit?: string | undefined
    contacto?: string | undefined
  },
  contexto: ContextoDeAuditoria,
): Promise<Proveedor> {
  const nit = datos.nit?.trim() || null

  return db.transaction(async (tx) => {
    if (nit) {
      const [existente] = await tx.select().from(proveedores).where(eq(proveedores.nit, nit))

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

    const [creado] = await tx
      .insert(proveedores)
      .values({ nombre: datos.nombre.trim(), nit, contacto: datos.contacto?.trim() || null })
      .returning()

    await emit(
      {
        ...contexto,
        action: 'proveedores:crear',
        resource: 'proveedores',
        resourceId: creado!.id,
        result: 'ok',
        payload: {
          resourceId: creado!.id,
          nombre: creado!.nombre,
          nit: creado!.nit,
          contacto: creado!.contacto,
        },
      },
      tx,
    )

    return creado!
  })
}

/**
 * Activar o desactivar — RN-PRO-01.
 *
 * Reactivar existe porque el caso real es «le volvimos a comprar»: la compra a
 * un proveedor inactivo se rechaza, y el camino correcto es reactivarlo, no
 * crear un duplicado con el mismo NIT.
 */
export async function cambiarEstado(
  id: string,
  activo: boolean,
  contexto: ContextoDeAuditoria,
): Promise<Proveedor> {
  return db.transaction(async (tx) => {
    const [cambiado] = await tx
      .update(proveedores)
      .set({ activo })
      .where(eq(proveedores.id, id))
      .returning()

    if (!cambiado) {
      throw new ErrorDeNegocio('PROVEEDOR_NO_ENCONTRADO', 404, 'ese proveedor no existe')
    }

    /*
     * Los dos sentidos comparten acción porque comparten ruta, y el payload dice
     * en cuál quedó. Importa el SENTIDO, no solo que «se editó»: desactivar
     * cierra la puerta a comprarle y reactivar la vuelve a abrir, y eso decide a
     * quién se le puede girar plata.
     */
    await emit(
      {
        ...contexto,
        action: 'proveedores:editar',
        resource: 'proveedores',
        resourceId: cambiado.id,
        result: 'ok',
        payload: { resourceId: cambiado.id, nombre: cambiado.nombre, activo: cambiado.activo },
      },
      tx,
    )

    return cambiado
  })
}
