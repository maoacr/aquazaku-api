import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { codigosDeDescuento, lineasDeVenta, productos, ventas } from '@/db/schema'
import { registrarVenta } from '@/modules/ventas/venta'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'

/**
 * El precio escrito a mano en la línea — RN-VEN-15.
 *
 * ── Por qué hace falta ──────────────────────────────────────────────────────
 *
 * Aquazaku vendió durante años antes de que este software existiera, a precios
 * que hoy no están en ninguna tabla: $3.800, $5.500, $9.600. Esas ventas se
 * pueden fechar hacia atrás desde RN-VEN-14, pero se cobrarían con la lista de
 * hoy — y una venta de agosto por $10.000 que en realidad fue por $3.800 es un
 * reporte de agosto inventado, con la autoridad de estar en la base.
 *
 * ── El manual es su propio piso ─────────────────────────────────────────────
 *
 * El piso de RN-VEN-13 vive congelado EN LA LÍNEA (`precioMinimoAplicado`), no
 * leído del producto. Entonces una línea manual se escribe con
 * `lista = mínimo = final`: el `CHECK lineas_respetan_el_piso` pasa porque son
 * iguales, y el piso del catálogo sigue protegiendo a las demás líneas.
 *
 * Eso es lo que evita tener que borrar el CHECK. Y borrarlo saldría caro: NO
 * existe un `precio_final >= 0` en la tabla — la no-negatividad sale por
 * transitividad de `productos_precios_no_negativos`. Sin el piso, un
 * `monto_fijo` mal cargado escribe una línea en negativo sin que nada chille.
 *
 * ── Qué se vigila acá ───────────────────────────────────────────────────────
 *
 * Que el número que se escribió sea EXACTAMENTE el que queda, que se multiplique
 * por la cantidad sin perder centavos, y que siga siendo el mismo cuando FIFO
 * parte el ítem en dos lotes.
 */

const HOY = '2026-08-26'

let botellonId: string
let pacaId: string

beforeEach(async () => {
  await resetDb()

  const [botellon] = await db
    .insert(productos)
    .values({
      codigo: 'BOT_20L',
      nombre: 'Recarga de botellón de 20 L',
      presentacion: 'botellon',
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })
    .returning()

  botellonId = botellon!.id

  /*
   * La paca está acá porque el precio es POR FILA DE PRODUCTO y no por unidad
   * interna: `unidades: 20` solo alimenta la columna generada `litros`
   * (RN-CAT-10 — la paca no es divisible). Si alguien algún día divide el
   * precio manual por `unidades`, este test lo agarra.
   */
  const [paca] = await db
    .insert(productos)
    .values({
      codigo: 'PACA_360',
      nombre: 'Paca de bolsas de 360 ml',
      presentacion: 'paca',
      contenidoMl: 360,
      unidades: 20,
      precioResidencial: '6000.00',
      precioComercial: '5500.00',
      precioMinimo: '5000.00',
    })
    .returning()

  pacaId = paca!.id

  for (const productoId of [botellonId, pacaId]) {
    await crearLoteConEntrada(
      { productoId, fechaEmpaque: '2026-08-01', cantidad: 100, tipo: 'produccion', registradoPor: null },
      db,
    )
  }
})

const vender = (extra: Record<string, unknown> = {}) =>
  registrarVenta({ medioDePago: 'efectivo', items: [], hoy: HOY, ...extra }, null)

const lineasDe = (ventaId: string) =>
  db.select().from(lineasDeVenta).where(eq(lineasDeVenta.ventaId, ventaId))

describe('una línea con precio escrito a mano', () => {
  it('congela el número exacto que se escribió', async () => {
    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 1, precioManual: '3800' }],
    })

    const [linea] = await lineasDe(venta.id)

    expect(linea?.precioFinal).toBe('3800.00')
  })

  /**
   * Los cuatro números tienen que seguir explicando la línea solos — RN-VEN-04.
   *
   * `lista = mínimo = final` con descuento en cero es lo que hace pasar los dos
   * CHECK sin excepciones: `final >= mínimo` porque son iguales, y
   * `final = lista − descuento` porque el descuento es cero.
   */
  it('escribe el manual como lista Y como piso, sin descuento', async () => {
    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 1, precioManual: '3800' }],
    })

    const [linea] = await lineasDe(venta.id)

    expect(linea).toMatchObject({
      precioListaAplicado: '3800.00',
      precioMinimoAplicado: '3800.00',
      descuentoMonto: '0.00',
      precioFinal: '3800.00',
      precioManual: true,
    })
  })

  /**
   * ── El caso que motivó todo ───────────────────────────────────────────────
   *
   * El piso del catálogo hoy es $8.000. Sin esta feature, cargar la venta real
   * de $3.800 es imposible: la rechaza Postgres, no el servicio.
   */
  it('acepta un precio MUY por debajo del piso de hoy', async () => {
    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 1, precioManual: '3800' }],
    })

    expect(venta.total).toBe('3800.00')
  })

  it('deja la línea normal cuando nadie escribió un precio', async () => {
    const { venta } = await vender({ items: [{ productoId: botellonId, cantidad: 1 }] })

    const [linea] = await lineasDe(venta.id)

    expect(linea).toMatchObject({
      precioListaAplicado: '10000.00',
      precioMinimoAplicado: '8000.00',
      precioFinal: '10000.00',
      precioManual: false,
    })
  })
})

