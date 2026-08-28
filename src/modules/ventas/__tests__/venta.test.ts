import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { movimientosBotellon } from '@/db/schema'
import { comprarBotellones } from '@/modules/retornables/botellones'
import { botellonesDe, botellonesEnBodega } from '@/modules/retornables/conservacion'
import { closeDb, db } from '@/db/client'
import {
  clientes,
  codigosDeDescuento,
  insumos,
  lineasDeVenta,
  lotes,
  movimientosStock,
  productos,
  ventas,
} from '@/db/schema'
import { deudaDe } from '@/modules/ventas/saldo'
import { registrarVenta } from '@/modules/ventas/venta'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'

/**
 * La transacción de la venta — la compuerta de M6.
 *
 * Lo que se prueba no es que la venta se guarde: es que **o quedan los tres
 * escritos, o no queda ninguno**. Una venta registrada sin descontar stock
 * genera faltantes fantasma; un stock descontado sin venta es producto que
 * desaparece.
 */

const HOY = '2026-08-26'

let botellonId: string
let pacaId: string
let clienteId: string

beforeEach(async () => {
  await resetDb()

  const cargados = await db
    .insert(productos)
    .values([
      {
        codigo: 'BOT_20L',
        nombre: 'Recarga de botellón de 20 L',
        presentacion: 'botellon',
        contenidoMl: 20000,
        unidades: 1,
        precioResidencial: '10000.00',
        precioComercial: '9000.00',
        precioMinimo: '8000.00',
      },
      {
        codigo: 'P20U_600ML',
        nombre: 'Paca de 20 bolsas de 600 ml',
        presentacion: 'paca',
        contenidoMl: 600,
        unidades: 20,
        precioResidencial: '12000.00',
        precioComercial: '11000.00',
        precioMinimo: '9000.00',
      },
    ])
    .returning()
  botellonId = cargados[0]!.id
  pacaId = cargados[1]!.id

  await crearLoteConEntrada(
    { productoId: botellonId, fechaEmpaque: HOY, cantidad: 50, tipo: 'produccion', registradoPor: null },
    db,
  )
  // La paca también tiene stock, pero POCO: alcanza para el test de atomicidad
  // —que necesita llegar a la segunda escritura— y no para el de «no alcanza».
  await crearLoteConEntrada(
    { productoId: pacaId, fechaEmpaque: HOY, cantidad: 5, tipo: 'produccion', registradoPor: null },
    db,
  )

  // Los insumos existen y con saldo: si la venta los tocara, se notaría.
  await db.insert(insumos).values([
    { codigo: 'TAPA_20L', nombre: 'Tapa', minimo: 200, saldo: 500 },
    { codigo: 'SELLO_BOTELLON', nombre: 'Sello', minimo: 200, saldo: 500 },
  ])

  const [cliente] = await db
    .insert(clientes)
    .values({ nombre: 'Yeimy', tipoDocumento: 'CC', numeroDocumento: '79123456' })
    .returning()
  clienteId = cliente!.id
})

afterAll(async () => {
  await closeDb()
})

/**
 * El saldo del lote de un producto.
 *
 * Con dos productos con stock, `(await db.select().from(lotes))[0]` devuelve
 * cualquiera de los dos: el orden no está garantizado. Identificar por posición
 * es la misma clase de error que agarrar un `<nav>` con `.pop()` — el test
 * empieza a medir otra cosa sin avisar.
 */
async function saldoDelLoteDe(productoId: string): Promise<number> {
  const [lote] = await db.select().from(lotes).where(eq(lotes.productoId, productoId))
  return lote!.cantidadDisponible
}

const unaVenta = (extra: Partial<Parameters<typeof registrarVenta>[0]> = {}) =>
  registrarVenta(
    { medioDePago: 'efectivo', items: [{ productoId: botellonId, cantidad: 2 }], hoy: HOY, ...extra },
    null,
  )

