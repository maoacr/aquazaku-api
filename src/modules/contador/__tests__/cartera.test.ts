import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, cobros, lineasDeVenta, lotes, productos, ventas } from '@/db/schema'
import { TRAMOS, carteraPorEdad } from '@/modules/contador/cartera'
import { resetDb } from '@/test/db'

/**
 * Cartera por edad — M11, RN-CON-05.
 *
 * ── Lo que se prueba, y la convención que lo sostiene ───────────────────────
 *
 * Un cobro va contra el SALDO del cliente, no contra una venta concreta: no hay
 * columna que los una. Así que envejecer una deuda obliga a decidir a qué venta
 * se imputa cada pago, y la convención es **la más vieja primero**.
 *
 * Es la práctica habitual, pero sigue siendo una convención — por eso RN-CON-05
 * está como SUPUESTO hasta que el contador la confirme.
 */

const HOY = '2026-08-28'

let clienteId: string
let productoId: string
let loteId: string

/**
 * Una venta con fecha, saltando el servicio para poder fecharla en el pasado.
 *
 * Lleva línea sí o sí: un trigger DIFERIDO de M7 rechaza una venta de producto
 * sin líneas —«un total que no sale de ningún lado»— y se dispara al cerrar la
 * transacción, no al insertar. Que el fixture tenga que respetarlo es la señal
 * de que la garantía es real.
 */
async function unaVenta(
  total: string,
  fecha: string,
  extra: {
    medioDePago?: 'credito' | 'efectivo'
    tipo?: 'producto' | 'dano_base'
    de?: string
  } = {},
) {
  return db.transaction(async (tx) => {
    const [v] = await tx
      .insert(ventas)
      .values({
        clienteId: extra.de ?? clienteId,
        tipoClienteAlMomento: 'comercial',
        medioDePago: extra.medioDePago ?? 'credito',
        tipo: extra.tipo ?? 'producto',
        total,
        createdAt: new Date(`${fecha}T10:00:00-05:00`),
      })
      .returning()

    // El recargo por daño NO lleva líneas: no vende producto.
    if ((extra.tipo ?? 'producto') === 'producto') {
      await tx.insert(lineasDeVenta).values({
        ventaId: v!.id,
        productoId,
        loteId,
        cantidad: 1,
        precioListaAplicado: total,
        descuentoMonto: '0.00',
        precioFinal: total,
        precioMinimoAplicado: '0.00',
      })
    }

    return v!
  })
}

const ventaACredito = (total: string, fecha: string) => unaVenta(total, fecha)

beforeEach(async () => {
  await resetDb()

  const [c] = await db
    .insert(clientes)
    .values({
      nombre: 'Panadería del Centro',
      tipoDocumento: 'NIT',
      numeroDocumento: '900456789',
      tipo: 'comercial',
      verificacionEstado: 'verificado',
      verificadoEn: new Date(),
      verificacionMetodo: 'admin_oficial',
      creditoHabilitado: true,
    })
    .returning()
  clienteId = c!.id

  const [p] = await db
    .insert(productos)
    .values({
      codigo: 'BOT_20L',
      nombre: 'Recarga de botellón',
      presentacion: 'botellon',
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '12000.00',
      precioComercial: '10000.00',
      precioMinimo: '8000.00',
    })
    .returning()
  productoId = p!.id

  const [l] = await db
    .insert(lotes)
    .values({
      productoId,
      codigo: 'L-001',
      fechaEmpaque: '2026-08-01',
      fechaVencimiento: '2026-08-31',
      cantidadInicial: 999,
      cantidadDisponible: 999,
    })
    .returning()
  loteId = l!.id
})

afterAll(async () => {
  await closeDb()
})

describe('los tramos', () => {
  it('son 0–30, 31–60, 61–90 y más de 90', () => {
    expect(TRAMOS.map((t) => t.etiqueta)).toEqual(['0-30', '31-60', '61-90', '90+'])
  })
})

describe('qué aparece y qué no', () => {
  it('un cliente sin deuda no aparece: la cartera lista a quién reclamarle', async () => {
    expect(await carteraPorEdad(HOY)).toHaveLength(0)
  })

  it('una venta de contado tampoco: ya está pagada', async () => {
    await unaVenta('100000.00', HOY, { medioDePago: 'efectivo' })

    expect(await carteraPorEdad(HOY)).toHaveLength(0)
  })

  /*
   * RN-CLI-06 separa la deuda de los cargos pendientes: nacen de cosas
   * distintas y se reclaman distinto. Mezclarlos acá daría un número que no
   * sirve para ninguna de las dos conversaciones.
   */
  it('un recargo por daño NO es deuda, y no entra en la cartera', async () => {
    await unaVenta('80000.00', HOY, { tipo: 'dano_base' })

    expect(await carteraPorEdad(HOY)).toHaveLength(0)
  })

  it('una venta anulada tampoco', async () => {
    const v = await ventaACredito('50000.00', '2026-08-20')

    /*
     * `ventas_anulacion_completa` exige QUIÉN y CUÁNDO además del motivo: una
     * anulación a medias no es un hecho registrado, es un estado que nadie
     * puede explicar después.
     */
    await db
      .update(ventas)
      .set({
        estado: 'anulada',
        motivoAnulacion: 'se facturó otra cosa',
        anuladaEn: new Date(),
        anuladaPor: null,
      })
      .where(eq(ventas.id, v.id))

    expect(await carteraPorEdad(HOY)).toHaveLength(0)
  })
})

