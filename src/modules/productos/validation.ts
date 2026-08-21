import { z } from 'zod'

/**
 * Esquemas del catálogo — M1.
 *
 * Validan **forma**, no reglas de negocio. El piso de precio (RN-CAT-04) lo
 * verifica el servicio y lo garantiza un CHECK en la base: si además lo
 * validara Zod, el mismo problema devolvería dos códigos distintos según quién
 * lo atrapara primero, y el frontend tendría que manejar los dos.
 *
 * Una regla, un código de error, un lugar.
 */

/**
 * Un monto en pesos, como string.
 *
 * String y no `number` porque la columna es `numeric` y Drizzle la lee y
 * escribe como texto: pasar por un float del lenguaje es exactamente donde se
 * pierde el peso que después no cuadra en el cierre.
 */
const dinero = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'debe ser un monto como 10000 o 10000.50')

const precios = {
  precioResidencial: dinero,
  precioComercial: dinero,
  precioMinimo: dinero,
}

export const esquemaAltaDeProducto = z.object({
  nombre: z.string().trim().min(1, 'el nombre es obligatorio'),
  presentacion: z.enum(['paca', 'botellon']),
  contenidoMl: z
    .number()
    .int('el contenido va en mililitros enteros')
    .positive('el contenido tiene que ser mayor que cero'),
  // El botellón lleva 1. Ver RN-CAT-10: que la paca tenga 20 unidades no
  // significa que se puedan vender por separado.
  unidades: z.number().int().min(1, 'un producto tiene al menos una unidad'),
  ...precios,
})

export const esquemaEdicionDeProducto = z.object({
  nombre: z.string().trim().min(1, 'el nombre es obligatorio'),
})

/**
 * Los tres precios van juntos y ninguno es opcional.
 *
 * Permitir cambiar uno solo obligaría a leer los otros dos de la base para
 * verificar el piso, y abriría una ventana entre esa lectura y el UPDATE. Con
 * los tres en el mismo request, lo que se valida es exactamente lo que se
 * guarda.
 */
export const esquemaDePrecios = z.object(precios)

/** Qué se lista. Por defecto, lo que una pantalla de venta necesita. */
export const esquemaDeFiltro = z.object({
  estado: z.enum(['activos', 'inactivos', 'todos']).default('activos'),
})

export type AltaDeProducto = z.infer<typeof esquemaAltaDeProducto>
export type EdicionDeProducto = z.infer<typeof esquemaEdicionDeProducto>
export type PreciosDeProducto = z.infer<typeof esquemaDePrecios>
