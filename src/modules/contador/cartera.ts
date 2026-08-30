import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { clientes, cobros, devoluciones, ventas } from '@/db/schema'
import { aCentavos, aMonto } from '@/modules/ventas/precio'

/**
 * Cartera por edad — M11, RN-CON-05.
 *
 * ── Por qué hace falta una convención ───────────────────────────────────────
 *
 * Un cobro va contra el SALDO del cliente, no contra una venta concreta: no
 * existe columna que los una, y eso es correcto — así funciona el mostrador,
 * donde alguien abona lo que puede sin decir a cuál compra.
 *
 * Pero envejecer una deuda obliga a decidir a qué venta se imputa cada pago. La
 * convención es **la más vieja primero**, que es la práctica habitual.
 *
 * Sigue siendo una convención, no un hecho del dominio. Por eso RN-CON-05 está
 * marcada como SUPUESTO hasta que el contador confirme —tanto la imputación
 * como los tramos—, y por eso los tramos viven acá en una constante exportada
 * en vez de estar repartidos por el código.
 *
 * ── Qué NO entra ────────────────────────────────────────────────────────────
 *
 * Los recargos por daño (`tipo = 'dano_base'`). RN-CLI-06 los separa de la
 * deuda: nacen de cosas distintas y se reclaman distinto. Mezclarlos daría un
 * número que no sirve para ninguna de las dos conversaciones.
 */

export interface Tramo {
  etiqueta: string
  /** Días de antigüedad, inclusive. `null` en el último: no tiene techo. */
  hasta: number | null
}

/**
 * Los tramos habituales. **Supuesto pendiente de confirmación** — pregunta 44.
 *
 * Viven en una sola constante para que cambiarlos no sea una cacería: el día
 * que el contador diga otros, se toca acá y la pantalla los sigue.
 */
export const TRAMOS: Tramo[] = [
  { etiqueta: '0-30', hasta: 30 },
  { etiqueta: '31-60', hasta: 60 },
  { etiqueta: '61-90', hasta: 90 },
  { etiqueta: '90+', hasta: null },
]

export interface CarteraDeCliente {
  clienteId: string
  cliente: string
  documento: string
  total: string
  tramos: Record<string, string>
}

export async function carteraPorEdad(hoy: string): Promise<CarteraDeCliente[]> {
  /*
   * Las ventas a crédito CONFIRMADAS de producto, más viejas primero — que es
   * el orden en el que se van a imputar los pagos.
   */
  const aCredito = await db
    .select({
      clienteId: ventas.clienteId,
      cliente: clientes.nombre,
      documento: clientes.numeroDocumento,
      ventaId: ventas.id,
      total: ventas.total,
      dias: sql<string>`${hoy}::date - ${ventas.createdAt}::date`,
    })
    .from(ventas)
    .innerJoin(clientes, eq(clientes.id, ventas.clienteId))
    .where(
      and(
        eq(ventas.medioDePago, 'credito'),
        eq(ventas.estado, 'confirmada'),
        eq(ventas.tipo, 'producto'),
      ),
    )
    .orderBy(asc(ventas.createdAt))

  if (aCredito.length === 0) return []

  /*
   * Lo abonado por cliente: cobros más devoluciones acreditadas. Las dos
   * reducen deuda, y por eso se suman para imputar — es la misma cuenta que
   * hace `deudaDe`, solo que acá hay que repartirla venta por venta.
   */
  const abonado = new Map<string, number>()

  for (const c of await db
    .select({ clienteId: cobros.clienteId, monto: cobros.monto })
    .from(cobros)) {
    abonado.set(c.clienteId, (abonado.get(c.clienteId) ?? 0) + aCentavos(c.monto))
  }

  for (const d of await db
    .select({ clienteId: ventas.clienteId, monto: devoluciones.montoAcreditado })
    .from(devoluciones)
    .innerJoin(ventas, eq(ventas.id, devoluciones.ventaOrigenId))) {
    if (!d.clienteId || !d.monto) continue
    abonado.set(d.clienteId, (abonado.get(d.clienteId) ?? 0) + aCentavos(d.monto))
  }

  const porCliente = new Map<string, { cliente: string; documento: string; tramos: number[] }>()

  for (const venta of aCredito) {
    const id = venta.clienteId!

    if (!porCliente.has(id)) {
      porCliente.set(id, {
        cliente: venta.cliente,
        documento: venta.documento,
        tramos: TRAMOS.map(() => 0),
      })
    }

    /*
     * ── La imputación: lo más viejo primero ─────────────────────────────────
     *
     * Como las ventas vienen ordenadas por fecha, alcanza con ir descontando
     * el saldo abonado del cliente contra cada una hasta agotarlo.
     */
    const disponible = abonado.get(id) ?? 0
    const total = aCentavos(venta.total)
    const cubierto = Math.min(disponible, total)
    abonado.set(id, disponible - cubierto)

    const pendiente = total - cubierto
    if (pendiente === 0) continue

    const dias = Number(venta.dias)
    const i = TRAMOS.findIndex((t) => t.hasta === null || dias <= t.hasta)
    const acumulado = porCliente.get(id)!.tramos
    acumulado[i] = (acumulado[i] ?? 0) + pendiente
  }

  const cartera: CarteraDeCliente[] = []

  for (const [clienteId, datos] of porCliente) {
    const total = datos.tramos.reduce((a, b) => a + b, 0)

    // Sin nada pendiente, el cliente no va en la cartera: no hay qué reclamar.
    if (total === 0) continue

    cartera.push({
      clienteId,
      cliente: datos.cliente,
      documento: datos.documento,
      total: aMonto(total),
      tramos: Object.fromEntries(
        TRAMOS.map((t, i) => [t.etiqueta, aMonto(datos.tramos[i] ?? 0)]),
      ),
    })
  }

  /*
   * El que más debe primero: la cartera existe para saber a quién llamar, y esa
   * pregunta se responde por monto, no por orden alfabético.
   */
  return cartera.sort((a, b) => aCentavos(b.total) - aCentavos(a.total))
}
