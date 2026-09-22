import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  type Venta,
  devoluciones,
  movimientosBase,
  movimientosBotellon,
  ventas,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import type { UserContext } from '@/modules/authz/can'
import { can } from '@/modules/authz/can'
import type { Transaccion } from '@/modules/stock/saldo'
import { devolverBotellonesDeLaVenta, devolverElProductoALosLotes, exigirMotivo, ventaAnulable } from './anulacion'
import {
  type DatosDeVenta,
  type ResultadoDeVenta,
  exigirFechaRegistrable,
  registrarVentaEn,
} from './venta'

/**
 * Corregir una venta ya registrada — RN-VEN-16.
 *
 * ── Esto NO rompe RN-VEN-02, la aplica ──────────────────────────────────────
 *
 * RN-VEN-02 dice que una venta confirmada es inmutable y que la salida, cuando
 * está mal, es **anular y registrar una nueva**. Eso es exactamente lo que pasa
 * acá abajo: no hay un solo `UPDATE` sobre el total, el cliente, el medio de
 * pago ni las líneas de la venta vieja. El trigger `ventas_solo_anulacion`
 * sigue en pie y sigue rechazándolos.
 *
 * Lo que cambia es que esos dos actos dejan de estar en manos del operador. Un
 * `POST` en vez de dos, una transacción en vez de dos, y un enlace entre las
 * dos filas en vez de nada. Desde la pantalla se siente editar; en la base es
 * el mismo reemplazo que la regla siempre mandó.
 *
 * ── Por qué el orden es revertir → registrar → marcar ───────────────────────
 *
 * El trigger deja tocar la fila vieja UNA sola vez: `OLD.estado <> 'confirmada'`
 * rechaza cualquier segunda escritura. Así que el `UPDATE` que la pasa a
 * `corregida` tiene que llevar ya el id de la sucesora — y para eso la sucesora
 * tiene que existir antes.
 *
 * Eso obliga a devolver el stock ANTES de registrar la nueva, que además es lo
 * correcto por otro motivo: si la corrección solo cambia el cliente, las 30
 * unidades de la venta vieja son las que la nueva necesita. Sin devolverlas
 * primero, corregir el nombre de una venta que vació el último lote fallaría
 * por stock insuficiente contra su propio stock.
 *
 * ── Lo que la corrección NO re-emite ────────────────────────────────────────
 *
 * Los movimientos FÍSICOS de la venta original (botellones entregados,
 * botellones recibidos, base prestada) NO se tocan. La corrección, en cambio,
 * agrega movimientos compensatorios `tipo='ajuste'` sobre la nueva venta con
 * el delta contra la original — así el saldo del cliente se reconstruye desde
 * el libro contable sin perder la historia de la venta vieja.
 *
 * La anulación, en cambio, SÍ revierte los tres: `entrega` → `retorno`,
 * `retorno` (sobre `botellonesRecibidos`) → `entrega`, y `prestamo` (de la
 * base) → `UPDATE bases SET direccionId = NULL` + `retorno`. La reversión
 * espeja el libro para que la auditoría lea de forma coherente quién devuelve
 * qué a quién.
 *
 * Ver change `botellones-entrega-devolucion` (RN-VEN-16, RN-VEN-17, RN-ENV-09).
 */

export interface DatosDeCorreccion extends DatosDeVenta {
  /** Por qué se corrige. Va al `motivo_anulacion` de la venta reemplazada. */
  motivo: string
  /**
   * Override opcional de la fecha del hecho — RN-VEN-16.
   *
   * Ausente ⇒ la venta nueva hereda el instante exacto de la original
   * (`original.createdAt`). Presente y válido ⇒ la venta nueva tiene
   * `createdAt = ${ocurrioEn}T12:00:00-05:00`. La validación corre contra el
   * mismo piso de 90 días y el mismo rechazo de futuro de RN-VEN-14.
   */
  ocurrioEn?: string
}

export interface ResultadoDeCorreccion extends ResultadoDeVenta {
  /** La venta vieja, ya en estado `corregida` y apuntando a la nueva. */
  reemplazada: Venta
}

