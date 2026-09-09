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
  /**
   * Un teléfono en el mismo alta — opcional.
   *
   * Reusa `esquemaDeTelefono` en vez de repetir el mínimo de siete dígitos: un
   * número que este esquema aceptara y el otro rechazara sería el mismo dato
   * válido por una puerta e inválido por la otra.
   *
   * Se declara con `get` porque `esquemaDeTelefono` está definido más abajo en
   * el archivo, junto al resto de los esquemas de sus recursos.
   */
  get telefono() {
    return esquemaDeTelefono.optional()
  },
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

/**
 * Una dirección — M14.
 *
 * Valida FORMA. Que la dirección ubique por algo lo decide el servicio: es una
 * regla de negocio con su propio mensaje, y además la base la garantiza con un
 * CHECK (`direcciones_ubicable`).
 *
 * Todos los campos de ubicación son opcionales a propósito: Aquazaku reparte en
 * pueblos donde hay direcciones que no se dejan descomponer.
 */
const textoCorto = z.string().trim().max(40).optional()

export const esquemaDeDireccion = z.object({
  etiqueta: z.string().trim().min(1, 'la dirección necesita cómo la llaman'),

  viaTipo: textoCorto,
  viaNumero: textoCorto,
  viaLetra: textoCorto,
  placaNumero: textoCorto,
  placaLetra: textoCorto,
  placaSegundo: textoCorto,
  placaLetraFinal: textoCorto,
  complemento: z.string().trim().max(80).optional(),
  municipio: z.string().trim().max(80).optional(),
  departamento: z.string().trim().max(80).optional(),

  direccion: z.string().trim().max(200).optional(),
  indicaciones: z.string().trim().max(300).optional(),

  /*
   * Los rangos del planeta. La base los vuelve a exigir con un CHECK; acá el
   * mensaje explica, que es lo que un constraint no hace.
   */
  latitud: z.coerce.number().min(-90).max(90).optional(),
  longitud: z.coerce.number().min(-180).max(180).optional(),
})

/**
 * Un teléfono — M14.
 *
 * Siete dígitos es el mínimo de un fijo en Colombia. No se valida el formato
 * más allá de eso: la gente escribe «300 123 4567», «(605) 8791234» y
 * «3001234567», y rechazar cualquiera de las tres por prolijidad haría que el
 * operador no cargue el número — que es el dato que hace falta para cobrar.
 */
export const esquemaDeTelefono = z.object({
  numero: z.string().trim().min(7, 'un teléfono tiene al menos 7 dígitos').max(30),
  etiqueta: z.string().trim().max(60).optional(),
})
