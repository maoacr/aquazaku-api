import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas de producción — M4.
 *
 * Validan **forma**, no reglas de negocio. Que un cierre sin caudal no calcule
 * el procesamiento, o que un lavado sin medición se rechace, lo decide el
 * servicio: una regla, un código de error, un lugar.
 */

/** `YYYY-MM-DD`. La base guarda `date`, no timestamp. */
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como AAAA-MM-DD')

const conteo = z
  .number()
  .int('los conteos son enteros de unidades')
  .min(0, 'un conteo no puede ser negativo')

const motivo = z
  .string()
  .trim()
  .min(
    LARGO_MINIMO_MOTIVO,
    `el motivo necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: tiene que servir para entender el registro dentro de tres meses`,
  )

export const esquemaDeCierre = z.object({
  fecha,
  minutosProcesando: z
    .number()
    .int()
    .positive('un cierre sin tiempo de procesamiento no es un cierre'),

  pacas600: conteo.default(0),
  pacas300: conteo.default(0),
  botellonesLlenados: conteo.default(0),
  botellonesLavados: conteo.default(0),

  /**
   * Los dos datos que el sistema NO inventa.
   *
   * Opcionales en la FORMA porque un cierre sin caudal es válido —el envasado
   * se sabe aunque el procesamiento no—. Que falte el de lavado habiendo
   * lavados lo rechaza el servicio, con un mensaje que dice qué medir.
   */
  caudalGpm: z.number().positive('el caudal tiene que ser mayor que cero').optional(),
  litrosPorLavado: z.number().positive('un lavado consume más que cero litros').optional(),

  nivelObservado: z
    .enum(['vacio', 'un_cuarto', 'medio', 'tres_cuartos', 'lleno'])
    .optional(),
})

const tanque = z.enum(['crudo', 'procesado'])

/**
 * La reposición NO lleva cantidad, y eso es la regla hecha esquema.
 *
 * No hay medidor ni regleta (RN-PRD-11). Si este objeto aceptara `litros`,
 * alguien lo mandaría a ojo y el sistema convertiría un hueco conocido en un
 * número que parece medido.
 */
export const esquemaDeReposicion = z.object({ tanque })

export const esquemaDeAjusteDeAgua = z.object({
  tanque,
  /** Con signo: positivo si sobra, negativo si falta. Cero no ajusta nada. */
  litros: z.number().int('los litros van en enteros'),
  motivo,
})

export const esquemaDeReconciliacion = z.object({
  tanque,
  nivel: z.enum(['vacio', 'un_cuarto', 'medio', 'tres_cuartos', 'lleno']),
})
