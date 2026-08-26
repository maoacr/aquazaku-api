import { z } from 'zod'

/**
 * Esquemas de clientes — M5.
 *
 * Validan **forma**, no reglas de negocio. Que el crédito exija verificación, o
 * que un cruce CC/NIT avise, lo decide el servicio: una regla, un código de
 * error, un lugar.
 */

const tipoDocumento = z.enum(['CC', 'NIT'])
const tipoCliente = z.enum(['residencial', 'comercial'])

/**
 * El número llega COMO LO DICTARON.
 *
 * No se valida el formato acá: la gente escribe `900.123.456-8` o
 * `900 123 456`, y las dos son el mismo documento. Normalizar es del servicio,
 * que tiene una sola definición de qué es el número base — y rechazar formatos
 * en el borde obligaría a mantener esa definición en dos lugares.
 */
const numeroDocumento = z.string().min(1, 'el documento es obligatorio')

export const esquemaDeAlta = z.object({
  nombre: z.string().trim().min(1, 'el cliente necesita un nombre'),
  tipo: tipoCliente.optional(),
  tipoDocumento,
  numeroDocumento,
})

export const esquemaDeEdicion = z
  .object({
    nombre: z.string().trim().min(1).optional(),
    tipo: tipoCliente.optional(),
    tipoDocumento: tipoDocumento.optional(),
    numeroDocumento: numeroDocumento.optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'no hay nada que cambiar',
  })

export const esquemaDeEstado = z.object({ activo: z.boolean() })

/**
 * Habilitar crédito NO acepta el estado de verificación, y eso es RN-CLI-15
 * hecha contrato: no hay override que valga. La condición se lee del cliente,
 * nunca del pedido.
 */
export const esquemaDeCredito = z.object({
  habilitado: z.boolean(),
  /** `null` explícito es «sin tope». Omitirlo conserva el que estaba. */
  limite: z.number().positive('un límite de cero o menos no es un límite').nullable().optional(),
})

export const esquemaDeReversion = z.object({
  motivo: z
    .string()
    .trim()
    .min(10, 'desmarcar una verificación necesita explicación: alguien había respondido por ese documento'),
})

export const esquemaDeDireccion = z.object({
  etiqueta: z.string().trim().min(1, 'la dirección necesita cómo la llaman'),
  direccion: z.string().trim().min(1, 'la dirección necesita dónde queda'),
  indicaciones: z.string().trim().optional(),
})
