import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, cobros, proveedores } from '@/db/schema'
import { crearInsumo } from '@/modules/insumos/service'
import { registrarCompra } from '@/modules/proveedores/compras'
import { resetDb } from '@/test/db'
import { extracto } from '@/modules/contador/extracto'

/**
 * El extracto de movimientos — M11, RN-CON-03 y 04.
 *
 * ── Qué se prueba acá ───────────────────────────────────────────────────────
 *
 * Que los cinco movimientos de plata caigan en UNA sola vista, con el signo
 * correcto, dentro del rango pedido, y que la suma cuadre contra su propia
 * descomposición.
 *
 * Lo que NO se prueba es contabilidad: Aquazaku no lleva partida doble ni
 * pretende hacerlo (ver /dominio/contador/).
 */

const HOY = '2026-08-28'
/**
 * ── Un rango que SIEMPRE contiene hoy ───────────────────────────────────────
 *
 * Los fixtures que pasan por los servicios de verdad se fechan con `now()`: no
 * se les puede dictar la fecha sin saltearse la garantía que se está probando.
 *
 * Anclar esos tests a un mes fijo hace que la suite se ponga roja SOLA al
 * cambiar el mes. Pasó el 1-sep-2026: siete tests que llevaban días en verde
 * amanecieron rojos sin que nadie tocara una línea, y el primer reflejo fue
 * buscar el bug en el cambio recién escrito.
 *
 * Lo que se prueba de acá para abajo es la CLASIFICACIÓN —qué entra, qué sale,
 * con qué signo—, no el filtro de fechas. Ese tiene su propio bloque arriba,
 * con fechas fijas y fixtures fechados a mano.
 */
const SIEMPRE = { desde: '2000-01-01', hasta: new Date().toISOString().slice(0, 10) }

const DESDE = '2026-08-01'
const HASTA = '2026-08-31'

let clienteId: string
let proveedorId: string
let tapaId: string

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

  const [p] = await db.insert(proveedores).values({ nombre: 'Plásticos del Caribe' }).returning()
  proveedorId = p!.id

  tapaId = (await crearInsumo({ codigo: 'TAPA', nombre: 'Tapa de botellón', minimo: 200 })).id
})

afterAll(async () => {
  await closeDb()
})

const unaCompra = (total: string) =>
  registrarCompra(
    {
      proveedorId,
      medioDePago: 'efectivo',
      lineas: [{ insumoId: tapaId, cantidad: 100, costoUnitario: total }],
    },
    null,
  )

describe('el rango de fechas', () => {
  it('sin movimientos, el extracto está vacío y no rompe', async () => {
    const r = await extracto({ desde: DESDE, hasta: HASTA })

    expect(r.movimientos).toHaveLength(0)
    expect(r.totales.entradas).toBe('0.00')
    expect(r.totales.salidas).toBe('0.00')
  })

  /*
   * El `hasta` es INCLUSIVO. Un contador que pide «agosto» espera que el 31
   * esté adentro; excluirlo pierde un día entero de operación y el error no se
   * nota hasta que alguien concilia contra el banco.
   */
  it('el último día del rango entra', async () => {
    await db.insert(cobros).values({
      clienteId,
      monto: '50000.00',
      medioDePago: 'efectivo',
      createdAt: new Date('2026-08-31T23:30:00-05:00'),
    })

    expect((await extracto({ desde: DESDE, hasta: HASTA })).movimientos).toHaveLength(1)
  })

  it('lo de antes del rango no entra', async () => {
    await db.insert(cobros).values({
      clienteId,
      monto: '50000.00',
      medioDePago: 'efectivo',
      createdAt: new Date('2026-07-31T10:00:00-05:00'),
    })

    expect((await extracto({ desde: DESDE, hasta: HASTA })).movimientos).toHaveLength(0)
  })
})

