import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, cobros, lineasDeVenta, productos, ventas } from '@/db/schema'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { pgErrorOf, resetDb } from '@/test/db'

/**
 * Los invariantes de M6, verificados **contra la base**.
 *
 * Todos estos tests escriben con Drizzle directo, esquivando los servicios. Es
 * a propósito: lo que se prueba no es que el servicio valide —eso se prueba
 * aparte— sino que la regla se sostenga **también** cuando el dato entra por un
 * script, por una consola o por un endpoint que alguien agregue el año que
 * viene sin acordarse de ella. Es la línea de ADR-0006.
 */

let productoId: string
let loteId: string
let clienteId: string

beforeEach(async () => {
  await resetDb()

  const [producto] = await db
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
  productoId = producto!.id

  /*
   * Se usa la primitiva de M2 y no un `INSERT` a mano: un lote nace en CERO y
   * sube por movimiento, y hay un `CHECK (cantidad_inicial > 0)` que lo
   * defiende. Forzar la tabla acá habría sido esquivar la regla que M2 puso
   * justamente para que el libro explique cada unidad.
   */
  const lote = await crearLoteConEntrada(
    {
      productoId,
      fechaEmpaque: '2026-08-26',
      cantidad: 100,
      tipo: 'produccion',
      registradoPor: null,
    },
    db,
  )
  loteId = lote.id

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
 * Una venta VÁLIDA: con su línea.
 *
 * ── Por qué el fixture cambió ────────────────────────────────────────────────
 *
 * Antes insertaba la venta sola, porque a estos tests las líneas no les
 * importaban — probaban el `CHECK` de crédito, el trigger de anulación, cosas de
 * la fila `ventas`.
 *
 * Esas filas eran **semánticamente inválidas**: una venta de producto sin
 * líneas tiene un total que no sale de ningún lado. La base no lo sabía hasta
 * que M7 agregó el trigger diferido que lo exige al COMMIT, y ahí se cayeron
 * trece tests de una.
 *
 * El trigger tenía razón y los fixtures estaban mal. Ahora la venta nace con su
 * línea, en una transacción — que es como nace de verdad.
 */
const unaVenta = (extra: Partial<typeof ventas.$inferInsert> = {}) =>
  db.transaction(async (tx) => {
    const [venta] = await tx
      .insert(ventas)
      .values({ medioDePago: 'efectivo', total: '10000.00', ...extra })
      .returning()

    /*
     * El recargo por daño NO lleva línea, y es lo correcto: no hay lote del que
     * salga una base rota. Los dos caminos del invariante quedan ejercitados
     * por el mismo helper.
     */
    if (venta!.tipo !== 'dano_base') {
      await tx.insert(lineasDeVenta).values({
        ventaId: venta!.id,
        productoId,
        loteId,
        cantidad: 1,
        precioListaAplicado: '10000.00',
        descuentoMonto: '0.00',
        precioMinimoAplicado: '8000.00',
        precioFinal: '10000.00',
      })
    }

    return [venta!]
  })

const unaLinea = (ventaId: string, extra: Partial<typeof lineasDeVenta.$inferInsert> = {}) =>
  db.insert(lineasDeVenta).values({
    ventaId,
    productoId,
    loteId,
    cantidad: 1,
    precioListaAplicado: '10000.00',
    descuentoMonto: '0.00',
    precioMinimoAplicado: '8000.00',
    precioFinal: '10000.00',
    ...extra,
  })

describe('el piso absoluto lo sostiene la base — RN-VEN-13', () => {
  it('una línea por debajo del piso no entra', async () => {
    const [venta] = await unaVenta()

    await expect(
      unaLinea(venta!.id, { descuentoMonto: '5000.00', precioFinal: '5000.00' }),
    ).rejects.toThrow()
  })

  it('justo en el piso, sí', async () => {
    const [venta] = await unaVenta()

    await expect(
      unaLinea(venta!.id, { descuentoMonto: '2000.00', precioFinal: '8000.00' }),
    ).resolves.toBeDefined()
  })
})

/**
 * La identidad que hace verificable el comprobante. Sin esto, un descuento mal
 * escrito deja una línea que no cuadra consigo misma y nadie lo nota hasta que
 * alguien suma el mes a mano.
 */
describe('la línea cuadra consigo misma', () => {
  it('final ≠ lista − descuento no entra', async () => {
    const [venta] = await unaVenta()

    await expect(
      unaLinea(venta!.id, { descuentoMonto: '1000.00', precioFinal: '9500.00' }),
    ).rejects.toThrow()
  })

  it('una cantidad de cero tampoco', async () => {
    const [venta] = await unaVenta()

    await expect(unaLinea(venta!.id, { cantidad: 0 })).rejects.toThrow()
  })
})

describe('una venta a crédito exige cliente', () => {
  it('sin cliente no entra: sería una deuda sin dueño', async () => {
    await expect(unaVenta({ medioDePago: 'credito' })).rejects.toThrow()
  })

  it('con cliente, sí', async () => {
    await expect(
      unaVenta({ medioDePago: 'credito', clienteId }),
    ).resolves.toBeDefined()
  })

  it('en efectivo el cliente es opcional, y es el caso normal', async () => {
    await expect(unaVenta()).resolves.toBeDefined()
  })
})

/**
 * ── Una venta confirmada NO SE EDITA — RN-VEN-02 ────────────────────────────
 *
 * Es la regla que más se pide romper por comodidad y la que más caro sale
 * romper: si el monto de ayer puede cambiar hoy, ningún arqueo ni rendición es
 * confiable.
 *
 * Revocar el UPDATE entero haría imposible anular. El trigger deja pasar
 * exactamente la transición que la regla permite, y nada más.
 */
describe('el UPDATE de una venta solo puede anularla', () => {
  it('cambiar el total se rechaza', async () => {
    const [venta] = await unaVenta()

    /*
      * `pgErrorOf` y no `.rejects.toThrow(/…/)`: Drizzle envuelve el error y el
      * mensaje de Postgres queda en `cause`, así que el regex nunca matchearía
      * el texto del trigger. En M3 esa confusión puso 14 tests en rojo de una.
      */
    const err = await pgErrorOf(
      db.update(ventas).set({ total: '1.00' }).where(eq(ventas.id, venta!.id)),
    )

    expect(err.message).toMatch(/solo puede pasar a anulada/)
  })

  it('cambiar el monto MIENTRAS se anula, también', async () => {
    const [venta] = await unaVenta()

    const err = await pgErrorOf(
      db
        .update(ventas)
        .set({
          estado: 'anulada',
          anuladaEn: new Date(),
          motivoAnulacion: 'me equivoqué de producto',
          total: '1.00',
        })
        .where(eq(ventas.id, venta!.id)),
    )

    expect(err.message).toMatch(/anular no edita la venta/)
  })

  it('anular sí, con sus tres campos', async () => {
    const [venta] = await unaVenta()

    await db
      .update(ventas)
      .set({
        estado: 'anulada',
        anuladaEn: new Date(),
        motivoAnulacion: 'el cliente devolvió el botellón sin abrir',
      })
      .where(eq(ventas.id, venta!.id))

    const [anulada] = await db.select().from(ventas).where(eq(ventas.id, venta!.id))
    expect(anulada?.estado).toBe('anulada')
  })

  it('anular dos veces no', async () => {
    const [venta] = await unaVenta()
    const anular = () =>
      db
        .update(ventas)
        .set({ estado: 'anulada', anuladaEn: new Date(), motivoAnulacion: 'un motivo largo' })
        .where(eq(ventas.id, venta!.id))

    await anular()

    expect((await pgErrorOf(anular())).message).toMatch(/ya anulada/)
  })

  /** Media anulación —estado sin motivo— no explica nada en tres meses. */
  it('anular sin motivo no entra', async () => {
    const [venta] = await unaVenta()

    await expect(
      db.update(ventas).set({ estado: 'anulada', anuladaEn: new Date() }).where(eq(ventas.id, venta!.id)),
    ).rejects.toThrow()
  })

  it('y borrarla tampoco: el DELETE está revocado', async () => {
    const [venta] = await unaVenta()

    await expect(db.delete(ventas).where(eq(ventas.id, venta!.id))).rejects.toThrow()
  })
})

/**
 * Las líneas no se tocan NUNCA, ni para anular: quedan como testimonio de que
 * se vendió eso a ese precio. Anular escribe movimientos que devuelven el
 * producto, no reescribe lo que decía el comprobante.
 */
describe('las líneas son inmutables', () => {
  it('no se pueden editar ni borrar', async () => {
    const [venta] = await unaVenta()
    await unaLinea(venta!.id)

    await expect(
      db.update(lineasDeVenta).set({ cantidad: 99 }).where(eq(lineasDeVenta.ventaId, venta!.id)),
    ).rejects.toThrow()
    await expect(
      db.delete(lineasDeVenta).where(eq(lineasDeVenta.ventaId, venta!.id)),
    ).rejects.toThrow()
  })
})

describe('un cobro', () => {
  it('de cero no es un cobro', async () => {
    await expect(
      db.insert(cobros).values({ clienteId, monto: '0.00', medioDePago: 'efectivo' }),
    ).rejects.toThrow()
  })

  /** Pagar una deuda con deuda no la reduce: `credito` no es un medio de PAGO. */
  it('no se paga a crédito', async () => {
    await expect(
      db.insert(cobros).values({ clienteId, monto: '5000.00', medioDePago: 'credito' }),
    ).rejects.toThrow()
  })

  it('tampoco se edita: se corrige con otro documento', async () => {
    const [cobro] = await db
      .insert(cobros)
      .values({ clienteId, monto: '5000.00', medioDePago: 'efectivo' })
      .returning()

    await expect(
      db.update(cobros).set({ monto: '1.00' }).where(eq(cobros.id, cobro!.id)),
    ).rejects.toThrow()
  })
})
