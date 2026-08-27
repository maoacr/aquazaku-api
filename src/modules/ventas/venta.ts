import { and, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  type Cliente,
  type CodigoDeDescuento,
  type Venta,
  clientes,
  codigosDeDescuento,
  lineasDeVenta,
  productos,
  ventas,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { asignarFifo } from '@/modules/stock/asignacion'
import { descontar } from '@/modules/stock/saldo'
import { exigirCreditoValido } from './credito'
import { aCentavos, aMonto, calcularPrecio, totalDeLinea } from './precio'
import { deudaDe } from './saldo'

/**
 * Registrar una venta — la compuerta de M6.
 *
 * ── Tres escritos, o ninguno ────────────────────────────────────────────────
 *
 * La venta, sus líneas y el descuento de stock con su movimiento. Todo en una
 * transacción: una venta registrada sin descontar stock genera faltantes
 * fantasma que después nadie puede explicar, y un stock descontado sin venta es
 * producto que desaparece.
 *
 * ── TRES y no cuatro: la venta NO consume tapa ni sello ─────────────────────
 *
 * El plan decía cuatro, y estaba mal. El dominio es explícito
 * (/dominio/produccion/): «se consumen al llenar, no al entregar — si un
 * botellón lleno queda dos días en bodega antes de salir, la tapa se consumió el
 * día que se llenó».
 *
 * El cierre de producción ya cuenta `botellonesLlenados` **incluyendo las
 * recargas**, y ahí descuenta tapa y sello. Descontarlos otra vez al vender los
 * contaría dos veces: la planta creería tener menos tapas de las que tiene y
 * dispararía avisos de «hay que pedir» que no corresponden. Peor que un error
 * ruidoso — un inventario que miente a la baja hace comprar de más.
 *
 * ── No hay reserva de stock ─────────────────────────────────────────────────
 *
 * `RN-VEN-09` describe una reserva de cinco minutos. No se construye: el
 * descuento de `sacarConFifo` ya es atómico y bloquea los lotes en orden de
 * vencimiento, así que dos vendedores contra la última unidad ya están
 * serializados. La reserva solo adelantaría el mensaje, y cuesta una tabla con
 * vencimiento, limpieza y reservas huérfanas.
 */

export interface ItemDeVenta {
  productoId: string
  cantidad: number
}

export interface DatosDeVenta {
  clienteId?: string | null
  medioDePago: 'efectivo' | 'transferencia' | 'credito'
  canal?: 'mostrador' | 'whatsapp' | 'ruta'
  items: ItemDeVenta[]
  /** El código tal como lo dictaron. `undefined` es sin descuento. */
  codigoDescuento?: string | undefined
  requiereFacturaElectronica?: boolean
  /** `YYYY-MM-DD`. Se recibe para poder testear el borde del vencimiento. */
  hoy: string
}

export interface LineaRegistrada {
  loteCodigo: string
  productoCodigo: string
  cantidad: number
  precioFinal: string
  aplicadoParcialmente: boolean
}

export interface ResultadoDeVenta {
  venta: Venta
  lineas: LineaRegistrada[]
  /**
   * `true` si algún descuento se recortó contra el piso — RN-VEN-13.
   *
   * La venta NO se rechaza por eso: se cobra el piso y se avisa. Quien está del
   * otro lado del mostrador ya tiene el botellón en la mano.
   */
  descuentoAplicadoParcialmente: boolean
}

export async function registrarVenta(
  datos: DatosDeVenta,
  registradoPor: string | null,
): Promise<ResultadoDeVenta> {
  if (datos.items.length === 0) {
    throw new ErrorDeNegocio('VENTA_VACIA', 422, 'una venta sin productos no es una venta')
  }

  return db.transaction(async (tx) => {
    const cliente = datos.clienteId ? await clienteActivo(tx, datos.clienteId) : null
    const codigo = datos.codigoDescuento
      ? await codigoVigente(tx, datos.codigoDescuento, datos.hoy)
      : null

    /*
     * ── Se PLANIFICA todo antes de escribir nada ─────────────────────────────
     *
     * La primera versión insertaba la venta con total en cero y lo completaba
     * al final. El trigger `ventas_solo_anulacion` la rechazó — y con razón: un
     * `UPDATE` sobre el total es exactamente lo que RN-VEN-02 prohíbe, sin
     * importar quién lo haga ni con qué intención.
     *
     * La salida correcta no era abrirle una excepción al trigger, sino no
     * necesitar el `UPDATE`: `asignarFifo` planifica y **bloquea las filas**
     * dentro de la transacción, así que el total se puede calcular antes de que
     * la venta exista. La fila nace con su valor definitivo y nunca hay un
     * estado intermedio que alguien pueda leer.
     */
    const planificadas: {
      item: ItemDeVenta
      producto: Awaited<ReturnType<typeof productoVendible>>
      precio: ReturnType<typeof calcularPrecio>
      asignaciones: { loteId: string; codigo: string; cantidad: number }[]
    }[] = []

    let totalCentavos = 0
    let huboRecorte = false

    for (const item of datos.items) {
      const producto = await productoVendible(tx, item.productoId)

      /*
       * El precio se elige por el tipo del cliente al momento. Sin cliente —la
       * venta de mostrador normal— se cobra la lista residencial: es la de
       * quien compra un botellón y se va.
       */
      const precioLista =
        cliente?.tipo === 'comercial' ? producto.precioComercial : producto.precioResidencial

      const precio = calcularPrecio(
        precioLista,
        producto.precioMinimo,
        codigo ? { tipo: codigo.tipo, valor: codigo.valor } : undefined,
      )
      if (precio.aplicadoParcialmente) huboRecorte = true

      // Planifica y BLOQUEA los lotes por orden de vencimiento. El bloqueo dura
      // toda la transacción, así que entre planificar y descontar nadie los vacía.
      const plan = await asignarFifo(item.productoId, item.cantidad, datos.hoy, tx)

      if (!plan.ok) {
        /*
         * Que no alcance es un estado normal del negocio, y el mensaje lleva el
         * número REAL. Sin él, quien está en el mostrador tiene que ir a la
         * pantalla de stock a averiguar cuánto puede vender.
         */
        throw new ErrorDeNegocio(
          'STOCK_INSUFICIENTE',
          422,
          `de ${producto.nombre} quedan ${plan.disponible} y esta venta pide ${item.cantidad}`,
        )
      }

      for (const asignacion of plan.asignaciones) {
        totalCentavos += aCentavos(totalDeLinea(precio.precioFinal, asignacion.cantidad))
      }

      planificadas.push({ item, producto, precio, asignaciones: plan.asignaciones })
    }

    const total = aMonto(totalCentavos)

    /*
     * El crédito se chequea con el total ya calculado y ANTES de escribir. Si
     * se pasa del tope, no se escribió nada todavía — y aunque se hubiera
     * escrito, el rollback lo llevaría. Chequearlo acá evita el trabajo inútil.
     */
    if (datos.medioDePago === 'credito') {
      exigirCreditoValido(cliente!, await deudaDe(cliente!.id, tx), total)
    }

    const [venta] = await tx
      .insert(ventas)
      .values({
        clienteId: cliente?.id ?? null,
        // El tipo del cliente AL MOMENTO: un cliente pasa de residencial a
        // comercial y las ventas viejas no se reinterpretan (RN-VEN-12).
        tipoClienteAlMomento: cliente?.tipo ?? null,
        medioDePago: datos.medioDePago,
        canal: datos.canal ?? 'mostrador',
        total,
        codigoDescuentoId: codigo?.id ?? null,
        requiereFacturaElectronica: datos.requiereFacturaElectronica ?? false,
        registradoPor,
      })
      .returning()

    const lineas: LineaRegistrada[] = []

    for (const { producto, precio, asignaciones } of planificadas) {
      /*
       * ── Una línea POR LOTE, no por producto ────────────────────────────────
       *
       * Una venta de 30 puede repartirse entre dos lotes. Cada línea guarda de
       * cuál salió, y eso es lo que hace exacta la anulación: devolver al mismo
       * lote, que tiene su propio vencimiento. Devolver a un lote genérico
       * convertiría producto que vencía el martes en producto que vence el mes
       * que viene.
       */
      for (const asignacion of asignaciones) {
        const salida = await descontar(
          {
            loteId: asignacion.loteId,
            cantidad: asignacion.cantidad,
            tipo: 'venta',
            documentoId: venta!.id,
            registradoPor,
          },
          tx,
        )

        if (!salida.ok) {
          /*
           * No debería poder pasar: `asignarFifo` bloqueó estas filas con
           * `FOR UPDATE` y nadie más las puede tocar hasta que esta transacción
           * termine. Si igual pasara, es una falla del bloqueo y no un caso de
           * negocio — lanzar es lo correcto, porque seguir escribiría una venta
           * que el stock no respalda.
           */
          throw new ErrorDeNegocio(
            'STOCK_INSUFICIENTE',
            422,
            `el lote ${asignacion.codigo} se vació mientras se registraba la venta: quedan ${salida.disponible}`,
          )
        }

        await tx.insert(lineasDeVenta).values({
          ventaId: venta!.id,
          productoId: producto.id,
          loteId: asignacion.loteId,
          cantidad: asignacion.cantidad,
          precioListaAplicado: precio.precioLista,
          descuentoMonto: precio.descuentoMonto,
          precioMinimoAplicado: precio.precioMinimo,
          precioFinal: precio.precioFinal,
        })

        lineas.push({
          loteCodigo: asignacion.codigo,
          productoCodigo: producto.codigo,
          cantidad: asignacion.cantidad,
          precioFinal: precio.precioFinal,
          aplicadoParcialmente: precio.aplicadoParcialmente,
        })
      }
    }

    if (codigo) {
      await tx
        .update(codigosDeDescuento)
        .set({ usosRealizados: sql`${codigosDeDescuento.usosRealizados} + 1` })
        .where(eq(codigosDeDescuento.id, codigo.id))
    }

    const [confirmada] = await tx.select().from(ventas).where(eq(ventas.id, venta!.id))

    return { venta: confirmada!, lineas, descuentoAplicadoParcialmente: huboRecorte }
  })
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function clienteActivo(tx: Tx, id: string): Promise<Cliente> {
  const [cliente] = await tx.select().from(clientes).where(eq(clientes.id, id))

  if (!cliente) throw new ErrorDeNegocio('CLIENTE_NO_ENCONTRADO', 404, 'ese cliente no existe')
  if (!cliente.activo) {
    throw new ErrorDeNegocio(
      'CLIENTE_INACTIVO',
      422,
      `${cliente.nombre} está desactivado y no aparece en operaciones nuevas. Reactívelo desde su ficha si volvió a comprar`,
    )
  }
  return cliente
}

async function productoVendible(tx: Tx, id: string) {
  const [producto] = await tx.select().from(productos).where(eq(productos.id, id))

  if (!producto) throw new ErrorDeNegocio('PRODUCTO_NO_ENCONTRADO', 404, 'ese producto no existe')
  if (!producto.activo) {
    /*
     * Un producto desactivado no se vende. El seed deja las pacas apagadas
     * hasta que alguien les cargue el precio real: vender una a $0 sería
     * exactamente lo que esa decisión evita.
     */
    throw new ErrorDeNegocio(
      'PRODUCTO_INACTIVO',
      422,
      `${producto.nombre} está desactivado: no se puede vender hasta que un admin lo reactive`,
    )
  }
  return producto
}

/**
 * El código, si está vigente hoy y le quedan usos.
 *
 * Un código vencido o agotado **lanza** en vez de ignorarse en silencio: quien
 * lo dictó espera un descuento, y cobrarle el precio de lista sin decir nada es
 * la forma de que se entere recién al ver el total.
 */
async function codigoVigente(tx: Tx, codigo: string, hoy: string): Promise<CodigoDeDescuento> {
  const [encontrado] = await tx
    .select()
    .from(codigosDeDescuento)
    .where(
      and(
        eq(codigosDeDescuento.codigo, codigo.trim().toUpperCase()),
        eq(codigosDeDescuento.activo, true),
        lte(codigosDeDescuento.vigenciaDesde, hoy),
        gte(codigosDeDescuento.vigenciaHasta, hoy),
      ),
    )

  if (!encontrado) {
    throw new ErrorDeNegocio(
      'CODIGO_NO_VIGENTE',
      422,
      `el código ${codigo} no existe, ya venció o está desactivado`,
    )
  }

  if (encontrado.usosMaximos !== null && encontrado.usosRealizados >= encontrado.usosMaximos) {
    throw new ErrorDeNegocio(
      'CODIGO_AGOTADO',
      422,
      `el código ${codigo} llegó a sus ${encontrado.usosMaximos} usos`,
    )
  }

  return encontrado
}
