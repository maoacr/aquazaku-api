import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas de ventas — M6.
 *
 * Validan **forma**, no reglas de negocio. Que el crédito exija verificación,
 * que un descuento no perfore el piso o que no se pueda cobrar de más lo decide
 * el servicio: una regla, un código de error, un lugar.
 */

/** Como `'10000'` o `'10000.50'`. La misma forma que usa el catálogo. */
const dinero = z.string().regex(/^\d+(\.\d{1,2})?$/, 'debe ser un monto como 10000 o 10000.50')

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como AAAA-MM-DD')

const motivo = z
  .string()
  .trim()
  .min(
    LARGO_MINIMO_MOTIVO,
    `necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: tiene que servir para entender el registro dentro de tres meses`,
  )

export const esquemaDeVenta = z.object({
  clienteId: z.string().uuid().optional(),
  medioDePago: z.enum(['efectivo', 'transferencia', 'credito']),
  canal: z.enum(['mostrador', 'whatsapp', 'ruta']).optional(),

  items: z
    .array(
      z.object({
        productoId: z.string().uuid(),
        cantidad: z.number().int().positive('una línea vende al menos una unidad'),
      }),
    )
    .min(1, 'una venta sin productos no es una venta'),

  codigoDescuento: z.string().trim().min(1).optional(),
  requiereFacturaElectronica: z.boolean().optional(),
})

/**
 * La anulación NO acepta un autor por parámetro.
 *
 * Quién anula sale de la sesión, y quién puede hacerlo lo decide el alcance de
 * la matriz sobre el autor original. Si el autor viniera en el cuerpo, cualquiera
 * podría afirmar ser quien registró la venta.
 */
export const esquemaDeAnulacion = z.object({ motivo })

export const esquemaDeCobro = z.object({
  clienteId: z.string().uuid(),
  monto: dinero,
  /** `credito` no está: pagar una deuda con deuda no la reduce. */
  medioDePago: z.enum(['efectivo', 'transferencia']),
  observaciones: z.string().trim().optional(),
})

export const esquemaDeDevolucion = z.object({
  lineaId: z.string().uuid(),
  cantidad: z.number().int().positive(),
  estadoProducto: z.enum(['sano', 'danado', 'vencido']),
  motivo,
})

export const esquemaDeCodigo = z
  .object({
    codigo: z.string().trim().min(1, 'el código necesita un nombre'),
    tipo: z.enum(['porcentaje', 'monto_fijo']),
    valor: dinero,
    vigenciaDesde: fecha,
    vigenciaHasta: fecha,
    /** `null` es ilimitado, y es el default. */
    usosMaximos: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => d.vigenciaHasta >= d.vigenciaDesde, {
    message: 'la fecha de fin es anterior a la de inicio',
    path: ['vigenciaHasta'],
  })