export async function corregirVenta(
  ventaId: string,
  datos: DatosDeCorreccion,
  usuario: UserContext,
): Promise<ResultadoDeCorreccion> {
  return db.transaction(async (tx) => {
    exigirPermisoDeCorregir(usuario)

    /*
     * Las mismas tres preguntas que la anulación —existe, sigue confirmada, es
     * de quien la toca— y el mismo `FOR UPDATE`. Se reusa `ventaAnulable` y no
     * se copia: dos versiones de «¿se puede tocar esta venta?» que se
     * desincronicen dejan un camino por el que se corrige lo que no se puede
     * anular.
     */
    const original = await ventaAnulable(tx, ventaId, usuario)
    const motivo = exigirMotivo(datos.motivo, 'corregir')

    await exigirQueSeaCorregible(tx, original, datos)

    await devolverElProductoALosLotes(tx, ventaId, usuario.id)

    /*
     * Override de la fecha — RN-VEN-16 fecha corregible.
     *
     * La validación corre ANTES de `db.transaction` abrió, así un 422 corta sin
     * INSERT ni UPDATE. `exigirFechaRegistrable` lanza `ErrorDeNegocio` con el
     * código canónico (`VENTA_EN_EL_FUTURO` / `VENTA_DEMASIADO_VIEJA`) — son los
     * mismos códigos que usa el alta, y la UI ya sabe leerlos.
     *
     * Cuando `datos.ocurrioEn` no viene, se pasa `original.createdAt` para
     * mantener la herencia del instante exacto: la regla de RN-VEN-02 sigue
     * entera porque el `Reemplazo.createdAt` es siempre explícito.
     */
    const fechaOverride = datos.ocurrioEn
      ? exigirFechaRegistrable(datos.ocurrioEn)
      : null

    const resultado = await registrarVentaEn(tx, datos, usuario.id, {
      createdAt: fechaOverride ?? original.createdAt,
      corrigeAId: original.id,
    })

    /*
     * ── Botellones: revertir los originales para que los nuevos manden ─────
     *
     * La venta NUEVA ya insertó sus propios movimientos con
     * `documentoId = nueva.id` (vía `registrarVentaEn`). Los originales,
     * con `documentoId = original.id`, siguen en el libro — preservados para
     * auditoría, pero visibles para `botellonesDe(cliente)`.
     *
     * Sin esta reversión, el saldo del cliente sería `original + nuevo`, no
     * `nuevo`. Es exactamente el bug que dejó un tiempo el sistema
     * duplicando movimientos: la corrección insertaba además «compensatorios
     * de delta» que SUMABAN al error en vez de corregirlo.
     *
     * La misma lógica usa la anulación (RN-ENV-09) — un solo helper compartido
     * para que ambas operaciones no puedan diverger.
     */
    await devolverBotellonesDeLaVenta(tx, original, usuario.id)

    /*
     * El ÚNICO `UPDATE` sobre la venta vieja, con sus cinco campos juntos.
     * Quién, cuándo y por qué es lo mismo que exige la anulación: una
     * corrección sin responsable es un monto que cambió y nadie firmó.
     */
    await tx
      .update(ventas)
      .set({
        estado: 'corregida',
        anuladaPor: usuario.id,
        anuladaEn: new Date(),
        motivoAnulacion: motivo,
        corregidaPorId: resultado.venta.id,
      })
      .where(eq(ventas.id, ventaId))

    const [reemplazada] = await tx.select().from(ventas).where(eq(ventas.id, ventaId))
    return { ...resultado, reemplazada: reemplazada! }
  })
}

/**
 * Corregir es un permiso propio, y NO se hereda de anular.
 *
 * `pos` y `seller` anulan lo PROPIO (RN-VEN-08), y eso está bien: quien se
 * equivocó puede deshacer. Pero corregir además ESCRIBE una venta nueva con la
 * fecha de la vieja, y eso es fechar hacia atrás sin el tope de 90 días que
 * RN-VEN-14 le pone a todo el mundo.
 *
 * Sin esta puerta, la corrección sería una forma de mover plata entre meses
 * cerrados disponible para cualquiera con `ventas:anular`. Por eso la matriz la
 * da solo al admin, y por eso se chequea acá y no solo en la ruta: el día que
 * alguien agregue un segundo endpoint, la regla sigue puesta.
 *
 * Va PRIMERO, antes de leer la venta y antes de mirar el motivo: es la puerta
 * más barata y la más fundamental. Preguntarla después haría que un `pos`
 * recibiera «el motivo es muy corto» sobre una operación que nunca iba a poder
 * hacer.
 */
