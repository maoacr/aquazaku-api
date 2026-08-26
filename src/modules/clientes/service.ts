import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Cliente, clientes } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import {
  DocumentoInvalido,
  type TipoDeDocumento,
  normalizarDocumento,
} from './documento'

/**
 * Alta, edición y baja de clientes — RN-CLI-01, 02, 13 y 16.
 *
 * El acceso lo decide `api/` con `requirePermission`; acá solo viven las reglas
 * de negocio.
 */

export interface DatosDeAlta {
  nombre: string
  tipo?: 'residencial' | 'comercial'
  tipoDocumento: TipoDeDocumento
  /** Como lo dictaron: con puntos, con guion o pelado. Se normaliza acá. */
  numeroDocumento: string
}

/**
 * El cruce entre CC y NIT — la mitigación de RN-CLI-08.
 *
 * No es un error: el mismo número puede existir como CC y como NIT porque el
 * NIT de una persona natural se basa en su cédula. Pero también puede ser un
 * duplicado entrando por la puerta de atrás.
 *
 * La base no puede distinguir los dos casos, y adivinarlo sería peor que
 * preguntar. Así que el sistema **advierte y sigue**: quien registra tiene el
 * dato de qué cliente ya existe con ese número y decide.
 */
export interface AvisoDeCruce {
  /** El cliente que ya tiene ese número, con el OTRO tipo de documento. */
  clienteExistente: { id: string; nombre: string; tipoDocumento: TipoDeDocumento }
  mensaje: string
}

export interface ResultadoDeAlta {
  cliente: Cliente
  /** `null` cuando no hay nada que confirmar. */
  aviso: AvisoDeCruce | null
}

const OTRO_TIPO: Record<TipoDeDocumento, TipoDeDocumento> = { CC: 'NIT', NIT: 'CC' }

/** Traduce el fallo de normalización a un error de negocio con su mensaje. */
function exigirDocumento(crudo: string): string {
  try {
    return normalizarDocumento(crudo)
  } catch (err) {
    if (err instanceof DocumentoInvalido) {
      // RN-CLI-13: el documento se exige al registrar, sin excepciones. Lo que
      // puede esperar es la VERIFICACIÓN, no el dato.
      throw new ErrorDeNegocio('DOCUMENTO_INVALIDO', 422, err.motivo)
    }
    throw err
  }
}

/** Busca el mismo número cargado con el otro tipo de documento. */
async function buscarCruce(
  tipo: TipoDeDocumento,
  numero: string,
  excepto?: string,
): Promise<AvisoDeCruce | null> {
  const condiciones = [
    eq(clientes.tipoDocumento, OTRO_TIPO[tipo]),
    eq(clientes.numeroDocumento, numero),
  ]
  if (excepto) condiciones.push(ne(clientes.id, excepto))

  const [existente] = await db.select().from(clientes).where(and(...condiciones))
  if (!existente) return null

  return {
    clienteExistente: {
      id: existente.id,
      nombre: existente.nombre,
      tipoDocumento: existente.tipoDocumento,
    },
    mensaje: `${existente.nombre} ya está registrado con el mismo número como ${existente.tipoDocumento}. Si es la misma persona, use ese registro en vez de crear otro: dos fichas parten su deuda y sus botellones en dos, y ninguna de las dos es real.`,
  }
}

export async function crearCliente(datos: DatosDeAlta): Promise<ResultadoDeAlta> {
  const nombre = datos.nombre.trim()
  if (nombre.length === 0) {
    throw new ErrorDeNegocio('NOMBRE_REQUERIDO', 422, 'el cliente necesita un nombre')
  }

  const numeroDocumento = exigirDocumento(datos.numeroDocumento)
  const aviso = await buscarCruce(datos.tipoDocumento, numeroDocumento)

  const [cliente] = await db
    .insert(clientes)
    .values({
      nombre,
      tipo: datos.tipo ?? 'residencial',
      tipoDocumento: datos.tipoDocumento,
      numeroDocumento,
    })
    .returning()

  return { cliente: cliente!, aviso }
}

export interface DatosDeEdicion {
  nombre?: string
  /** RN-CLI-16: un cliente pasa de residencial a comercial cuando abre un negocio. */
  tipo?: 'residencial' | 'comercial'
  tipoDocumento?: TipoDeDocumento
  numeroDocumento?: string
}

export async function editarCliente(
  id: string,
  datos: DatosDeEdicion,
): Promise<ResultadoDeAlta> {
  const actual = await clientePorId(id)

  const tipoDocumento = datos.tipoDocumento ?? actual.tipoDocumento
  const numeroDocumento =
    datos.numeroDocumento === undefined
      ? actual.numeroDocumento
      : exigirDocumento(datos.numeroDocumento)

  const cambioElDocumento =
    tipoDocumento !== actual.tipoDocumento || numeroDocumento !== actual.numeroDocumento

  const aviso = cambioElDocumento ? await buscarCruce(tipoDocumento, numeroDocumento, id) : null

  const [cliente] = await db
    .update(clientes)
    .set({
      ...(datos.nombre !== undefined && { nombre: datos.nombre.trim() }),
      ...(datos.tipo !== undefined && { tipo: datos.tipo }),
      tipoDocumento,
      numeroDocumento,
      updatedAt: new Date(),
    })
    .where(eq(clientes.id, id))
    .returning()

  return { cliente: cliente!, aviso }
}

/**
 * Baja = desactivar — RN-CLI-02.
 *
 * No existe borrar, y `DELETE` está revocado en la base: un cliente con
 * historial que desaparece deja ventas y botellones apuntando a nadie, y la
 * deuda sin dueño.
 */
export async function cambiarEstado(id: string, activo: boolean): Promise<Cliente> {
  await clientePorId(id)

  const [cliente] = await db
    .update(clientes)
    .set({ activo, updatedAt: new Date() })
    .where(eq(clientes.id, id))
    .returning()

  return cliente!
}

export async function clientePorId(id: string): Promise<Cliente> {
  const [cliente] = await db.select().from(clientes).where(eq(clientes.id, id))

  if (!cliente) {
    throw new ErrorDeNegocio('CLIENTE_NO_ENCONTRADO', 404, 'ese cliente no existe')
  }
  return cliente
}

export async function listarClientes(soloActivos = true): Promise<Cliente[]> {
  const consulta = db.select().from(clientes)

  return soloActivos
    ? consulta.where(eq(clientes.activo, true)).orderBy(clientes.nombre)
    : consulta.orderBy(clientes.nombre)
}