describe('la edad sale de la fecha de la venta', () => {
  it('lo de esta semana cae en 0–30', async () => {
    await ventaACredito('50000.00', '2026-08-25')

    const [c] = await carteraPorEdad(HOY)

    expect(c!.cliente).toBe('Panadería del Centro')
    expect(c!.total).toBe('50000.00')
    expect(c!.tramos['0-30']).toBe('50000.00')
  })

  it('lo de hace 45 días cae en 31–60', async () => {
    await ventaACredito('50000.00', '2026-07-14')

    expect((await carteraPorEdad(HOY))[0]!.tramos['31-60']).toBe('50000.00')
  })

  it('lo de hace más de 90 cae en el último tramo', async () => {
    await ventaACredito('50000.00', '2026-05-01')

    expect((await carteraPorEdad(HOY))[0]!.tramos['90+']).toBe('50000.00')
  })

  it('cada venta envejece por su cuenta', async () => {
    await ventaACredito('30000.00', '2026-08-25')
    await ventaACredito('70000.00', '2026-05-01')

    const [c] = await carteraPorEdad(HOY)

    expect(c!.tramos['0-30']).toBe('30000.00')
    expect(c!.tramos['90+']).toBe('70000.00')
    expect(c!.total).toBe('100000.00')
  })
})

/**
 * ── La convención: el pago se imputa a la venta MÁS VIEJA ───────────────────
 *
 * No hay columna que una un cobro con una venta. Sin una convención, un pago
 * parcial no se puede envejecer — y sin envejecer, la cartera no dice a quién
 * reclamarle primero, que es su única razón de existir.
 */
describe('la imputación de los cobros', () => {
  it('un cobro cancela primero lo más viejo', async () => {
    await ventaACredito('40000.00', '2026-05-01') // más de 90 días
    await ventaACredito('60000.00', '2026-08-25') // reciente

    await db.insert(cobros).values({ clienteId, monto: '40000.00', medioDePago: 'efectivo' })

    const [c] = await carteraPorEdad(HOY)

    // Lo viejo quedó saldado; sobrevive lo reciente.
    expect(c!.tramos['90+']).toBe('0.00')
    expect(c!.tramos['0-30']).toBe('60000.00')
    expect(c!.total).toBe('60000.00')
  })

  it('un pago parcial deja el resto en el tramo de esa venta', async () => {
    await ventaACredito('100000.00', '2026-05-01')

    await db.insert(cobros).values({ clienteId, monto: '30000.00', medioDePago: 'efectivo' })

    expect((await carteraPorEdad(HOY))[0]!.tramos['90+']).toBe('70000.00')
  })

  it('pagando todo, el cliente desaparece de la cartera', async () => {
    await ventaACredito('50000.00', '2026-05-01')

    await db.insert(cobros).values({ clienteId, monto: '50000.00', medioDePago: 'efectivo' })

    expect(await carteraPorEdad(HOY)).toHaveLength(0)
  })

  /*
   * Un cobro mayor que la deuda no debería existir —el servicio lo rechaza— pero
   * si aparece por un ajuste, la cartera no puede devolver negativos: se leería
   * como que el cliente tiene saldo a favor, que es otra cosa.
   */
  it('nunca devuelve un tramo negativo', async () => {
    await ventaACredito('50000.00', '2026-05-01')

    await db.insert(cobros).values({ clienteId, monto: '80000.00', medioDePago: 'efectivo' })

    const cartera = await carteraPorEdad(HOY)

    expect(cartera).toHaveLength(0)
  })
})

describe('el orden de la lista', () => {
  it('primero el que más debe: es a quién hay que llamar', async () => {
    await ventaACredito('30000.00', '2026-08-25')

    const [otro] = await db
      .insert(clientes)
      .values({
        nombre: 'Tienda La Esquina',
        tipoDocumento: 'CC',
        numeroDocumento: '1234567',
        verificacionEstado: 'verificado',
        verificadoEn: new Date(),
        verificacionMetodo: 'admin_oficial',
        creditoHabilitado: true,
      })
      .returning()

    await unaVenta('90000.00', '2026-08-25', { de: otro!.id })

    expect((await carteraPorEdad(HOY)).map((c) => c.cliente)).toEqual([
      'Tienda La Esquina',
      'Panadería del Centro',
    ])
  })
})
