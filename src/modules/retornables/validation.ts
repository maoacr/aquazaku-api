import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas de retornables — M7.
 *
 * Validan **forma**. Que una base esté en un solo lugar, que el cliente tenga
 * que estar verificado o que un daño en bodega no le cobre a nadie lo decide el
 * servicio: una regla, un código de error, un lugar.
 */

const cantidad = z.number().int().positive('la cantidad de botellones es un entero positivo')

const motivo = z
  .string()
  .trim()
  .min(
    LARGO_MINIMO_MOTIVO,
    `necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: tiene que servir para entender el registro dentro de tres meses`,
  )

const dinero = z.string().regex(/^\d+(\.\d{1,2})?$/, 'debe ser un monto como 80000 o 80000.50')

export const esquemaDeCompra = z.object({ cantidad, motivo: z.string().trim().optional() })

export const esquemaDeTransferencia = z.object({
  clienteId: z.string().uuid(),
  cantidad,
  documentoId: z.string().uuid().optional(),
})

export const esquemaDeDescarteDeBotellones = z.object({ cantidad, motivo })

export const esquemaDeAjusteDeBotellones = z.object({
  clienteId: z.string().uuid().optional(),
  /** Con signo: positivo si sobran, negativo si faltan. Cero no ajusta nada. */
  diferencia: z.number().int(),
  motivo,
})

export const esquemaDeAltaDeBase = z.object({
  idSticker: z.string().trim().min(1, 'una base sin sticker no se puede reclamar'),
})

export const esquemaDePrestamo = z.object({ direccionId: z.string().uuid() })

export const esquemaDeDescarteDeBase = z.object({ motivo })

/**
 * El monto va explícito y es obligatorio.
 *
 * `RN-BAS-08` habla del «valor de reposición, configurable por SKU/tipo», pero
 * el dominio **no dice cuál es ese valor**. Poner un default acá sería
 * inventarlo. Cuando exista el módulo de configuración (M12), ese número pasa a
 * ser el default de este campo — no su reemplazo.
 */
export const esquemaDeDano = z.object({
  monto: dinero,
  motivo,
  medioDePago: z.enum(['efectivo', 'transferencia', 'credito']),
})
