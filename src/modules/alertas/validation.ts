import { z } from 'zod'

/**
 * Cambiar un umbral — M12.
 *
 * Valida FORMA: que sea un entero. **El rango lo decide el servicio**, porque
 * cada parámetro tiene el suyo y vive en la base junto al valor (ADR-0006). Un
 * rango escrito acá sería una tercera copia de algo que ya está en dos lugares
 * que sí se sostienen entre sí: el CHECK y la fila.
 */
export const esquemaDeParametro = z.object({
  valor: z.coerce.number().int('el umbral va en días enteros'),
})
