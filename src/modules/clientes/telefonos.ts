import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Telefono, telefonos } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { clientePorId } from './service'

/**
 * Los teléfonos de un cliente — M14.
 *
 * ── Por qué una tabla y no una columna ──────────────────────────────────────
 *
 * Un cliente comercial tiene el celular del dueño y el fijo del local. En una
 * casa, el número puede ser el del vecino que recibe los recados. Cuál es cuál
 * lo dice la etiqueta, y con una sola columna esa distinción no cabe.
 *
 * Lo pidió la primera demo: se había construido la cartera por edad para saber a
 * quién llamar primero, y no había a qué número llamar.
 */

export interface DatosDeTelefono {
  numero: string
  etiqueta?: string
}

export async function agregarTelefono(
  clienteId: string,
  datos: DatosDeTelefono,
): Promise<Telefono> {
  await clientePorId(clienteId)

  const numero = datos.numero.trim()

  /*
   * El mismo número dos veces en el mismo cliente no es un error del sistema,
   * pero sí un dato que confunde: quien lo mire va a pensar que son dos
   * contactos distintos y va a llamar dos veces al mismo lugar.
   */
  const [repetido] = await db
    .select({ id: telefonos.id })
    .from(telefonos)
    .where(
      and(
        eq(telefonos.clienteId, clienteId),
        eq(telefonos.numero, numero),
        eq(telefonos.activo, true),
      ),
    )

  if (repetido) {
    throw new ErrorDeNegocio(
      'TELEFONO_REPETIDO',
      409,
      `este cliente ya tiene el ${numero}. Dos veces el mismo número se lee como dos contactos, y alguien va a llamar dos veces al mismo lugar`,
    )
  }

  const [creado] = await db
    .insert(telefonos)
    .values({
      clienteId,
      numero,
      ...(datos.etiqueta?.trim() && { etiqueta: datos.etiqueta.trim() }),
    })
    .returning()

  return creado!
}

export async function telefonosDe(clienteId: string, soloActivos = true): Promise<Telefono[]> {
  const condiciones = [eq(telefonos.clienteId, clienteId)]
  if (soloActivos) condiciones.push(eq(telefonos.activo, true))

  return db
    .select()
    .from(telefonos)
    .where(and(...condiciones))
    .orderBy(asc(telefonos.createdAt))
}

/**
 * Un teléfono no se borra: se desactiva.
 *
 * Si desapareciera de la base, el historial de a quién se llamó y cuándo
 * quedaría apuntando a un número que ya no existe en ningún lado.
 */
export async function desactivarTelefono(id: string): Promise<Telefono> {
  const [actualizado] = await db
    .update(telefonos)
    .set({ activo: false })
    .where(eq(telefonos.id, id))
    .returning()

  if (!actualizado) {
    throw new ErrorDeNegocio('TELEFONO_NO_ENCONTRADO', 404, 'ese teléfono no existe')
  }

  return actualizado
}
