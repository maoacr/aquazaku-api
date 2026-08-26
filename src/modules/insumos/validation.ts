import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas de insumos — M3.
 *
 * Validan **forma**, no reglas de negocio. Que un ajuste necesite motivo o que
 * un insumo sin equivalencia no acepte kilos los verifica el servicio, y los
 * garantiza un `CHECK` en la base. Si además los validara Zod, el mismo
 * problema devolvería un código u otro según quién lo atrapara primero.
 *
 * Una regla, un código de error, un lugar.
 */

const entero = z.number().int('tiene que ser un número entero de unidades')

/**
 * Un motivo que sirva para entender el registro dentro de tres meses.
 *
 * Diez caracteres es la convención del proyecto para toda acción irreversible.
 * No garantiza una buena explicación, pero descarta el `x` reflejo.
 */
const motivo = z
  .string()
  .trim()
  .min(
    LARGO_MINIMO_MOTIVO,
    `el motivo necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: tiene que servir para entender el registro dentro de tres meses`,
  )

/** `TAPA_20L`, `BOLSA_600`. Mayúsculas, números y guión bajo. */
const codigo = z
  .string()
  .trim()
  .min(3, 'el código necesita al menos 3 caracteres')
  .max(32, 'el código no puede pasar de 32 caracteres')
  .regex(/^[A-Z0-9_]+$/, 'el código va en MAYÚSCULAS, con números y guión bajo')

/**
 * Los pesos van como número, no como string.
 *
 * La balanza da decimales —12,4 kg— y el redondeo a entero perdería casi media
 * paca de bolsas por compra. La base los guarda en `numeric` para que no haya
 * error binario acumulado.
 */
const peso = z
  .number()
  .positive('el peso tiene que ser mayor que cero')
  .max(100000, 'ese peso no parece una compra real')

export const esquemaDeAlta = z.object({
  codigo,
  nombre: z.string().trim().min(3, 'el nombre necesita al menos 3 caracteres'),
  minimo: entero.positive('el mínimo tiene que ser mayor que cero'),
  /**
   * Opcional a propósito. Cuántas unidades trae un kilo es una MEDICIÓN de
   * planta, y obligarla al dar de alta forzaría a inventar un número — que es
   * exactamente lo que descuadra el inventario en silencio (pregunta 37).
   */
  equivalenciaPorKilo: peso.optional(),
})

export const esquemaDeEdicion = z.object({
  nombre: z.string().trim().min(3, 'el nombre necesita al menos 3 caracteres').optional(),
  minimo: entero.positive('el mínimo tiene que ser mayor que cero').optional(),
  equivalenciaPorKilo: peso.optional(),
  activo: z.boolean().optional(),
})

/**
 * La entrada acepta unidades **o** kilos, nunca las dos ni ninguna.
 *
 * Con las dos, el sistema tendría que elegir cuál manda y esa decisión no la
 * puede tomar: si no coinciden, una de las dos es un error de carga y no hay
 * forma de saber cuál.
 */
export const esquemaDeEntrada = z
  .object({
    cantidad: entero.positive('la cantidad tiene que ser mayor que cero').optional(),
    kilos: peso.optional(),
    documentoId: z.uuid().optional(),
  })
  .refine((d) => (d.cantidad === undefined) !== (d.kilos === undefined), {
    message: 'la entrada va en unidades o en kilos, una de las dos',
    path: ['cantidad'],
  })

export const esquemaDeAjuste = z.object({
  /**
   * Con signo: positivo si sobran unidades, negativo si faltan. Cero no es un
   * ajuste — es no haber encontrado diferencia, y eso no se registra.
   */
  diferencia: entero.refine((n) => n !== 0, 'un ajuste de cero no ajusta nada'),
  motivo,
})

export const esquemaDeDescarte = z.object({
  cantidad: entero.positive('la cantidad tiene que ser mayor que cero'),
  causa: z.enum(['falla_produccion', 'mal_manejo_cliente', 'vencido', 'otro']),
  observaciones: z.string().trim().optional(),
})