describe('el precio manual es POR UNIDAD', () => {
  it('multiplica por la cantidad de botellones', async () => {
    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 3, precioManual: '3800' }],
    })

    expect(venta.total).toBe('11400.00')
  })

  /**
   * La paca vale lo que vale la paca, no lo que valen sus 20 bolsas — RN-CAT-10.
   */
  it('multiplica por pacas, sin dividir por las unidades de adentro', async () => {
    const { venta } = await vender({
      items: [{ productoId: pacaId, cantidad: 4, precioManual: '5500' }],
    })

    expect(venta.total).toBe('22000.00')
  })

  it('suma líneas manuales y de lista en la misma venta', async () => {
    const { venta } = await vender({
      items: [
        { productoId: botellonId, cantidad: 2, precioManual: '3800' },
        { productoId: pacaId, cantidad: 1 },
      ],
    })

    // 2 × 3.800 = 7.600, más la paca a lista 6.000
    expect(venta.total).toBe('13600.00')
  })
})

describe('el precio manual y el código de descuento', () => {
  const crearCodigo = () =>
    db.insert(codigosDeDescuento).values({
      codigo: 'VERANO2026',
      tipo: 'porcentaje',
      valor: '10',
      vigenciaDesde: '2026-01-01',
      vigenciaHasta: '2026-12-31',
    })

  /**
   * El manual es el precio que YA se cobró. Un descuento encima lo cambiaría a
   * un número que nunca ocurrió.
   */
  it('el código no toca la línea manual', async () => {
    await crearCodigo()

    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 1, precioManual: '3800' }],
      codigoDescuento: 'verano2026',
    })

    const [linea] = await lineasDe(venta.id)

    expect(linea).toMatchObject({ precioFinal: '3800.00', descuentoMonto: '0.00' })
  })

  it('pero sí sigue aplicando a las otras líneas de la misma venta', async () => {
    await crearCodigo()

    const { venta } = await vender({
      items: [
        { productoId: botellonId, cantidad: 1, precioManual: '3800' },
        { productoId: pacaId, cantidad: 1 },
      ],
      codigoDescuento: 'verano2026',
    })

    const lineas = await lineasDe(venta.id)
    const paca = lineas.find((l) => l.productoId === pacaId)

    // 10 % de 6.000 son 600, y el piso de la paca (5.000) no se perfora.
    expect(paca).toMatchObject({ descuentoMonto: '600.00', precioFinal: '5400.00' })
  })
})

describe('el precio manual cuando FIFO parte el ítem', () => {
  /**
   * `venta.ts` inserta una línea POR ASIGNACIÓN de lote, no por ítem. Un pedido
   * de 120 sale de dos lotes y escribe dos líneas — y las dos tienen que llevar
   * el mismo precio escrito a mano, o el total se parte por la mitad del ítem.
   */
  it('las dos líneas llevan el mismo precio y el total cierra', async () => {
    await crearLoteConEntrada(
      {
        productoId: botellonId,
        fechaEmpaque: '2026-08-10',
        cantidad: 100,
        tipo: 'produccion',
        registradoPor: null,
      },
      db,
    )

    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 120, precioManual: '3800' }],
    })

    const lineas = await lineasDe(venta.id)

    expect(lineas).toHaveLength(2)
    expect(lineas.every((l) => l.precioFinal === '3800.00' && l.precioManual)).toBe(true)
    expect(lineas.reduce((n, l) => n + l.cantidad, 0)).toBe(120)
    expect(venta.total).toBe('456000.00')
  })
})

describe('el precio manual junto con la fecha anterior', () => {
  /**
   * El caso completo por el que existe la feature: una venta de hace dos
   * semanas, al precio que de verdad se cobró ese día.
   */
  it('queda fechada ese día y con el precio de ese día', async () => {
    const { venta } = await vender({
      items: [{ productoId: botellonId, cantidad: 2, precioManual: '3500' }],
      ocurrioEn: '2026-08-12',
    })

    const [guardada] = await db.select().from(ventas).where(eq(ventas.id, venta.id))
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
      guardada!.createdAt,
    )

    expect(dia).toBe('2026-08-12')
    expect(guardada?.total).toBe('7000.00')
  })
})
