import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { movimientosBotellon } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import type { Ejecutor } from '@/modules/stock/saldo'
import { botellonesDe, botellonesEnBodega } from './conservacion'

/**
 * Los movimientos de botellón — RN-ENV-02, RN-ENV-04 y RN-ENV-06.
 *
 * ── Una transferencia son DOS filas ─────────────────────────────────────────
 *
 * Entregar escribe `-n` en la bodega y `+n` en el cliente, en la misma
 * transacción. Las dos suman cero entre sí, y por eso el total del parque no
 * cambia — que es exactamente lo que la ley de conservación verifica.
 *
 * ── Qué protege la transacción y qué protege el candado ─────────────────────
 *
 * Son dos cosas distintas y conviene no confundirlas:
 *
 * - **La transacción** garantiza que las dos filas queden o no quede ninguna.
 *   Sin ella, una entrega a medias descuadra el parque para siempre — y sin ID
 *   individual, esa suma es la única alarma que existe.
 *
 * - **El candado** garantiza que dos entregas simultáneas no dejen la bodega en
 *   negativo. Eso NO es el invariante: la conservación sigue cerrando aunque la
 *   bodega quede en −3, porque el total no cambió. Es una validación de negocio,
 *   y su violación es visible y corregible con un ajuste.
 *
 * Se ponen las dos igual, porque el candado cuesta una línea.
 */

/**
 * Serializa los movimientos de la bodega dentro de la transacción.
 *
 * ── Por qué un advisory lock y no un `UPDATE` condicional ───────────────────
 *
 * El saldo de botellones es **derivado** ([ADR-0008](/decisiones/0008-saldo-derivado-o-materializado/)):
 * no hay columna que decrementar, así que no existe el
 * `UPDATE … WHERE saldo >= :n` que resuelve esto en stock e insumos.
 *
 * Derivarlo fue la decisión correcta —la ley de conservación se apoya en que no
 * haya una segunda copia del número— y este candado es el precio: una línea que
 * hace lo que allá hacía el `WHERE`.
 *
 * `pg_advisory_xact_lock` se libera solo al terminar la transacción, así que no
 * hay forma de olvidarse de soltarlo.
 */
const CANDADO_BODEGA = 74_2001