describe('la venta de mostrador', () => {
  it('descuenta stock y deja el total', async () => {
    const { venta, lineas } = await unaVenta()

    expect(venta.total).toBe('20000.00')
    expect(lineas).toHaveLength(1)

    expect(await saldoDelLoteDe(botellonId)).toBe(48)
  })

  it('sin cliente es el caso normal, no una excepción', async () => {
    const { venta } = await unaVenta()

    expect(venta.clienteId).toBeNull()
    expect(venta.tipoClienteAlMomento).toBeNull()
  })

  it('el movimiento de stock queda con el id de la venta', async () => {
    const { venta } = await unaVenta()

    const [movimiento] = await db
      .select()
      .from(movimientosStock)
      .where(eq(movimientosStock.tipo, 'venta'))

    expect(movimiento?.documentoId).toBe(venta.id)
    expect(movimiento?.cantidad).toBe(-2)
  })
})

/**
 * ── La venta NO consume tapa ni sello ───────────────────────────────────────
 *
 * El plan de M6 decía que sí, y estaba mal. El dominio es explícito: «se
 * consumen al llenar, no al entregar — si un botellón lleno queda dos días en
 * bodega antes de salir, la tapa se consumió el día que se llenó».
 *
 * El cierre de producción ya cuenta `botellonesLlenados` INCLUYENDO las
 * recargas. Descontarlos otra vez al vender los contaría dos veces: la planta
 * creería tener menos tapas de las que tiene y compraría de más.
 */
describe('vender no vuelve a consumir insumos', () => {
  it('los saldos de tapa y sello quedan intactos', async () => {
    await unaVenta({ items: [{ productoId: botellonId, cantidad: 10 }] })

    const saldos = await db.select().from(insumos).orderBy(insumos.codigo)

    expect(saldos.map((i) => i.saldo)).toEqual([500, 500])
  })
})

describe('el precio se congela — RN-VEN-04 y RN-VEN-12', () => {
  it('un cliente comercial paga la lista comercial, y queda anotado', async () => {
    await db.update(clientes).set({ tipo: 'comercial' }).where(eq(clientes.id, clienteId))

    const { venta } = await unaVenta({ clienteId })

    expect(venta.tipoClienteAlMomento).toBe('comercial')
    expect(venta.total).toBe('18000.00')
  })

  /**
   * El congelado es lo que hace que una venta de hace seis meses no se
   * reinterprete con la lista de precios de hoy.
   */
  it('cambiar el precio del producto después NO reescribe la venta', async () => {
    const { venta } = await unaVenta()

    await db
      .update(productos)
      .set({ precioResidencial: '99999.00' })
      .where(eq(productos.id, botellonId))

    const [linea] = await db.select().from(lineasDeVenta).where(eq(lineasDeVenta.ventaId, venta.id))
    expect(linea?.precioListaAplicado).toBe('10000.00')
  })
})

/**
 * ── Nada se escribe hasta que el plan está completo ─────────────────────────
 *
 * Estos dos tests decían probar la atomicidad, y no la probaban: pasaban igual
 * con la transacción borrada. La razón es que el diseño cambió — ahora se
 * planifica todo (precios, lotes, crédito) ANTES de escribir la primera fila,
 * así que en estos caminos no hay nada que revertir.
 *
 * Eso es mejor que revertir, pero es otra propiedad. Renombrados para decir la
 * que de verdad verifican; la atomicidad se prueba abajo, forzando un fallo
 * DESPUÉS de la primera escritura.
 */
