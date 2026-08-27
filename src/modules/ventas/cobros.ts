import { desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Cliente, type Cobro, clientes, cobros } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { aCentavos, aMonto } from './precio'
import { deudaDe } from './saldo'

/**
 * Los cobros — RN-VEN-07.
 *
 * ── Por qué el cobro cuelga del CLIENTE y no de la venta ────────────────────
 *
 * Modelarlo como un campo de la venta haría imposibles las dos cosas que más
 * pasan: un pago parcial, y un pago que cubre tres ventas. La deuda es del
 * cliente, no de cada comprobante.
 *
 * ── El cobro tampoco se edita ───────────────────────────────────────────────
 *
 * `UPDATE` y `DELETE` están revocados. Un cobro mal registrado se corrige con
 * otro documento, igual que todo lo demás acá: si el monto de ayer puede cambiar
 * hoy, la cobranza deja de ser auditable.
 */

export interface DatosDeCobro {
  clienteId: string
  /** Como `'50000.00'`. Se valida contra la deuda real. */
  monto: string
  medioDePago: 'efectivo' | 'transferencia'
  observaciones?: string | undefined
}

export interface ResultadoDeCobro {
  cobro: Cobro
  /** La deuda que queda después de este cobro. */
  deudaRestante: string
  /** `true` cuando el cobro saldó todo. Para poder decirlo sin recalcular. */
  quedaSaldada: boolean
}

export async function registrarCobro(
  datos: DatosDeCobro,
  registradoPor: string | null,
): Promise<ResultadoDeCobro> {
  return db.transaction(async (tx) => {
    const [cliente] = await tx.select().from(clientes).where(eq(clientes.id, datos.clienteId))

    if (!cliente) throw new ErrorDeNegocio('CLIENTE_NO_ENCONTRADO', 404, 'ese cliente no existe')

    const monto = aCentavos(datos.monto)
    if (monto <= 0) {
      throw new ErrorDeNegocio('MONTO_INVALIDO', 422, 'un cobro de cero o menos no es un cobro')
    }

    /*
     * ── Cobrar de más se RECHAZA, y es una decisión, no un olvido ────────────
     *
     * El dominio no dice qué pasa si alguien paga más de lo que debe. Aceptarlo
     * dejaría una deuda negativa —un saldo a favor— y **ningún módulo del
     * sistema sabe gastarlo**: no hay forma de aplicarlo a una venta futura ni
     * de devolverlo. Sería un número que aparece en la ficha del cliente y en el
     * panel del contador sin que nadie pueda hacer nada con él.
     *
     * Rechazar con la deuda REAL es reversible: si Aquazaku dice que los
     * adelantos existen, se abre. Aceptarlo en silencio no lo es — para cuando
     * se note, ya hay saldos negativos en la base.
     *
     * Queda anotado como pregunta en /empezar/pendientes/.
     */
    const deudaActual = await deudaDe(datos.clienteId, tx)

    if (monto > aCentavos(deudaActual)) {
      throw new ErrorDeNegocio(
        'COBRO_MAYOR_QUE_LA_DEUDA',
        422,
        `${cliente.nombre} debe $${Number(deudaActual).toLocaleString('es-CO')} y este cobro es de $${Number(datos.monto).toLocaleString('es-CO')}. Registre el monto que debe, o revise si falta cargar una venta`,
      )
    }

    const [cobro] = await tx
      .insert(cobros)
      .values({
        clienteId: datos.clienteId,
        monto: aMonto(monto),
        medioDePago: datos.medioDePago,
        observaciones: datos.observaciones?.trim() || null,
        registradoPor,
      })
      .returning()

    const restante = aMonto(aCentavos(deudaActual) - monto)

    return {
      cobro: cobro!,
      deudaRestante: restante,
      quedaSaldada: aCentavos(restante) === 0,
    }
  })
}

/** El libro de cobros de un cliente, del más nuevo al más viejo. */
export async function cobrosDe(clienteId: string): Promise<Cobro[]> {
  return db.select().from(cobros).where(eq(cobros.clienteId, clienteId)).orderBy(desc(cobros.createdAt))
}

/** La cartera: quién debe y cuánto. Lo que el `contador` mira primero. */
export async function cartera(): Promise<{ cliente: Cliente; deuda: string }[]> {
  const activos = await db.select().from(clientes).where(eq(clientes.activo, true))

  const conDeuda = await Promise.all(
    activos.map(async (cliente) => ({ cliente, deuda: await deudaDe(cliente.id) })),
  )

  return conDeuda
    .filter((fila) => aCentavos(fila.deuda) > 0)
    .sort((a, b) => aCentavos(b.deuda) - aCentavos(a.deuda))
}