async function tomarCandado(tx: Ejecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CANDADO_BODEGA})`)
}

/** Entran al parque — RN-ENV-06. Es uno de los dos que cambian el total. */
export async function comprarBotellones(
  cantidad: number,
  motivo: string,
  registradoPor: string | null,
): Promise<number> {
  exigirCantidad(cantidad)

  await db
    .insert(movimientosBotellon)
    .values({ cantidad, tipo: 'compra', motivo: motivo.trim() || null, registradoPor })

  return botellonesEnBodega()
}

export interface Transferencia {
  clienteId: string
  cantidad: number
  /** La venta que la originó, si la hubo. */
  documentoId?: string | undefined
  registradoPor: string | null
}

export interface ResultadoDeTransferencia {
  enBodega: number
  enPoderDelCliente: number
}

/**
 * El cliente se lleva botellones — RN-ENV-03 y RN-ENV-04.
 *
 * En una recarga esto **no se llama**: el cliente entrega un envase vacío y
 * recibe uno lleno, así que su saldo no cambia. Se llama en la primera entrega,
 * que es la que sube el saldo en uno por botellón.
 */
export async function entregarBotellones(
  datos: Transferencia,
): Promise<ResultadoDeTransferencia> {
  exigirCantidad(datos.cantidad)

  return db.transaction(async (tx) => {
    await tomarCandado(tx)

    const disponibles = await botellonesEnBodega(tx)

    if (datos.cantidad > disponibles) {
      /*
       * Con el número real. Que la bodega no alcance casi siempre significa que
       * falta registrar una compra, no que no haya botellones — por eso el
       * mensaje nombra las dos salidas.
       */
      throw new ErrorDeNegocio(
        'BODEGA_INSUFICIENTE',
        422,
        `en la bodega hay ${disponibles} botellones y esta entrega pide ${datos.cantidad}. Si de verdad hay más, falta registrar la compra —o un ajuste con motivo`,
      )
    }

    await tx.insert(movimientosBotellon).values([
      { cantidad: -datos.cantidad, tipo: 'entrega', documentoId: datos.documentoId ?? null, registradoPor: datos.registradoPor },
      { cantidad: datos.cantidad, tipo: 'entrega', clienteId: datos.clienteId, documentoId: datos.documentoId ?? null, registradoPor: datos.registradoPor },
    ])

    return {
      enBodega: await botellonesEnBodega(tx),
      enPoderDelCliente: await botellonesDe(datos.clienteId, tx),
    }
  })
}

/** El cliente devuelve. Las mismas dos filas, al revés. */
export async function retornarBotellones(
  datos: Transferencia,
): Promise<ResultadoDeTransferencia> {
  exigirCantidad(datos.cantidad)

  return db.transaction(async (tx) => {
    await tomarCandado(tx)

    const enPoder = await botellonesDe(datos.clienteId, tx)

    if (datos.cantidad > enPoder) {
      /*
       * Devolver más de lo que figura no es un error del cliente: es que el
       * sistema perdió el rastro de una entrega. Aceptarlo dejaría su saldo en
       * negativo y taparía el problema; rechazarlo con el número lo pone
       * a la vista.
       */
      throw new ErrorDeNegocio(
        'DEVUELVE_DE_MAS',
        422,
        `figuran ${enPoder} botellones en poder de este cliente y está devolviendo ${datos.cantidad}. Si trajo más, falta registrar una entrega anterior`,
      )
    }

    await tx.insert(movimientosBotellon).values([
      { cantidad: -datos.cantidad, tipo: 'retorno', clienteId: datos.clienteId, documentoId: datos.documentoId ?? null, registradoPor: datos.registradoPor },
      { cantidad: datos.cantidad, tipo: 'retorno', documentoId: datos.documentoId ?? null, registradoPor: datos.registradoPor },
    ])

    return {
      enBodega: await botellonesEnBodega(tx),
      enPoderDelCliente: await botellonesDe(datos.clienteId, tx),
    }
  })
}

/**
 * Salen del parque — RN-ENV-05. El otro que cambia el total.
 *
 * Exige motivo: es la única operación que hace desaparecer botellones del
 * sistema, y sin explicación la ley de conservación pierde su valor — cerraría
 * igual mientras alguien descarta lo que quiera.
 */
export async function descartarBotellones(
  cantidad: number,
  motivo: string,
  registradoPor: string | null,
): Promise<number> {
  exigirCantidad(cantidad)

  if (!motivoEsSuficiente(motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `descartar botellones necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres de explicación: es lo único que los saca del parque`,
    )
  }

  return db.transaction(async (tx) => {
    await tomarCandado(tx)

    const disponibles = await botellonesEnBodega(tx)

    if (cantidad > disponibles) {
      throw new ErrorDeNegocio(
        'BODEGA_INSUFICIENTE',
        422,
        `en la bodega hay ${disponibles} botellones y se están descartando ${cantidad}`,
      )
    }

    await tx
      .insert(movimientosBotellon)
      .values({ cantidad: -cantidad, tipo: 'descarte', motivo: motivo.trim(), registradoPor })

    return botellonesEnBodega(tx)
  })
}

/**
 * Corrige un saldo contra un conteo físico.
 *
 * ── El ajuste cambia el total, y la ley lo cuenta ───────────────────────────
 *
 * Escribe **una sola fila**: es la operación que reconoce que el parque tenía
 * otra cantidad de la que el libro decía. Si escribiera dos, no ajustaría nada.
 *
 * Por eso la ley de conservación lo suma del lado de las compras. La primera
 * versión no lo hacía, y habría roto la igualdad para siempre después del primer
 * ajuste — una alarma que suena siempre deja de ser una alarma, y la próxima
 * transferencia a medias se habría escondido detrás del ruido.
 *
 * Contándolo, la igualdad detecta exactamente una cosa: transferencias
 * desbalanceadas. Lo que el ajuste sí necesita es **motivo y responsable**,
 * porque es la única fila que cambia el total sin que haya entrado ni salido
 * nada físicamente.
 */
export async function ajustarBotellones(
  datos: { clienteId?: string | undefined; diferencia: number; motivo: string },
  registradoPor: string | null,
): Promise<number> {
  if (!Number.isInteger(datos.diferencia) || datos.diferencia === 0) {
    throw new ErrorDeNegocio(
      'AJUSTE_INVALIDO',
      422,
      'un ajuste de cero no ajusta nada: la diferencia va con signo, positivo si sobran y negativo si faltan',
    )
  }

  if (!motivoEsSuficiente(datos.motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `un ajuste necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: es la única fila que rompe la ley de conservación a propósito`,
    )
  }

  await db.insert(movimientosBotellon).values({
    cantidad: datos.diferencia,
    tipo: 'ajuste',
    clienteId: datos.clienteId ?? null,
    motivo: datos.motivo.trim(),
    registradoPor,
  })

  return datos.clienteId ? botellonesDe(datos.clienteId) : botellonesEnBodega()
}

function exigirCantidad(cantidad: number): void {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new ErrorDeNegocio(
      'CANTIDAD_INVALIDA',
      422,
      'la cantidad de botellones es un entero positivo',
    )
  }
}
