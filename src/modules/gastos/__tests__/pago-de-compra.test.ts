import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { cuentasDeDinero, movimientosDeDinero, proveedores } from '@/db/schema'
import { hoyEnLaPlanta } from '@/lib/dia'
import { saldoDe } from '@/modules/gastos/cuentas'
import { anularMovimiento, listarMovimientos, registrarSaldoInicial } from '@/modules/gastos/libro'
import { crearInsumo } from '@/modules/insumos/service'
import { marcarPagada, registrarCompra } from '@/modules/proveedores/compras'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

/**
 * La compra a proveedor descuenta de una cuenta — RN-GAS-11.
 *
 * ── El hueco que esto cierra ────────────────────────────────────────────────
 *
 * M9 movía el inventario y congelaba el costo, pero no tocaba ninguna caja. La
 * plata salía del cajón de verdad y el saldo del sistema seguía igual: el
 * módulo de gastos mostraba más plata de la que había, por el total de lo
 * comprado a proveedores, y nada lo explicaba.
 */

const UN_CONTEXTO = { userId: null, rolEjercido: ['admin'], requestId: 'req-de-prueba' }
const HOY = hoyEnLaPlanta()

let proveedorId: string
let tapaId: string
let cajaMenor: string
let cajaMayor: string

beforeEach(async () => {
  await resetDb()

  const [p] = await db.insert(proveedores).values({ nombre: 'Plásticos del Caribe' }).returning()
  proveedorId = p!.id
  tapaId = (await crearInsumo({ codigo: 'TAPA', nombre: 'Tapa', minimo: 200 }, UN_CONTEXTO)).id

  const cuentas = await db.select().from(cuentasDeDinero)
  cajaMenor = cuentas.find((c) => c.tipo === 'caja_menor')!.id
  cajaMayor = cuentas.find((c) => c.tipo === 'caja_mayor')!.id

  await registrarSaldoInicial(
    { cuentaId: cajaMenor, monto: '1000000', ocurridoEl: HOY, concepto: 'lo que había' },
    null,
    UN_CONTEXTO,
  )
})

afterAll(async () => {
  await closeDb()
})

const comprar = (extra: object = {}) =>
  registrarCompra(
    {
      proveedorId,
      medioDePago: 'efectivo',
      cuentaId: cajaMenor,
      lineas: [{ insumoId: tapaId, cantidad: 500, costoUnitario: '120.00' }],
      ...extra,
    },
    null,
    UN_CONTEXTO,
  )

describe('la compra de contado saca la plata de la cuenta', () => {
  it('el saldo baja por el total de la compra', async () => {
    await comprar()

    // 1.000.000 − (500 × 120)
    expect(await saldoDe(cajaMenor)).toBe(94000000)
  })

  it('deja su fila en el libro, atada a la compra y con el proveedor', async () => {
    const { compra } = await comprar()

    const [fila] = await listarMovimientos({ tipo: 'egreso' })

    expect(fila!.compraRelacionada).toBe(compra.id)
    expect(fila!.concepto).toBe('Compra a Plásticos del Caribe')
    expect(fila!.efecto).toBe('-60000.00')
  })

  /*
   * El pago de una compra NO es una categoría de gasto: qué se compró ya está
   * en las líneas. Si llevara categoría, el reporte «en qué se gastó» contaría
   * la compra como un gasto más.
   */
  it('no lleva categoría de gasto: la compra ya dice qué se compró', async () => {
    await comprar()

    const [fila] = await listarMovimientos({ tipo: 'egreso' })

    expect(fila!.tipoDeEgreso).toBeNull()
  })

  /*
   * El invariante que de verdad importa: la compra y su pago caen juntos o no
   * cae ninguno. Registrar mercadería que no se pudo pagar deja un inventario
   * que el dinero no explica.
   */
  it('si la caja no alcanza, no hay compra NI inventario', async () => {
    await expect(
      registrarCompra(
        {
          proveedorId,
          medioDePago: 'efectivo',
          cuentaId: cajaMayor, // está en cero
          lineas: [{ insumoId: tapaId, cantidad: 500, costoUnitario: '120.00' }],
        },
        null,
        UN_CONTEXTO,
      ),
    ).rejects.toMatchObject({ code: 'SALDO_INSUFICIENTE' })

    expect(await db.select().from(movimientosDeDinero).where(eq(movimientosDeDinero.tipo, 'egreso'))).toHaveLength(0)
    expect(await saldoDe(cajaMenor)).toBe(100000000)
  })

  it('una compra de contado sin cuenta se rechaza, y dice por qué', async () => {
    await expect(
      registrarCompra(
        {
          proveedorId,
          medioDePago: 'efectivo',
          lineas: [{ insumoId: tapaId, cantidad: 1, costoUnitario: '120.00' }],
        },
        null,
        UN_CONTEXTO,
      ),
    ).rejects.toMatchObject({ code: 'CUENTA_REQUERIDA' })
  })
})

