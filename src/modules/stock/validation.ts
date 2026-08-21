import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas del stock — M2.
 *
 * Validan **forma**, no reglas de negocio. El motivo obligatorio
 * ([RN-STK-02](/dominio/stock/)) y la causa obligatoria (RN-STK-06) los verifica
 * el servicio y los garantiza un `CHECK` en la base: si además los validara Zod,
 * el mismo problema devolvería `VALIDATION_ERROR` (400) o `MOTIVO_REQUERIDO`
 * (422) según quién lo atrapara primero.
 *
 * Una regla, un código de error, un lugar.
 */

/** `YYYY-MM-DD`. La base guarda `date`, no timestamp. */
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como AAAA-MM-DD')

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
  .min(LARGO_MINIMO_MOTIVO, `el motivo necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: tiene que servir para entender el registro dentro de tres meses`)

export const esquemaDeEntrada = z.object({
  productoId: z.uuid('el producto no es un identificador válido'),
  cantidad: entero.positive('la cantidad tiene que ser mayor que cero'),
  fechaEmpaque: fecha,
  motivo,
})

export const esquemaDeAjuste = z.object({
  loteId: z.uuid('el lote no es un identificador válido'),
  /**
   * Positiva suma, negativa resta. Se excluye el cero en el esquema porque un
   * ajuste de cero no es un dato mal formado con intención válida: es una
   * operación que no hace nada.
   */
  cantidad: entero.refine((n) => n !== 0, 'un ajuste de cero no corrige nada'),
  motivo,
})

/**
 * Con causa `otro`, las observaciones dejan de ser opcionales.
 *
 * Las otras tres causas ya dicen qué pasó. `otro` no dice nada: sin el texto,
 * el registro queda como "se descartaron 12 unidades por otro" — un número sin
 * significado, que es exactamente lo que RN-STK-06 quiere evitar.
 */
export const esquemaDeDescarte = z
  .object({
    loteId: z.uuid('el lote no es un identificador válido'),
    cantidad: entero.positive('la cantidad tiene que ser mayor que cero'),
    causa: z.enum(['falla_produccion', 'mal_manejo_cliente', 'vencido', 'otro']),
    observaciones: z.string().trim().optional(),
  })
  .refine((d) => d.causa !== 'otro' || (d.observaciones?.length ?? 0) >= LARGO_MINIMO_MOTIVO, {
    path: ['observaciones'],
    message: `con causa "otro" hay que explicar qué pasó, en al menos ${LARGO_MINIMO_MOTIVO} caracteres`,
  })

export const esquemaDeFiltroDeMovimientos = z.object({
  loteId: z.uuid().optional(),
  tipo: z.enum(['produccion', 'ajuste', 'descarte', 'venta', 'devolucion']).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  // Un límite sin techo deja que un cliente pida la tabla entera de una.
  limite: z.coerce.number().int().min(1).max(200).default(50),
})

export type EntradaDeInventario = z.infer<typeof esquemaDeEntrada>
export type AjusteDeLote = z.infer<typeof esquemaDeAjuste>
export type DescarteDeLote = z.infer<typeof esquemaDeDescarte>
