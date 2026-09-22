import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  type Venta,
  bases,
  lineasDeVenta,
  movimientosBase,
  movimientosBotellon,
  ventas,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { applicableScopes } from '@/modules/authz/scoped-query'
import type { UserContext } from '@/modules/authz/can'
import { type Transaccion, ingresar } from '@/modules/stock/saldo'

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

/**
 * La venta sobre la que se va a operar, o el error que explica por qué no.
 *
 * Es el preámbulo que comparten anular y corregir (RN-VEN-16), y está acá y no
 * duplicado en cada uno porque las tres preguntas son las MISMAS: ¿existe?,
 * ¿sigue confirmada?, ¿es de quien la quiere tocar? Una copia que se desactualice
 * dejaría un camino por el que se puede anular algo que el otro rechaza.
 *
 * El `FOR UPDATE` bloquea la fila hasta el fin de la transacción. Sin él, dos
 * anulaciones simultáneas de la misma venta pasan las tres validaciones y
 * devuelven el stock DOS VECES: el `UPDATE` de la segunda falla por el trigger,
 * pero los `ingresar` de las dos ya están escritos.
 */
export async function ventaAnulable(
  tx: Transaccion,
  ventaId: string,
  usuario: UserContext,
): Promise<Venta> {
  const [venta] = await tx.select().from(ventas).where(eq(ventas.id, ventaId)).for('update')

  if (!venta) throw new ErrorDeNegocio('VENTA_NO_ENCONTRADA', 404, 'esa venta no existe')

  /*
   * Cualquier estado que no sea `confirmada` cierra la puerta, y no solo
   * `anulada`. Una venta ya corregida tiene una sucesora viva: anularla acá
   * dejaría la deuda cobrada por la nueva y el stock devuelto por las dos.
   */
  if (venta.estado !== 'confirmada') {
    throw new ErrorDeNegocio(
      'YA_ANULADA',
      422,
      venta.estado === 'corregida'
        ? 'esa venta ya fue corregida: lo que está vigente es la venta que la reemplazó. Anule esa'
        : 'esa venta ya está anulada. Volver a anularla reemplazaría quién lo hizo y por qué',
    )
  }

  if (!puedeAnular(usuario, venta)) {
    throw new ErrorDeNegocio(
      'NO_ES_SU_VENTA',
      403,
      'solo quien registró la venta puede anularla. Si hace falta anular la de otra persona, tiene que hacerlo un admin',
    )
  }

  return venta
}

/**
 * El motivo, o el error que dice por qué no alcanza.
 *
 * El comentario NO es opcional, y aplica igual al admin: quien tiene más
 * permisos también deja más rastro. Una anulación sin explicación es un agujero
 * en la caja que dentro de tres meses nadie puede cerrar.
 */
export function exigirMotivo(motivo: string, verbo: 'anular' | 'corregir'): string {
  if (!motivoEsSuficiente(motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `${verbo} necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres de explicación: es lo que hace que la reversión se pueda entender después`,
    )
  }

  return motivo.trim()
}

/**
 * Devuelve al stock todo lo que salió con esta venta.
 *
 * Es el efecto físico de la reversión, separado del `UPDATE` que cambia el
 * estado, y esa separación es lo que hace posible la corrección: ahí el estado
 * se escribe UNA sola vez —con la sucesora ya conocida— porque el trigger no
 * deja tocar dos veces la misma fila.
 */
export async function devolverElProductoALosLotes(
  tx: Transaccion,
  ventaId: string,
  registradoPor: string | null,
): Promise<void> {
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
        registradoPor,
      },
      tx,
    )
  }
}

/**
 * Lo que la anulación revirtió — la bitácora lo necesita para reconstruir la
 * operación sin cruzar filas de `movimientos_botellon` / `movimientos_base`.
 *
 * `baseReversada` es el `baseId` si la venta prestó una base, `null` en caso
 * contrario. Se identifica vía `movimientos_base` post-commit (la tabla
 * `ventas` no tiene columna `base`).
 */
export interface ReversionesDeAnulacion {
  botellonesReversados: number
  botellonesDevueltos: number
  baseReversada: string | null
}

export interface ResultadoDeAnulacion {
  venta: Venta
  reversiones: ReversionesDeAnulacion
}

export async function anularVenta(
  ventaId: string,
  motivo: string,
  usuario: UserContext,
): Promise<ResultadoDeAnulacion> {
  return db.transaction(async (tx) => {
    const venta = await ventaAnulable(tx, ventaId, usuario)
    const explicacion = exigirMotivo(motivo, 'anular')

    await devolverElProductoALosLotes(tx, ventaId, usuario.id)
    await devolverActivosDeLaVenta(tx, venta, usuario.id)

    await tx
      .update(ventas)
      .set({
        estado: 'anulada',
        anuladaPor: usuario.id,
        anuladaEn: new Date(),
        motivoAnulacion: explicacion,
      })
      .where(eq(ventas.id, ventaId))

    const [anulada] = await tx.select().from(ventas).where(eq(ventas.id, ventaId))

    /**
     * `devolverActivosDeLaVenta` ya escribió los movimientos (con `tipo='retorno'`
     * para la base); los contamos acá para que el caller (la ruta) arme el
     * payload de auditoría sin volver a leer la tabla.
     */
    const reversiones: ReversionesDeAnulacion = {
      botellonesReversados: venta.botellonesEntregados,
      botellonesDevueltos: venta.botellonesRecibidos,
      baseReversada: await baseAsignadaAVenta(tx, venta.id),
    }

    return { venta: anulada!, reversiones }
  })
}