describe('nada se escribe hasta que el plan está completo', () => {
  it('si un producto no tiene stock, no se escribió nada de los anteriores', async () => {
    const antes = await saldoDelLoteDe(botellonId)

    await expect(
      registrarVenta(
        {
          medioDePago: 'efectivo',
          items: [
            { productoId: botellonId, cantidad: 2 },
            // La paca tiene 5: pedir 999 hace fallar el plan de la segunda.
            { productoId: pacaId, cantidad: 999 },
          ],
          hoy: HOY,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'STOCK_INSUFICIENTE' })

    expect(await db.select().from(ventas)).toHaveLength(0)
    expect(await db.select().from(lineasDeVenta)).toHaveLength(0)
    expect(await saldoDelLoteDe(botellonId)).toBe(antes)
    expect(await db.select().from(movimientosStock).where(eq(movimientosStock.tipo, 'venta'))).toHaveLength(0)
  })

  it('si el crédito no alcanza, tampoco', async () => {
    await db
      .update(clientes)
      .set({
        verificacionEstado: 'verificado',
        verificadoEn: new Date(),
        verificacionMetodo: 'admin_oficial',
        creditoHabilitado: true,
        creditoLimite: '5000.00',
      })
      .where(eq(clientes.id, clienteId))

    const antes = await saldoDelLoteDe(botellonId)

    await expect(
      unaVenta({ medioDePago: 'credito', clienteId }),
    ).rejects.toMatchObject({ code: 'LIMITE_SUPERADO' })

    expect(await db.select().from(ventas)).toHaveLength(0)
    expect(await saldoDelLoteDe(botellonId)).toBe(antes)
  })
})

describe('el crédito — RN-VEN-05', () => {
  const habilitar = (limite: string | null) =>
    db
      .update(clientes)
      .set({
        verificacionEstado: 'verificado',
        verificadoEn: new Date(),
        verificacionMetodo: 'admin_oficial',
        creditoHabilitado: true,
        creditoLimite: limite,
      })
      .where(eq(clientes.id, clienteId))

  it('sin crédito habilitado se rechaza y dice la alternativa', async () => {
    await expect(unaVenta({ medioDePago: 'credito', clienteId })).rejects.toMatchObject({
      code: 'SIN_CREDITO',
    })
  })

  it('habilitado y sin tope, entra', async () => {
    await habilitar(null)

    const { venta } = await unaVenta({ medioDePago: 'credito', clienteId })
    expect(venta.medioDePago).toBe('credito')
  })

  it('la deuda es la suma de las ventas a crédito', async () => {
    await habilitar(null)
    await unaVenta({ medioDePago: 'credito', clienteId })
    await unaVenta({ medioDePago: 'credito', clienteId })

    expect(await deudaDe(clienteId)).toBe('40000.00')
  })

  it('una venta de contado NO suma a la deuda', async () => {
    await habilitar(null)
    await unaVenta({ medioDePago: 'credito', clienteId })
    await unaVenta({ medioDePago: 'efectivo', clienteId })

    expect(await deudaDe(clienteId)).toBe('20000.00')
  })

  /** El tope se compara contra deuda + esta venta, no contra la venta sola. */
  it('el tope mira la deuda ACUMULADA', async () => {
    await habilitar('30000.00')
    await unaVenta({ medioDePago: 'credito', clienteId })

    await expect(unaVenta({ medioDePago: 'credito', clienteId })).rejects.toMatchObject({
      code: 'LIMITE_SUPERADO',
    })
  })
})

describe('el descuento', () => {
  const crearCodigo = (valor: string, tipo: 'porcentaje' | 'monto_fijo' = 'porcentaje') =>
    db
      .insert(codigosDeDescuento)
      .values({
        codigo: 'VERANO2026',
        tipo,
        valor,
        vigenciaDesde: '2026-01-01',
        vigenciaHasta: '2026-12-31',
      })
      .returning()

  it('se aplica y baja el total', async () => {
    await crearCodigo('10')

    const { venta } = await unaVenta({ codigoDescuento: 'verano2026' })

    expect(venta.total).toBe('18000.00')
  })

  /**
   * El piso se cobra y se AVISA, no se rechaza: el cliente ya está ahí con el
   * botellón en la mano, y rechazarle la venta por un código que definió mal un
   * admin es cobrarle a él un error de otro.
   */
  it('cuando perfora el piso, cobra el piso y avisa', async () => {
    await crearCodigo('5000.00', 'monto_fijo')

    const { venta, descuentoAplicadoParcialmente } = await unaVenta({ codigoDescuento: 'VERANO2026' })

    expect(venta.total).toBe('16000.00')
    expect(descuentoAplicadoParcialmente).toBe(true)
  })

  it('suma el uso al código', async () => {
    const [codigo] = await crearCodigo('10')
    await unaVenta({ codigoDescuento: 'VERANO2026' })

    const [despues] = await db
      .select()
      .from(codigosDeDescuento)
      .where(eq(codigosDeDescuento.id, codigo!.id))
    expect(despues?.usosRealizados).toBe(1)
  })

  /**
   * Un código vencido LANZA en vez de ignorarse: quien lo dictó espera un
   * descuento, y cobrarle la lista sin decir nada es que se entere al ver el
   * total.
   */
  it('un código que no existe se rechaza, no se ignora', async () => {
    await expect(unaVenta({ codigoDescuento: 'NOEXISTE' })).rejects.toMatchObject({
      code: 'CODIGO_NO_VIGENTE',
    })
  })

  it('un código agotado también', async () => {
    await db.insert(codigosDeDescuento).values({
      codigo: 'UNICO',
      tipo: 'porcentaje',
      valor: '10',
      vigenciaDesde: '2026-01-01',
      vigenciaHasta: '2026-12-31',
      usosMaximos: 1,
      usosRealizados: 1,
    })

    await expect(unaVenta({ codigoDescuento: 'UNICO' })).rejects.toMatchObject({
      code: 'CODIGO_AGOTADO',
    })
  })
})

describe('lo que no se puede vender', () => {
  it('un producto desactivado', async () => {
    await db.update(productos).set({ activo: false }).where(eq(productos.id, botellonId))

    await expect(unaVenta()).rejects.toMatchObject({ code: 'PRODUCTO_INACTIVO' })
  })

  it('a un cliente desactivado', async () => {
    await db.update(clientes).set({ activo: false }).where(eq(clientes.id, clienteId))

    await expect(unaVenta({ clienteId })).rejects.toMatchObject({ code: 'CLIENTE_INACTIVO' })
  })

  it('una venta sin productos', async () => {
    await expect(unaVenta({ items: [] })).rejects.toMatchObject({ code: 'VENTA_VACIA' })
  })

  it('más de lo que hay, con el número real en el mensaje', async () => {
    await expect(
      unaVenta({ items: [{ productoId: botellonId, cantidad: 999 }] }),
    ).rejects.toMatchObject({ code: 'STOCK_INSUFICIENTE' })
  })
})

/**
 * ── La atomicidad, probada forzando un fallo a MITAD de la escritura ────────
 *
 * Los tests de arriba fallan antes de escribir. Este mockea `descontar` para
 * que el segundo lote reviente **después** de que la venta y su primera línea
 * ya están en la base.
 *
 * Sin transacción quedaría una venta con una línea de menos y un lote
 * descontado por producto que nadie compró: un faltante fantasma. Es
 * exactamente lo que M4 probó para el cierre, aplicado acá.
 */
describe('o quedan los tres escritos, o ninguno', () => {
  it('un fallo después de la primera línea no deja ni la venta', async () => {
    const { descontar } = await import('@/modules/stock/saldo')
    const real = descontar

    const espia = vi.spyOn(await import('@/modules/stock/saldo'), 'descontar')
    let llamadas = 0
    espia.mockImplementation(async (salida, ejecutor) => {
      llamadas += 1
      if (llamadas === 2) throw new Error('la base se cayó a mitad de la venta')
      return real(salida, ejecutor)
    })

    const antes = await saldoDelLoteDe(botellonId)

    await expect(
      registrarVenta(
        {
          medioDePago: 'efectivo',
          items: [
            { productoId: botellonId, cantidad: 1 },
            { productoId: pacaId, cantidad: 1 },
          ],
          hoy: HOY,
        },
        null,
      ),
    ).rejects.toThrow(/se cayó a mitad/)

    espia.mockRestore()

    expect(await db.select().from(ventas)).toHaveLength(0)
    expect(await db.select().from(lineasDeVenta)).toHaveLength(0)
    expect(await saldoDelLoteDe(botellonId)).toBe(antes)
  })
})

/**
 * ── La venta y el parque de botellones — RN-ENV-03 y RN-ENV-09 ──────────────
 *
 * Antes de esto eran dos actos separados: el `pos` vendía la recarga y tenía que
 * ACORDARSE de ir a otra pantalla a registrar la entrega. Olvidarlo no dejaba
 * rastro, y ese es el punto — la ley de conservación **no detecta** una fila que
 * falta: `registrados` no cambia, `enPoderDeAlguien` no cambia, y la cuenta
 * cierra igual mientras el envase está en la casa del cliente.
 */
describe('los botellones que salen con la venta', () => {
  const enPoderDe = (id: string) => botellonesDe(id)

  it('la recarga normal no mueve el parque: es un intercambio', async () => {
    const antesEnBodega = await botellonesEnBodega()

    await unaVenta({ clienteId })

    expect(await botellonesEnBodega()).toBe(antesEnBodega)
    expect(await enPoderDe(clienteId)).toBe(0)
  })

  it('el que no trae vacío se lleva el envase, y queda a su nombre', async () => {
    await comprarBotellones(100, 'compra inicial al proveedor', null)

    await unaVenta({ clienteId, botellonesSinVacio: 1 })

    expect(await botellonesEnBodega()).toBe(99)
    expect(await enPoderDe(clienteId)).toBe(1)
  })

  /*
   * El caso mixto es el que justifica que sea un número y no un booleano: en el
   * mostrador se dice «vendí tres, trajo dos vacíos», y eso es UN botellón que
   * sale, no tres ni ninguno.
   */
  it('cuenta solo los que salen, no los que se intercambian', async () => {
    await comprarBotellones(100, 'compra inicial al proveedor', null)

    await registrarVenta(
      {
        medioDePago: 'efectivo',
        clienteId,
        items: [{ productoId: botellonId, cantidad: 3 }],
        botellonesSinVacio: 1,
        hoy: HOY,
      },
      null,
    )

    expect(await enPoderDe(clienteId)).toBe(1)
  })

  it('no se pueden despachar más envases que recargas vendidas', async () => {
    await comprarBotellones(100, 'compra inicial al proveedor', null)

    await expect(unaVenta({ clienteId, botellonesSinVacio: 5 })).rejects.toMatchObject({
      code: 'BOTELLONES_SIN_RESPALDO',
    })
  })

  /*
   * ── El alcance exacto de la regla — RN-ENV-09 ─────────────────────────────
   *
   * La venta anónima sigue siendo válida: quien compra una paca de bolsas no se
   * lleva ningún activo retornable. Lo que exige cliente es que salga un
   * BOTELLÓN, porque es de la empresa y hay que poder reclamarlo.
   */
  it('un botellón no sale sin nombre', async () => {
    await comprarBotellones(100, 'compra inicial al proveedor', null)

    await expect(unaVenta({ botellonesSinVacio: 1 })).rejects.toMatchObject({
      code: 'CLIENTE_REQUERIDO',
    })
  })

  it('pero la venta anónima de una paca sigue siendo válida', async () => {
    const { venta } = await unaVenta({ items: [{ productoId: pacaId, cantidad: 1 }] })

    expect(venta.clienteId).toBeNull()
  })

  it('si la venta se cae, el botellón no salió: una transacción o ninguna', async () => {
    await comprarBotellones(100, 'compra inicial al proveedor', null)

    await expect(
      unaVenta({ clienteId, items: [{ productoId: botellonId, cantidad: 9999 }], botellonesSinVacio: 1 }),
    ).rejects.toMatchObject({ code: 'STOCK_INSUFICIENTE' })

    expect(await botellonesEnBodega()).toBe(100)
    expect(await enPoderDe(clienteId)).toBe(0)
  })

  it('el movimiento apunta a la venta que lo originó', async () => {
    await comprarBotellones(100, 'compra inicial al proveedor', null)

    const { venta } = await unaVenta({ clienteId, botellonesSinVacio: 1 })

    const movimientos = await db
      .select()
      .from(movimientosBotellon)
      .where(eq(movimientosBotellon.documentoId, venta.id))

    expect(movimientos).toHaveLength(2)
    expect(movimientos.map((m) => m.cantidad).sort((a, b) => a - b)).toEqual([-1, 1])
  })
})