function exigirPermisoDeCorregir(usuario: UserContext): void {
  if (!can(usuario, 'ventas', 'corregir')) {
    throw new ErrorDeNegocio(
      'SIN_PERMISO',
      403,
      'corregir una venta registrada es de admin. Si la venta está mal, anúlela y registre la correcta',
    )
  }
}

/**
 * Las tres puertas que la corrección cierra y la anulación no.
 *
 * Todas son lo mismo: la corrección deja en pie efectos que la anulación no
 * revierte, así que solo se permite cuando esos efectos siguen siendo ciertos
 * para la venta nueva.
 */
async function exigirQueSeaCorregible(
  tx: Transaccion,
  original: Venta,
  datos: DatosDeCorreccion,
): Promise<void> {
  /*
   * ── 1. Un recargo por daño no es una venta de productos — RN-BAS-08 ───────
   *
   * No tiene líneas —hay un trigger que lo impide— así que no hay nada que
   * devolver al stock ni items con los que rehacerla. Si el recargo está mal,
   * se anula.
   */
  if (original.tipo !== 'producto') {
    throw new ErrorDeNegocio(
      'NO_ES_VENTA_DE_PRODUCTOS',
      422,
      'un recargo por daño no se corrige: no tiene productos que rehacer. Anúlelo y registre el correcto',
    )
  }

  /*
   * ── 2. Una venta con devoluciones ya no se puede rehacer ──────────────────
   *
   * `devoluciones.linea_id` apunta a una línea de ESTA venta con `ON DELETE
   * RESTRICT`. Las líneas viejas no se borran —quedan como testimonio— pero
   * dejarían de ser las vigentes: la devolución acreditaría plata contra una
   * línea que ya no cuenta, y la deuda del cliente quedaría descontada dos
   * veces. El stock devuelto también entró por su lado.
   *
   * Es un nudo que se desata en orden, no de una: primero se revierte la
   * devolución, después se corrige la venta.
   */
  const [conDevoluciones] = await tx
    .select({ cuantas: sql<number>`count(*)::int` })
    .from(devoluciones)
    .where(eq(devoluciones.ventaOrigenId, original.id))

  if ((conDevoluciones?.cuantas ?? 0) > 0) {
    throw new ErrorDeNegocio(
      'VENTA_CON_DEVOLUCIONES',
      422,
      'esa venta ya tiene devoluciones registradas, y corregirla las dejaría colgando de líneas que dejan de contar. Anúlela y registre la venta correcta',
    )
  }

  /*
   * ── 3. Un activo que salió a nombre de alguien no cambia de dueño ─────────
   *
   * Si la venta despachó botellones sin vacío (RN-ENV-03) o prestó una base
   * (RN-BAS-03), esos movimientos quedaron a nombre del cliente original y la
   * corrección no los rehace: el envase salió UNA vez y sigue afuera.
   *
   * Cambiar el cliente acá dejaría la venta a nombre de una persona y el
   * botellón a cargo de otra — y a la hora de reclamarlo, nadie sabría a cuál
   * de las dos ir. Los números de la venta sí se pueden corregir; el dueño del
   * activo, no desde acá.
   */
  if (datos.clienteId !== original.clienteId) {
    /*
     * Las DOS clases de activo, y no solo los botellones. Una base prestada con
     * la venta quedó en una dirección del cliente original; cambiarlo acá
     * dejaría la base reclamable a nadie. Los dos libros guardan `documentoId`
     * apuntando a la venta, así que la pregunta es la misma para los dos.
     */
    const [conBotellones] = await tx
      .select({ cuantos: sql<number>`count(*)::int` })
      .from(movimientosBotellon)
      .where(eq(movimientosBotellon.documentoId, original.id))

    const [conBases] = await tx
      .select({ cuantos: sql<number>`count(*)::int` })
      .from(movimientosBase)
      .where(eq(movimientosBase.documentoId, original.id))

    if ((conBotellones?.cuantos ?? 0) > 0 || (conBases?.cuantos ?? 0) > 0) {
      throw new ErrorDeNegocio(
        'ACTIVOS_A_NOMBRE_DEL_CLIENTE',
        422,
        'esa venta despachó activos —un botellón, una base— que quedaron a cargo del cliente original. Se pueden corregir los productos y los precios, pero no el cliente: primero registre el retorno en Retornables',
      )
    }
  }
}
