import { ErrorDeNegocio } from '@/lib/errors'
import { aCentavos, aMonto } from '@/modules/ventas/precio'
import { type Movimiento, type TipoDeMovimiento, type Totales, extracto, sumar } from './extracto'

/**
 * El resumen mensual — M11, RN-CON-07.
 *
 * ── Por qué no alcanza con el extracto ──────────────────────────────────────
 *
 * El extracto responde «qué pasó en agosto». Este responde «cómo viene el año»,
 * y son preguntas distintas: la segunda se contesta comparando meses, no leyendo
 * movimientos. Hoy hay que pedir doce extractos y sumarlos a mano.
 *
 * ── Sale del MISMO cálculo que el extracto ──────────────────────────────────
 *
 * Se pide el rango completo una vez y se agrupa por mes, reusando `sumar`. La
 * alternativa —SQL propio que agregue por mes— sería más rápida y **peligrosa**:
 * el día que cambie qué cuenta como plata (un tipo nuevo, una devolución que
 * deje de restar), una de las dos consultas se actualizaría y la otra no.
 *
 * Dos reportes del mismo negocio que no coinciden es peor que no tener el
 * segundo: obliga a desconfiar de los dos, y nadie sabe cuál desconfiar más.
 *
 * El volumen lo permite — una planta de este tamaño mueve cientos de
 * movimientos al mes, no millones.
 */

const MES = /^\d{4}-(0[1-9]|1[0-2])$/

export interface Mes {
  /** `YYYY-MM`. */
  mes: string
  totales: Totales
  /** Cuánto movió cada tipo en el mes, en valor absoluto. */
  porTipo: Record<TipoDeMovimiento, string>
}

export interface RangoDeMeses {
  /** `YYYY-MM`. */
  desde: string
  /** `YYYY-MM`, **inclusivo**. */
  hasta: string
}

/**
 * ── Entra en meses y sale en meses, a propósito ─────────────────────────────
 *
 * Si esto aceptara fechas sueltas, un rango del 15 de enero al 20 de marzo
 * devolvería tres filas mensuales de las cuales dos son pedazos de mes — con
 * pinta de meses completos. Nadie compara «enero» contra «medio enero» a
 * sabiendas; se compara sin mirar, y ahí nace la conclusión falsa.
 *
 * La granularidad de la respuesta se defiende en la de la pregunta.
 */
export async function resumenMensual({ desde, hasta }: RangoDeMeses): Promise<Mes[]> {
  if (!MES.test(desde) || !MES.test(hasta)) {
    throw new ErrorDeNegocio('MES_INVALIDO', 422, 'los meses van como 2026-08')
  }

  if (desde > hasta) {
    throw new ErrorDeNegocio(
      'RANGO_INVALIDO',
      422,
      `el rango va de ${desde} a ${hasta}, que es al revés`,
    )
  }

  const { movimientos } = await extracto({
    desde: `${desde}-01`,
    hasta: ultimoDia(hasta),
  })

  const porMes = new Map<string, Movimiento[]>()
  for (const m of movimientos) {
    const mes = m.fecha.slice(0, 7)
    porMes.set(mes, [...(porMes.get(mes) ?? []), m])
  }

  /*
   * ── Un mes sin movimiento aparece igual, en cero ──────────────────────────
   *
   * Un mes ausente se lee como «no lo consulté». Uno en cero dice «no pasó
   * nada», que es un dato — y en una planta que factura todos los días, un cero
   * es una alarma, no un hueco en el reporte.
   */
  return mesesEntre(desde, hasta).map((mes) => {
    const delMes = porMes.get(mes) ?? []

    const porTipo: Record<string, number> = {}
    for (const m of delMes) {
      porTipo[m.tipo] = (porTipo[m.tipo] ?? 0) + aCentavos(m.monto)
    }

    return {
      mes,
      totales: sumar(delMes),
      porTipo: Object.fromEntries(
        (['venta', 'recargo', 'cobro', 'devolucion', 'compra'] as TipoDeMovimiento[]).map((t) => [
          t,
          aMonto(porTipo[t] ?? 0),
        ]),
      ) as Record<TipoDeMovimiento, string>,
    }
  })
}

/** El último día del mes — `2026-02` da `2026-02-28`, y en bisiesto da 29. */
function ultimoDia(mes: string): string {
  const [anio, m] = mes.split('-').map(Number)
  const dia = new Date(Date.UTC(anio!, m!, 0)).getUTCDate()
  return `${mes}-${String(dia).padStart(2, '0')}`
}

function mesesEntre(desde: string, hasta: string): string[] {
  const meses: string[] = []
  let [anio, m] = desde.split('-').map(Number) as [number, number]

  while (`${anio}-${String(m).padStart(2, '0')}` <= hasta) {
    meses.push(`${anio}-${String(m).padStart(2, '0')}`)
    if (m === 12) {
      anio += 1
      m = 1
    } else {
      m += 1
    }
  }

  return meses
}
