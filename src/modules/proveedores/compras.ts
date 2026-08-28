import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  type Compra,
  type LineaDeCompra,
  compras,
  insumos,
  lineasDeCompra,
  movimientosBotellon,
  proveedores,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { registrarEntrada } from '@/modules/insumos/service'
import { comprarBases } from '@/modules/retornables/bases'
import { aCentavos, aMonto } from '@/modules/ventas/precio'

/**
 * Compras a proveedores — M9, RN-PRO-02 a 07.
 *
 * ── La compra no crea inventario nuevo: le pone nombre al que ya entra ──────
 *
 * Botellones, bases e insumos ya tenían su camino de entrada al parque y al
 * stock. Lo que la compra agrega es **de quién vino, cuánto costó y cómo se
 * paga** — no un segundo inventario.
 *
 * Por eso escribe el documento Y el movimiento en la misma transacción, igual
 * que una venta escribe la venta y el descuento de stock. Registrar la compra
 * sin mover el inventario deja mercadería pagada que el sistema no ve; mover el
 * inventario sin la compra deja stock que apareció de la nada.
 *
 * ── Producto terminado NO se compra ────────────────────────────────────────
 *
 * Aquazaku produce, no revende. Una línea de producto terminado sería un error
 * de registro, y por eso no existe forma de escribirla: la línea solo acepta
 * insumo, botellones o bases.
 */

export interface LineaPedida {
  /** Exactamente uno de los tres. */
  insumoId?: string
  botellones?: number
  bases?: number
  /**
   * Lo RECIBIDO, no lo pedido — RN-PRO-03.
   *
   * Para un insumo son unidades, salvo que venga `kilos`: las bolsas se compran
   * al peso y se guardan por unidad (RN-INS-02).
   */
  cantidad: number
  /** Solo para insumos que se compran al peso. */
  kilos?: number
  costoUnitario: string
}

export interface DatosDeCompra {
  proveedorId: string
  medioDePago: 'efectivo' | 'transferencia' | 'credito'
  /** Obligatoria a crédito, prohibida si no — RN-PRO-07. */
  venceEl?: string
  lineas: LineaPedida[]
}

export interface ResultadoDeCompra {
  compra: Compra
  lineas: LineaDeCompra[]
}

export async function registrarCompra(
  datos: DatosDeCompra,
  registradoPor: string | null,
): Promise<ResultadoDeCompra> {
  if (datos.lineas.length === 0) {
    throw new ErrorDeNegocio('COMPRA_VACIA', 422, 'una compra sin líneas no es una compra')
  }

  const aCredito = datos.medioDePago === 'credito'

  /*
   * La fecha y el crédito van juntos en los dos sentidos. El CHECK de la base
   * dice lo mismo; acá el mensaje puede explicar por qué, que es lo que el
   * operario necesita para corregirlo.
   */
  if (aCredito && !datos.venceEl) {
    throw new ErrorDeNegocio(
      'VENCIMIENTO_REQUERIDO',
      422,
      'una compra a crédito necesita su fecha de vencimiento: sin ella no hay cuándo avisar ni qué reclamar. La dice el proveedor',
    )
  }

  if (!aCredito && datos.venceEl) {
    throw new ErrorDeNegocio(
      'VENCIMIENTO_SIN_CREDITO',
      422,
      'lo que se paga de contado no vence: ya está pagado',
    )
  }

  return db.transaction(async (tx) => {
    const [proveedor] = await tx
      .select()
      .from(proveedores)
      .where(eq(proveedores.id, datos.proveedorId))

    if (!proveedor) {
      throw new ErrorDeNegocio('PROVEEDOR_NO_ENCONTRADO', 404, 'ese proveedor no existe')
    }

    if (!proveedor.activo) {
      /*
       * Un proveedor desactivado conserva su historial —RN-PRO-01— pero no
       * recibe compras nuevas. Si se le volvió a comprar, se reactiva primero:
       * eso deja el hecho registrado en vez de contradecirlo en silencio.
       */
      throw new ErrorDeNegocio(
        'PROVEEDOR_INACTIVO',
        422,
        `${proveedor.nombre} está desactivado. Si le volvieron a comprar, actívelo primero`,
      )
    }

    /*
     * ── Se planifica antes de escribir ──────────────────────────────────────
     *
     * Cada línea se valida y se calcula entera antes de que exista la compra,
     * por la misma razón que en las ventas: la fila nace con su total
     * definitivo y nunca hay un estado intermedio que alguien pueda leer.
     */
    let totalCentavos = 0

    for (const linea of datos.lineas) {
      const cuantas = [linea.insumoId, linea.botellones, linea.bases].filter(
        (x) => x !== undefined,
      ).length

      if (cuantas !== 1) {
        throw new ErrorDeNegocio(
          'LINEA_AMBIGUA',
          422,
          'cada línea compra exactamente una cosa: un insumo, botellones o bases. Una línea que sea dos no se puede convertir en movimiento de inventario sin adivinar cuál',
        )
      }

      if (linea.cantidad <= 0) {
        throw new ErrorDeNegocio('CANTIDAD_INVALIDA', 422, 'una línea recibe al menos algo')
      }

      if (linea.insumoId) {
        const [insumo] = await tx.select().from(insumos).where(eq(insumos.id, linea.insumoId))
        if (!insumo) {
          throw new ErrorDeNegocio('INSUMO_NO_ENCONTRADO', 404, 'ese insumo no existe')
        }
      }

      totalCentavos += Math.round(aCentavos(linea.costoUnitario) * linea.cantidad)
    }

    const [compra] = await tx
      .insert(compras)
      .values({
        proveedorId: datos.proveedorId,
        medioDePago: datos.medioDePago,
        venceEl: datos.venceEl ?? null,
        // Lo de contado nace pagado: no hay nada que cobrar después.
        pagada: !aCredito,
        total: aMonto(totalCentavos),
        registradoPor,
      })
      .returning()

    const guardadas: LineaDeCompra[] = []

    for (const linea of datos.lineas) {
      const [guardada] = await tx
        .insert(lineasDeCompra)
        .values({
          compraId: compra!.id,
          insumoId: linea.insumoId ?? null,
          botellones: linea.botellones ?? null,
          bases: linea.bases ?? null,
          cantidad: String(linea.cantidad),
          costoUnitario: linea.costoUnitario,
        })
        .returning()

      guardadas.push(guardada!)

      /*
       * ── El movimiento de inventario, en la MISMA transacción ─────────────
       *
       * Cada tipo entra por su propio libro, y eso no es una duplicación: son
       * tres activos con reglas distintas. El insumo se consume, el botellón se
       * cuenta, la base se identifica de a una.
       */
      if (linea.insumoId) {
        /*
         * Va por `registrarEntrada` y no por un INSERT directo: esa función ya
         * sabe convertir kilos a unidades con la equivalencia del insumo y deja
         * la conversión ENTERA en el movimiento (RN-INS-02). Reimplementarla acá
         * sería la segunda copia de una regla que vive en un solo lugar — y la
         * que se olvidaría de actualizar el día que cambie.
         */
        await registrarEntrada(
          linea.insumoId,
          linea.kilos !== undefined
            ? { kilos: linea.kilos, documentoId: compra!.id }
            : { cantidad: linea.cantidad, documentoId: compra!.id },
          registradoPor,
          tx,
        )
      }

      if (linea.botellones) {
        await tx.insert(movimientosBotellon).values({
          cantidad: linea.botellones,
          tipo: 'compra',
          motivo: `Compra a ${proveedor.nombre}`,
          registradoPor,
        })
      }

      if (linea.bases) {
        /*
         * Las bases se numeran de a una: cada una nace con su sticker
         * consecutivo y su movimiento de alta. `comprarBases` ya sabe hacerlo y
         * respeta que el número salga del máximo, así que no se reimplementa
         * acá — se le pasa la transacción para que todo caiga junto.
         */
        await comprarBases(linea.bases, registradoPor, tx)
      }
    }

    return { compra: compra!, lineas: guardadas }
  })
}

