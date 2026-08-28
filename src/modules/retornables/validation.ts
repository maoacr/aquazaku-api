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

/**
 * El sticker es **opcional**, y esa opcionalidad es la regla — RN-BAS-10.
 *
 * Si no viene, el sistema propone el próximo consecutivo. Si viene, es porque el
 * operario tiene la base en la mano con el sticker ya pegado —las 40 que
 * Aquazaku ya tiene llegan así— y entonces manda el mundo físico.
 *
 * El formato sí es estricto en los dos caminos: cuatro dígitos. Aceptar `1`
 * junto a `0001` crearía dos códigos para la misma base y la unicidad dejaría
 * de proteger nada.
 */
export const esquemaDeAltaDeBase = z.object({
  idSticker: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'el sticker son cuatro dígitos, con los ceros adelante: 0001, 0040, 0231')
    .optional(),
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

/**
 * Comprar bases — RN-BAS-10.
 *
 * No lleva sticker: una base comprada llega sin rotular y el sistema la numera.
 * El camino de «el rótulo ya viene pegado» es `esquemaDeAltaDeBase`.
 *
 * Tampoco lleva motivo, a diferencia de la compra de botellones. La asimetría
 * es del dominio: una base queda con su fila propia y su historial, así que la
 * compra se puede reconstruir mirando el parque. Un botellón no deja rastro
 * individual, y ahí el texto es lo único que explica de dónde salieron.
 */
export const esquemaDeCompraDeBases = z.object({
  cantidad: z.number().int().positive('una compra de bases es de al menos una base'),
})
