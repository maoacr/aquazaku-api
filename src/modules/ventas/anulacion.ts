import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Venta, lineasDeVenta, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { applicableScopes } from '@/modules/authz/scoped-query'
import type { UserContext } from '@/modules/authz/can'
import { ingresar } from '@/modules/stock/saldo'

/**
 * Anular una venta — RN-VEN-03 y RN-VEN-08.
 *
 * ── Anular no es editar ─────────────────────────────────────────────────────
 *
 * La venta **no desaparece**: cambia de estado. Sus líneas quedan intactas como
 * testimonio de que se vendió eso, a ese precio, ese día. Lo que se revierte son
 * los efectos, y cada uno con su propio documento.
 *
 * Los tres efectos que se revierten:
 *
 * | Efecto | Cómo se revierte |
 * | --- | --- |
 * | El producto salió | Vuelve al MISMO lote, con un movimiento `devolucion` |
 * | La deuda subió | Sola: la deuda filtra por estado `confirmada` |
 * | El código sumó un uso | **No se revierte** — ver abajo |
 *
 * ── Por qué el uso del código NO se devuelve ────────────────────────────────
 *
 * Un código con tope de usos existe para acotar cuántas veces se otorga un
 * descuento. Devolver el uso al anular abre la puerta a agotar el tope sin
 * consumirlo: registrar y anular en ciclo. El contador cuenta **cuántas veces se
 * invocó**, que es lo que el tope quiere limitar.
 *
 * ── El saldo del cliente se revierte SOLO ───────────────────────────────────
 *
 * `deudaDe` suma las ventas a crédito **confirmadas**. Cambiar el estado a
 * `anulada` la saca de la cuenta sin tocar ninguna otra tabla — y sin poder
 * quedar desincronizada, porque no hay una segunda copia del número.
 *
 * Es la ventaja concreta de que el saldo sea derivado y no materializado.
 */

/**
 * Quién puede anular esta venta — RN-VEN-08.
 *
 * `pos` y `seller` tienen la acción con alcance **`propio`**; `admin` con
 * alcance `todo`. El chequeo va sobre el `user_id` del autor y **no sobre el
 * rol**: los roles se suman (RN-ACC-01), así que preguntar «¿es un pos?» no
 * contesta «¿es quien la hizo?».
 *
 * Se usa `applicableScopes` y no `scopedCondition` porque acá no se filtra una
 * lista: se decide sobre una fila que ya se tiene.
 */
export function puedeAnular(usuario: UserContext, venta: Venta): boolean {
  const alcances = applicableScopes(usuario, 'ventas', 'anular')

  if (alcances.includes('todo')) return true

  return alcances.includes('propio') && venta.registradoPor === usuario.id
}

export async function anularVenta(
  ventaId: string,
  motivo: string,
  usuario: UserContext,
): Promise<Venta> {
  return db.transaction(async (tx) => {
    const [venta] = await tx.select().from(ventas).where(eq(ventas.id, ventaId))

    if (!venta) throw new ErrorDeNegocio('VENTA_NO_ENCONTRADA', 404, 'esa venta no existe')

    if (venta.estado === 'anulada') {
      throw new ErrorDeNegocio(
        'YA_ANULADA',
        422,
        'esa venta ya está anulada. Volver a anularla reemplazaría quién lo hizo y por qué',
      )
    }

    if (!puedeAnular(usuario, venta)) {
      throw new ErrorDeNegocio(
        'NO_ES_SU_VENTA',
        403,
        'solo quien registró la venta puede anularla. Si hace falta anular la de otra persona, tiene que hacerlo un admin',
      )
    }

    /*
     * El comentario NO es opcional, y aplica igual al admin: quien tiene más
     * permisos también deja más rastro. Una anulación sin explicación es un
     * agujero en la caja que dentro de tres meses nadie puede cerrar.
     */
    if (!motivoEsSuficiente(motivo)) {
      throw new ErrorDeNegocio(
        'MOTIVO_REQUERIDO',
        422,
        `anular necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres de explicación: es lo que hace que la reversión se pueda entender después`,
      )
    }

    const lineas = await tx.select().from(lineasDeVenta).where(eq(lineasDeVenta.ventaId, ventaId))

    for (const linea of lineas) {
      /*
       * Vuelve al MISMO lote, no a stock genérico. El lote tiene su propia
       * fecha de vencimiento: devolver a otro convertiría producto que vencía el
       * martes en producto que vence el mes que viene, y el sistema dejaría de
       * poder avisar que hay que sacarlo.
       */
      await ingresar(
        {
          loteId: linea.loteId,
          cantidad: linea.cantidad,
          tipo: 'devolucion',
          documentoId: ventaId,
          registradoPor: usuario.id,
        },
        tx,
      )
    }

    await tx
      .update(ventas)
      .set({
        estado: 'anulada',
        anuladaPor: usuario.id,
        anuladaEn: new Date(),
        motivoAnulacion: motivo.trim(),
      })
      .where(eq(ventas.id, ventaId))

    const [anulada] = await tx.select().from(ventas).where(eq(ventas.id, ventaId))
    return anulada!
  })
}