/**
 * Devuelve el `baseId` que esta venta prestó, o `null` si la venta no asignó
 * ninguna base. Se busca en `movimientos_base` (la tabla `ventas` no tiene
 * columna `base`; el tracking es por el libro contable).
 */
async function baseAsignadaAVenta(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ventaId: string,
): Promise<string | null> {
  const [fila] = await tx
    .select({ baseId: movimientosBase.baseId })
    .from(movimientosBase)
    .where(
      and(eq(movimientosBase.documentoId, ventaId), eq(movimientosBase.tipo, 'prestamo')),
    )
    .limit(1)
  return fila?.baseId ?? null
}

/**
 * Revierte los movimientos de BOTELLONES asociados a la venta — RN-ENV-09.
 *
 * Exportada porque la usa también la corrección: la lógica de reversión es la
 * misma, y tener dos implementaciones divergentes (la original con
 * compensatorios de delta, la nueva con movimientos opuestos) es exactamente
 * la clase de duplicación que dejó el bug del doble-conteo en producción.
 *
 * ── El signo importa ────────────────────────────────────────────────────────
 *
 * `entrega` (planta → cliente, cliente recibe): revertir es un `retorno` con
 * `cantidad = -botellonesEntregados` para el cliente. `retorno` (cliente →
 * planta, cliente devuelve): revertir es una `entrega` con
 * `cantidad = +botellonesRecibidos` para el cliente.
 *
 * El `documentoId` de la reversión queda apuntando a la venta ORIGINAL, no a la
 * sucesora. La auditoría reconstruye «esta venta devolvió» mirando la fila
 * original; el `documentoId = ventaOriginal.id` ata el hecho a su origen.
 *
 * Las ventas con `botellonesEntregados = 0` y `botellonesRecibidos = 0` no
 * escriben nada — la mayoría (pacas, repuestos) no tocan el parque.
 */
export async function devolverBotellonesDeLaVenta(
  tx: Transaccion,
  venta: Venta,
  registradoPor: string | null,
): Promise<void> {
  if (venta.tipo === 'dano_base') return

  if (venta.botellonesEntregados > 0) {
    await tx.insert(movimientosBotellon).values([
      {
        cantidad: -venta.botellonesEntregados,
        tipo: 'retorno',
        clienteId: venta.clienteId,
        documentoId: venta.id,
        registradoPor,
      },
      {
        cantidad: venta.botellonesEntregados,
        tipo: 'retorno',
        documentoId: venta.id,
        registradoPor,
      },
    ])
  }

  if (venta.botellonesRecibidos > 0) {
    await tx.insert(movimientosBotellon).values([
      {
        cantidad: venta.botellonesRecibidos,
        tipo: 'entrega',
        clienteId: venta.clienteId,
        documentoId: venta.id,
        registradoPor,
      },
      {
        cantidad: -venta.botellonesRecibidos,
        tipo: 'entrega',
        documentoId: venta.id,
        registradoPor,
      },
    ])
  }
}

/**
 * Revierte los movimientos FÍSICOS asociados a la venta — RN-ENV-09 + decisión
 * D5/D8 del change `botellones-entrega-devolucion`.
 *
 * Tres libros se mueven en una anulación:
 *
 * | Libro | Origen | Reversión |
 * | --- | --- | --- |
 * | `movimientos_botellon` | `entrega` por `botellonesEntregados` | `retorno` con signo opuesto |
 * | `movimientos_botellon` | `retorno` por `botellonesRecibidos` | `entrega` con signo opuesto |
 * | `movimientos_base` | `prestamo` (búsqueda por `documentoId`) | `retorno` + `UPDATE bases SET direccionId = NULL` |
 *
 * La parte de botellones se delega a `devolverBotellonesDeLaVenta` — la
 * corrección usa el mismo helper, así no hay dos implementaciones de la
 * misma reversión.
 */
async function devolverActivosDeLaVenta(
  tx: Transaccion,
  venta: Venta,
  registradoPor: string | null,
): Promise<void> {
  await devolverBotellonesDeLaVenta(tx, venta, registradoPor)

  /*
   * ── La base se identifica por el libro, no por una columna de la venta ───
   *
   * `ventas` no tiene una columna `base`: el préstamo deja una fila en
   * `movimientos_base` con `tipo='prestamo'` y `documentoId=ventaId`. Si la
   * búsqueda no encuentra fila, la venta no prestó base y no hay nada que
   * revertir.
   *
   * El `documentoId` del nuevo movimiento `retorno` lo ata a la venta que
   * anuló — sin él, el libro diría «esta base volvió» sin explicar por qué,
   * y la auditoría no podría conectar el hecho.
   */
  const [movimientoBaseAsignado] = await tx
    .select({ baseId: movimientosBase.baseId })
    .from(movimientosBase)
    .where(
      and(
        eq(movimientosBase.documentoId, venta.id),
        eq(movimientosBase.tipo, 'prestamo'),
      ),
    )

  if (movimientoBaseAsignado) {
    await tx
      .update(bases)
      .set({ direccionId: null })
      .where(eq(bases.id, movimientoBaseAsignado.baseId))
    await tx.insert(movimientosBase).values({
      baseId: movimientoBaseAsignado.baseId,
      tipo: 'retorno',
      documentoId: venta.id,
      registradoPor,
    })
  }
}