describe('los cinco movimientos caen en una sola vista — RN-CON-04', () => {
  it('una compra entra como SALIDA', async () => {
    await unaCompra('1200.00')

    const r = await extracto(SIEMPRE)

    expect(r.movimientos).toHaveLength(1)
    expect(r.movimientos[0]!.tipo).toBe('compra')
    expect(r.movimientos[0]!.signo).toBe(-1)
    expect(r.movimientos[0]!.contraparte).toBe('Plásticos del Caribe')
    expect(r.totales.salidas).toBe('120000.00')
  })

  it('un cobro entra como ENTRADA, con su cliente', async () => {
    await db.insert(cobros).values({ clienteId, monto: '80000.00', medioDePago: 'transferencia' })

    const r = await extracto(SIEMPRE)

    expect(r.movimientos[0]!.tipo).toBe('cobro')
    expect(r.movimientos[0]!.signo).toBe(1)
    expect(r.movimientos[0]!.contraparte).toBe('Panadería del Centro')
    expect(r.totales.entradas).toBe('80000.00')
  })

  it('vienen ordenados por fecha, que es como se concilia', async () => {
    await db.insert(cobros).values([
      { clienteId, monto: '10.00', medioDePago: 'efectivo', createdAt: new Date('2026-08-20T10:00:00Z') },
      { clienteId, monto: '20.00', medioDePago: 'efectivo', createdAt: new Date('2026-08-05T10:00:00Z') },
    ])

    const r = await extracto(SIEMPRE)

    expect(r.movimientos.map((m) => m.monto)).toEqual(['20.00', '10.00'])
  })

  /*
   * De cualquier fila se llega al documento y a quién lo registró — RN-CON-06.
   * Cuando un número no cuadra, la pregunta siguiente es siempre «¿de dónde
   * salió esto?», y sin esta columna la respuesta es abrir la base de datos.
   */
  it('cada fila trae su documento', async () => {
    const { compra } = await unaCompra('500.00')

    const r = await extracto(SIEMPRE)

    expect(r.movimientos[0]!.documentoId).toBe(compra.id)
  })
})

/**
 * ── El extracto cuadra, o dice que no cuadra — RN-CON-03 ───────────────────
 */
describe('el cuadre', () => {
  it('las entradas se descomponen por medio de pago, y la suma cierra', async () => {
    await db.insert(cobros).values([
      { clienteId, monto: '30000.00', medioDePago: 'efectivo' },
      { clienteId, monto: '70000.00', medioDePago: 'transferencia' },
    ])

    const r = await extracto(SIEMPRE)

    expect(r.totales.entradas).toBe('100000.00')
    expect(r.totales.porMedioDePago.efectivo).toBe('30000.00')
    expect(r.totales.porMedioDePago.transferencia).toBe('70000.00')
    expect(r.totales.cuadra).toBe(true)
  })

  it('el neto es entradas menos salidas', async () => {
    await db.insert(cobros).values({ clienteId, monto: '200000.00', medioDePago: 'efectivo' })
    await unaCompra('500.00')

    const r = await extracto(SIEMPRE)

    // 200.000 de cobro − 50.000 de compra (100 × 500)
    expect(r.totales.neto).toBe('150000.00')
  })
})

describe('el filtro por tipo', () => {
  it('deja solo lo pedido', async () => {
    await db.insert(cobros).values({ clienteId, monto: '80000.00', medioDePago: 'efectivo' })
    await unaCompra('500.00')

    const r = await extracto({ ...SIEMPRE, tipos: ['compra'] })

    expect(r.movimientos).toHaveLength(1)
    expect(r.movimientos[0]!.tipo).toBe('compra')
  })

  /*
   * Los totales se calculan sobre lo FILTRADO, no sobre todo el período. Un
   * total que no corresponde a las filas que se están viendo es peor que no
   * mostrarlo: nadie lo verifica sumando a mano.
   */
  it('y los totales corresponden a lo filtrado, no al período entero', async () => {
    await db.insert(cobros).values({ clienteId, monto: '80000.00', medioDePago: 'efectivo' })
    await unaCompra('500.00')

    const r = await extracto({ ...SIEMPRE, tipos: ['cobro'] })

    expect(r.totales.entradas).toBe('80000.00')
    expect(r.totales.salidas).toBe('0.00')
  })
})

describe('un rango al revés no es un rango', () => {
  it('se rechaza en vez de devolver vacío', async () => {
    await expect(extracto({ desde: HASTA, hasta: DESDE })).rejects.toMatchObject({
      code: 'RANGO_INVALIDO',
    })
  })
})