export interface CompraVencida {
  id: string
  proveedor: string
  total: string
  venceEl: string
  diasDeAtraso: number
}

/**
 * Lo vencido — RN-PRO-07.
 *
 * ── Por qué esto no necesita umbral ────────────────────────────────────────
 *
 * El aviso de bases tuvo que DERIVAR su umbral —cuántas se prestan mientras
 * llega el pedido— porque nadie sabía cuál era el mínimo. Acá el dato ya es una
 * fecha: o pasó o no pasó. No hay nada que estimar.
 *
 * Solo mira las de crédito sin pagar. Una compra de contado nace pagada, así
 * que no puede aparecer acá ni por error.
 */
export async function comprasVencidas(hoy: string): Promise<CompraVencida[]> {
  const filas = await db
    .select({
      id: compras.id,
      proveedor: proveedores.nombre,
      total: compras.total,
      venceEl: compras.venceEl,
      diasDeAtraso: sql<string>`${hoy}::date - ${compras.venceEl}`,
    })
    .from(compras)
    .innerJoin(proveedores, eq(proveedores.id, compras.proveedorId))
    .where(
      and(
        eq(compras.pagada, false),
        eq(compras.estado, 'recibida'),
        isNotNull(compras.venceEl),
        lte(compras.venceEl, hoy),
      ),
    )
    .orderBy(compras.venceEl)

  return filas.map((f) => ({
    id: f.id,
    proveedor: f.proveedor,
    total: f.total,
    venceEl: f.venceEl!,
    diasDeAtraso: Number(f.diasDeAtraso),
  }))
}

/**
 * Marcar una compra como pagada.
 *
 * Es una de las dos únicas transiciones que el trigger permite sobre una compra
 * recibida —la otra es anularla con motivo—. Sin pagos parciales: hoy no existe
 * una sola compra a crédito de la cual derivar cómo se manejan.
 */
export async function marcarPagada(compraId: string): Promise<Compra> {
  return db.transaction(async (tx) => {
    const [compra] = await tx.select().from(compras).where(eq(compras.id, compraId))

    if (!compra) throw new ErrorDeNegocio('COMPRA_NO_ENCONTRADA', 404, 'esa compra no existe')

    if (compra.estado === 'anulada') {
      throw new ErrorDeNegocio(
        'COMPRA_ANULADA',
        422,
        'una compra anulada no se paga: no hay nada que deber',
      )
    }

    if (compra.pagada) {
      /*
       * No es inofensivo: pagar dos veces significa que alguien mandó la plata
       * dos veces, y el sistema tiene que ser el que lo frena.
       */
      throw new ErrorDeNegocio(
        'COMPRA_YA_PAGADA',
        422,
        `esa compra ya figura pagada${compra.venceEl ? ` (vencía el ${compra.venceEl})` : ''}`,
      )
    }

    const [pagada] = await tx
      .update(compras)
      .set({ pagada: true })
      .where(eq(compras.id, compraId))
      .returning()

    return pagada!
  })
}
