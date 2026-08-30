import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { clientes, cobros, compras, devoluciones, proveedores, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { aCentavos, aMonto } from '@/modules/ventas/precio'

/**
 * El extracto de movimientos de plata — M11, RN-CON-03 a 06.
 *
 * ── Por qué los cinco van juntos ────────────────────────────────────────────
 *
 * Quien concilia un mes necesita ver el movimiento completo. Cinco listas
 * separadas lo obligan a reconstruirlo a mano — que es exactamente lo que hace
 * hoy, y lo que este módulo viene a eliminar.
 *
 * ── La venta y el cobro son DOS movimientos ─────────────────────────────────
 *
 * Una venta a crédito registra el ingreso el día que se vendió. El cobro es
 * otro hecho, otro día, y puede ser parcial. Sumarlos como si fueran lo mismo
 * daría el doble.
 *
 * Separarlos es lo que permite la única pregunta que importa de la cartera:
 * cuánto se VENDIÓ contra cuánto se COBRÓ.
 *
 * ── Esto NO es contabilidad ─────────────────────────────────────────────────
 *
 * No hay partida doble, ni plan de cuentas, ni impuestos: `RN-CAT-09` dice que
 * hoy no se retiene IVA ni se declara nada. Es un extracto operativo — la
 * materia prima para que el contador trabaje en su propio software.
 */

export type TipoDeMovimiento = 'venta' | 'recargo' | 'cobro' | 'devolucion' | 'compra'

const TODOS: TipoDeMovimiento[] = ['venta', 'recargo', 'cobro', 'devolucion', 'compra']

export interface Movimiento {
  fecha: string
  tipo: TipoDeMovimiento
  /** El cliente o el proveedor. `null` en la venta de mostrador sin cliente. */
  contraparte: string | null
  monto: string
  /** `+1` entra plata, `−1` sale. */
  signo: 1 | -1
  medioDePago: 'efectivo' | 'transferencia' | 'credito' | null
  /** RN-CON-06: de cualquier fila se llega al documento. */
  documentoId: string
  detalle: string | null
}

export interface Totales {
  entradas: string
  salidas: string
  neto: string
  porMedioDePago: { efectivo: string; transferencia: string; credito: string }
  /** RN-CON-03: `false` si la descomposición no suma al total. */
  cuadra: boolean
}

export interface Extracto {
  desde: string
  hasta: string
  movimientos: Movimiento[]
  totales: Totales
}

export interface Filtros {
  /** `YYYY-MM-DD`. */
  desde: string
  /** `YYYY-MM-DD`, **inclusivo**. */
  hasta: string
  tipos?: TipoDeMovimiento[]
}

export async function extracto({ desde, hasta, tipos }: Filtros): Promise<Extracto> {
  if (desde > hasta) {
    /*
     * Un rango al revés devuelve vacío en SQL, y ese vacío se lee como «no hubo
     * movimientos» — que es una respuesta plausible y falsa. Peor que un error.
     */
    throw new ErrorDeNegocio(
      'RANGO_INVALIDO',
      422,
      `el rango va de ${desde} a ${hasta}, que es al revés. Un rango invertido no devuelve nada, y ese vacío se lee como «no hubo movimientos»`,
    )
  }

  const pedidos = new Set(tipos?.length ? tipos : TODOS)

  /*
   * ── El `hasta` es INCLUSIVO ───────────────────────────────────────────────
   *
   * Se compara contra el DÍA de la fecha, no contra el instante. Con un
   * `<= '2026-08-31'` sobre un timestamp, todo lo del 31 después de medianoche
   * queda afuera: un día entero de operación que nadie extraña hasta que
   * concilia contra el banco.
   */
  const enRango = (columna: Parameters<typeof gte>[0]) =>
    and(gte(sql`${columna}::date`, desde), lte(sql`${columna}::date`, hasta))

  const movimientos: Movimiento[] = []

  if (pedidos.has('venta') || pedidos.has('recargo')) {
    const filas = await db
      .select({
        id: ventas.id,
        fecha: ventas.createdAt,
        tipo: ventas.tipo,
        total: ventas.total,
        medioDePago: ventas.medioDePago,
        estado: ventas.estado,
        cliente: clientes.nombre,
      })
      .from(ventas)
      .leftJoin(clientes, eq(clientes.id, ventas.clienteId))
      .where(and(enRango(ventas.createdAt), eq(ventas.estado, 'confirmada')))

    for (const f of filas) {
      const tipo: TipoDeMovimiento = f.tipo === 'dano_base' ? 'recargo' : 'venta'
      if (!pedidos.has(tipo)) continue

      movimientos.push({
        fecha: iso(f.fecha),
        tipo,
        contraparte: f.cliente,
        monto: f.total,
        signo: 1,
        medioDePago: f.medioDePago,
        documentoId: f.id,
        detalle: tipo === 'recargo' ? 'Recargo por daño a una base' : null,
      })
    }
  }

  if (pedidos.has('cobro')) {
    const filas = await db
      .select({
        id: cobros.id,
        fecha: cobros.createdAt,
        monto: cobros.monto,
        medioDePago: cobros.medioDePago,
        observaciones: cobros.observaciones,
        cliente: clientes.nombre,
      })
      .from(cobros)
      .leftJoin(clientes, eq(clientes.id, cobros.clienteId))
      .where(enRango(cobros.createdAt))

    for (const f of filas) {
      movimientos.push({
        fecha: iso(f.fecha),
        tipo: 'cobro',
        contraparte: f.cliente,
        monto: f.monto,
        signo: 1,
        medioDePago: f.medioDePago,
        documentoId: f.id,
        detalle: f.observaciones,
      })
    }
  }

  if (pedidos.has('devolucion')) {
    const filas = await db
      .select({
        id: devoluciones.id,
        fecha: devoluciones.createdAt,
        monto: devoluciones.montoAcreditado,
        motivo: devoluciones.motivo,
        cliente: clientes.nombre,
      })
      .from(devoluciones)
      .innerJoin(ventas, eq(ventas.id, devoluciones.ventaOrigenId))
      .leftJoin(clientes, eq(clientes.id, ventas.clienteId))
      .where(enRango(devoluciones.createdAt))

    for (const f of filas) {
      movimientos.push({
        fecha: iso(f.fecha),
        tipo: 'devolucion',
        contraparte: f.cliente,
        monto: f.monto ?? '0.00',
        signo: -1,
        /*
         * Sin medio de pago: una devolución acredita contra la deuda, no mueve
         * caja. Ponerle uno inventado descuadraría la descomposición.
         */
        medioDePago: null,
        documentoId: f.id,
        detalle: f.motivo,
      })
    }
  }

  if (pedidos.has('compra')) {
    const filas = await db
      .select({
        id: compras.id,
        fecha: compras.createdAt,
        total: compras.total,
        medioDePago: compras.medioDePago,
        proveedor: proveedores.nombre,
      })
      .from(compras)
      .innerJoin(proveedores, eq(proveedores.id, compras.proveedorId))
      .where(and(enRango(compras.createdAt), eq(compras.estado, 'recibida')))

    for (const f of filas) {
      movimientos.push({
        fecha: iso(f.fecha),
        tipo: 'compra',
        contraparte: f.proveedor,
        monto: f.total,
        signo: -1,
        medioDePago: f.medioDePago,
        documentoId: f.id,
        detalle: null,
      })
    }
  }

  // Por fecha: es el orden en que se concilia contra un extracto bancario.
  movimientos.sort((a, b) => a.fecha.localeCompare(b.fecha))

  return { desde, hasta, movimientos, totales: sumar(movimientos) }
}

/**
 * ── El total cuadra, o dice que no — RN-CON-03 ──────────────────────────────
 *
 * Los totales se calculan sobre lo FILTRADO, no sobre el período entero. Un
 * total que no corresponde a las filas visibles es peor que no mostrarlo: nadie
 * lo verifica sumando a mano.
 *
 * Todo en centavos enteros. Sumar `Number('12000.50')` acumula error de coma
 * flotante y aparece un descuadre de un centavo que nadie puede explicar.
 */
function sumar(movimientos: Movimiento[]): Totales {
  let entradas = 0
  let salidas = 0
  const porMedio = { efectivo: 0, transferencia: 0, credito: 0 }

  for (const m of movimientos) {
    const centavos = aCentavos(m.monto)

    if (m.signo === 1) {
      entradas += centavos
      if (m.medioDePago) porMedio[m.medioDePago] += centavos
    } else {
      salidas += centavos
    }
  }

  /*
   * La descomposición solo cubre las ENTRADAS con medio de pago. Una devolución
   * no lo tiene —acredita contra la deuda, no mueve caja— y por eso no entra en
   * la verificación: exigirle uno sería inventarlo.
   */
  const desglosado = porMedio.efectivo + porMedio.transferencia + porMedio.credito

  return {
    entradas: aMonto(entradas),
    salidas: aMonto(salidas),
    neto: aMonto(entradas - salidas),
    porMedioDePago: {
      efectivo: aMonto(porMedio.efectivo),
      transferencia: aMonto(porMedio.transferencia),
      credito: aMonto(porMedio.credito),
    },
    cuadra: desglosado === entradas,
  }
}

/** `YYYY-MM-DD` en hora local, que es como el contador piensa las fechas. */
function iso(fecha: Date): string {
  return new Date(fecha.getTime() - fecha.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}
