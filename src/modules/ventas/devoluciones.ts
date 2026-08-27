import { eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Devolucion, devoluciones, lineasDeVenta, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { descontar, ingresar } from '@/modules/stock/saldo'
import { aCentavos, aMonto } from './precio'

/**
 * Devoluciones — RN-VEN-10.
 *
 * ── Devolver NO es anular ───────────────────────────────────────────────────
 *
 * La anulación cancela la venta entera y revierte todos sus efectos. La
 * devolución no cancela nada: la venta ocurrió, el cliente pagó, y después trajo
 * **parte** del producto de vuelta.
 *
 * Son dos flujos porque responden a dos preguntas distintas: «esta venta no
 * debió existir» contra «el cliente trajo de vuelta dos de las cinco pacas».
 *
 * ── A dónde va el producto según cómo volvió ────────────────────────────────
 *
 * | Estado | Qué pasa con el inventario |
 * | --- | --- |
 * | `sano` | Vuelve al MISMO lote y se puede volver a vender |
 * | `danado` | Vuelve al lote y sale como descarte, en dos movimientos |
 * | `vencido` | Igual que `danado` |
 *
 * Que lo dañado y lo vencido pasen por el lote en vez de no entrar nunca es
 * deliberado: **el producto existe**. Si no se registrara la entrada, el libro
 * no podría explicar de dónde salió el descarte, y RN-STK-02 quedaría con un
 * agujero. Dos movimientos dicen la verdad completa — volvió, y se descartó.
 */

export interface DatosDeDevolucion {
  lineaId: string
  cantidad: number
  estadoProducto: 'sano' | 'danado' | 'vencido'
  motivo: string
}

/** Se acredita solo si la venta fue a crédito: de contado ya se pagó en efectivo. */
export interface ResultadoDeDevolucion {
  devolucion: Devolucion
  /** Cuánto se le bajó de la deuda. `'0.00'` en una venta de contado. */
  montoAcreditado: string
  volvioAlStock: boolean
}

export async function registrarDevolucion(
  datos: DatosDeDevolucion,
  registradoPor: string | null,
): Promise<ResultadoDeDevolucion> {
  if (!motivoEsSuficiente(datos.motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `una devolución necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres de explicación: es lo que después dice si el producto salió mal de la planta o se manejó mal afuera`,
    )
  }

  return db.transaction(async (tx) => {
    const [linea] = await tx.select().from(lineasDeVenta).where(eq(lineasDeVenta.id, datos.lineaId))

    if (!linea) throw new ErrorDeNegocio('LINEA_NO_ENCONTRADA', 404, 'esa línea de venta no existe')

    const [venta] = await tx.select().from(ventas).where(eq(ventas.id, linea.ventaId))

    if (venta!.estado === 'anulada') {
      /*
       * Anular ya devolvió TODO el producto al lote. Aceptar una devolución
       * encima lo devolvería dos veces: el inventario diría que hay más de lo
       * que hay, y esa clase de descuadre es la que aparece meses después sin
       * poder rastrearse.
       */
      throw new ErrorDeNegocio(
        'VENTA_ANULADA',
        422,
        'esa venta está anulada, así que el producto ya volvió al stock. Una devolución encima lo contaría dos veces',
      )
    }

    const yaDevuelto = await devueltoDe(tx, datos.lineaId)
    const disponible = linea.cantidad - yaDevuelto

    if (datos.cantidad > disponible) {
      throw new ErrorDeNegocio(
        'DEVUELVE_DE_MAS',
        422,
        disponible === 0
          ? 'de esa línea ya se devolvió todo'
          : `esa línea vendió ${linea.cantidad} y ya se devolvieron ${yaDevuelto}: quedan ${disponible}`,
      )
    }

    /*
     * Entra al lote SIEMPRE, incluso lo dañado. El producto existe: si no se
     * registrara la entrada, el descarte de abajo saldría de un lote que nunca
     * lo recibió y el libro no podría explicarlo.
     */
    await ingresar(
      {
        loteId: linea.loteId,
        cantidad: datos.cantidad,
        tipo: 'devolucion',
        documentoId: linea.ventaId,
        registradoPor,
      },
      tx,
    )

    const volvioAlStock = datos.estadoProducto === 'sano'

    if (!volvioAlStock) {
      const salida = await descontar(
        {
          loteId: linea.loteId,
          cantidad: datos.cantidad,
          tipo: 'descarte',
          causa: datos.estadoProducto === 'vencido' ? 'vencido' : 'mal_manejo_cliente',
          motivo: datos.motivo.trim(),
          documentoId: linea.ventaId,
          registradoPor,
        },
        tx,
      )

      // No puede fallar: acaba de entrar en esta misma transacción.
      if (!salida.ok) {
        throw new ErrorDeNegocio(
          'DESCARTE_IMPOSIBLE',
          500,
          'el producto devuelto no se pudo descartar',
        )
      }
    }

    /*
     * Solo se acredita si la venta fue a crédito. De contado el cliente ya pagó
     * en efectivo, y bajarle una deuda que no tiene la dejaría en negativo —
     * que es justamente lo que el cobro se cuida de no producir.
     *
     * Devolver la plata de una venta de contado es un reembolso, y ese es otro
     * documento que el dominio todavía no definió.
     */
    const montoAcreditado =
      venta!.medioDePago === 'credito'
        ? aMonto(aCentavos(linea.precioFinal) * datos.cantidad)
        : '0.00'

    const [devolucion] = await tx
      .insert(devoluciones)
      .values({
        ventaOrigenId: linea.ventaId,
        lineaId: datos.lineaId,
        cantidad: datos.cantidad,
        estadoProducto: datos.estadoProducto,
        motivo: datos.motivo.trim(),
        montoAcreditado,
        registradoPor,
      })
      .returning()

    return { devolucion: devolucion!, montoAcreditado, volvioAlStock }
  })
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Cuánto se devolvió ya de una línea. Evita devolver más de lo vendido. */
async function devueltoDe(tx: Tx, lineaId: string): Promise<number> {
  const [fila] = await tx
    .select({ total: sql<string>`coalesce(sum(${devoluciones.cantidad}), 0)` })
    .from(devoluciones)
    .where(eq(devoluciones.lineaId, lineaId))

  return Number(fila?.total ?? 0)
}

export async function devolucionesDe(ventaId: string): Promise<Devolucion[]> {
  return db
    .select()
    .from(devoluciones)
    .where(eq(devoluciones.ventaOrigenId, ventaId))
    .orderBy(devoluciones.createdAt)
}