describe('lo que se compra a crédito no mueve plata hasta que se paga', () => {
  const aCredito = () =>
    registrarCompra(
      {
        proveedorId,
        medioDePago: 'credito',
        venceEl: '2027-01-30',
        lineas: [{ insumoId: tapaId, cantidad: 500, costoUnitario: '120.00' }],
      },
      null,
      UN_CONTEXTO,
    )

  it('al registrarse no toca ninguna cuenta', async () => {
    const { pago } = await aCredito()

    expect(pago).toBeNull()
    expect(await saldoDe(cajaMenor)).toBe(100000000)
  })

  it('al marcarla pagada, ahí sí baja el saldo', async () => {
    const { compra } = await aCredito()

    await marcarPagada(compra.id, cajaMenor, UN_CONTEXTO)

    expect(await saldoDe(cajaMenor)).toBe(94000000)
  })

  it('elegir cuenta al comprar a crédito se rechaza: todavía no se paga', async () => {
    await expect(
      registrarCompra(
        {
          proveedorId,
          medioDePago: 'credito',
          venceEl: '2027-01-30',
          cuentaId: cajaMenor,
          lineas: [{ insumoId: tapaId, cantidad: 1, costoUnitario: '120.00' }],
        },
        null,
        UN_CONTEXTO,
      ),
    ).rejects.toMatchObject({ code: 'CUENTA_SIN_PAGO' })
  })
})

describe('una compra se paga una sola vez', () => {
  it('la BASE lo impide, no solo el servicio', async () => {
    const { compra } = await comprar()

    const error = await pgErrorOf(
      db.insert(movimientosDeDinero).values({
        cuentaId: cajaMenor,
        tipo: 'egreso',
        monto: '60000.00',
        ocurridoEl: HOY,
        concepto: 'el mismo pago, otra vez',
        compraRelacionada: compra.id,
      }),
    )

    expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    expect(error.message).toContain('movimientos_dinero_una_compra_un_pago')
  })

  /* Si el pago se cargó en la cuenta equivocada: se anula y se rehace. */
  it('anulado el pago, se puede volver a registrar en otra cuenta', async () => {
    const { compra } = await comprar()
    const [pago] = await listarMovimientos({ tipo: 'egreso' })

    await anularMovimiento(pago!.id, 'lo pagué de la caja mayor, no de la menor', UN_CONTEXTO)

    expect(await saldoDe(cajaMenor)).toBe(100000000)

    const [reintento] = await db
      .insert(movimientosDeDinero)
      .values({
        cuentaId: cajaMenor,
        tipo: 'egreso',
        monto: '60000.00',
        ocurridoEl: HOY,
        concepto: 'Compra a Plásticos del Caribe',
        compraRelacionada: compra.id,
      })
      .returning()

    expect(reintento!.efecto).toBe('-60000.00')
  })
})

describe('el pago de una compra no se puede disfrazar de gasto suelto', () => {
  /*
   * RN-GAS-07, ahora con más fuerza: un egreso lleva categoría O compra, nunca
   * las dos. Si llevara las dos, el reporte «en qué se gastó» contaría la
   * compra encima de lo que ya cuenta el extracto del contador.
   */
  it('un egreso con categoría Y compra se rechaza en la base', async () => {
    const { compra } = await comprar()
    const [pago] = await listarMovimientos({ tipo: 'egreso' })
    await anularMovimiento(pago!.id, 'para poder probar el otro camino', UN_CONTEXTO)

    const error = await pgErrorOf(
      db.insert(movimientosDeDinero).values({
        cuentaId: cajaMenor,
        tipo: 'egreso',
        tipoDeEgreso: 'repuesto',
        monto: '60000.00',
        ocurridoEl: HOY,
        concepto: 'la misma compra, como gasto',
        compraRelacionada: compra.id,
      }),
    )

    expect(error.constraint).toBe('movimientos_dinero_pago_de_compra_sin_categoria')
  })

  it('y un egreso sin categoría y sin compra tampoco existe', async () => {
    const error = await pgErrorOf(
      db.insert(movimientosDeDinero).values({
        cuentaId: cajaMenor,
        tipo: 'egreso',
        monto: '1000.00',
        ocurridoEl: HOY,
        concepto: 'un egreso que no dice qué fue',
      }),
    )

    expect(error.constraint).toBe('movimientos_dinero_egreso_con_su_tipo')
  })
})
