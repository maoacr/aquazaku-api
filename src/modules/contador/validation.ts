import { z } from 'zod'

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como 2026-08-31')

/**
 * El extracto — M11.
 *
 * Valida **forma**. Que el rango no venga al revés lo decide el servicio: es
 * una regla de negocio con su propio mensaje, y también se lo llama desde
 * adentro.
 *
 * `tipos` llega separado por coma porque es una query string. Se valida acá que
 * sean los cinco conocidos: un tipo inventado no rompería nada —el filtro
 * simplemente no lo encontraría— pero devolvería un extracto vacío que se lee
 * como «no hubo movimientos».
 */
export const esquemaDeExtracto = z.object({
  desde: fecha,
  hasta: fecha,
  tipos: z
    .string()
    .regex(
      /^(venta|recargo|cobro|devolucion|compra)(,(venta|recargo|cobro|devolucion|compra))*$/,
      'los tipos son venta, recargo, cobro, devolucion y compra, separados por coma',
    )
    .optional(),
})
