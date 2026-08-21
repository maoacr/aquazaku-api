/**
 * Código y vencimiento de un lote — RN-STK-08.
 *
 * `YYYY-MM-DD-L1`: fecha de empaque más una secuencia dentro del día. Lo genera
 * el sistema y el `pos` lo imprime en la bolsa física, así que tiene que poder
 * leerse y dictarse por teléfono.
 */

/**
 * Días hasta el vencimiento, desde el empaque — RN-STK-08.
 *
 * Vive acá, en el código, y NO como columna generada en la base. Es
 * deliberado: el vencimiento de un lote es un hecho del momento en que se
 * empacó, no una definición que deba recalcularse. Si esta constante cambia a
 * 45, solo afecta a los lotes nuevos — los viejos conservan la fecha con la que
 * se vendieron.
 */
export const DIAS_DE_VENCIMIENTO = 30

const MS_POR_DIA = 24 * 60 * 60 * 1000

/**
 * Suma los días de vida útil a la fecha de empaque.
 *
 * Se opera en UTC a propósito. Con `new Date('2026-08-22')` interpretado en
 * hora local, un huso al oeste de Greenwich devuelve el día anterior, y el lote
 * vencería un día antes de lo que corresponde.
 */
export function vencimientoDe(fechaEmpaque: string, dias = DIAS_DE_VENCIMIENTO): string {
  const empaque = new Date(`${fechaEmpaque}T00:00:00Z`)

  if (Number.isNaN(empaque.getTime())) {
    throw new Error(`fecha de empaque inválida: ${fechaEmpaque}`)
  }

  return new Date(empaque.getTime() + dias * MS_POR_DIA).toISOString().slice(0, 10)
}

/**
 * Siguiente código libre para un día.
 *
 * `tomados` tiene que incluir **todos** los lotes de esa fecha, incluidos los
 * agotados: un código de lote viaja en las ventas y en los movimientos, así que
 * reciclarlo haría que un comprobante viejo apunte a producto que no es el suyo.
 */
export function codigoDeLote(fechaEmpaque: string, tomados: Iterable<string>): string {
  const ocupados = new Set(tomados)

  let secuencia = 1
  while (ocupados.has(`${fechaEmpaque}-L${secuencia}`)) secuencia++

  return `${fechaEmpaque}-L${secuencia}`
}
