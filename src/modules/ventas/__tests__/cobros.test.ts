import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, productos } from '@/db/schema'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { anularVenta } from '@/modules/ventas/anulacion'
import { cartera, registrarCobro } from '@/modules/ventas/cobros'
import { crearCodigo, desactivarCodigo, listarCodigos } from '@/modules/ventas/descuentos'
import { deudaDe } from '@/modules/ventas/saldo'
import { registrarVenta } from '@/modules/ventas/venta'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'
import type { UserContext } from '@/modules/authz/can'

const HOY = '2026-08-26'
let productoId: string
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

  await crearLoteConEntrada(
    { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
    db,
  )

  const [cliente] = await db
    .insert(clientes)
    .values({
      nombre: 'Yeimy',
      tipoDocumento: 'CC',
      numeroDocumento: '79123456',
      verificacionEstado: 'verificado',
      verificadoEn: new Date(),
      verificacionMetodo: 'admin_oficial',
      creditoHabilitado: true,
    })
    .returning()
  clienteId = cliente!.id
})

afterAll(async () => {
  await closeDb()
})

/** Deja al cliente debiendo `cantidad × $10.000`. */
const venderACredito = (cantidad: number) =>
  registrarVenta(
    { medioDePago: 'credito', clienteId, items: [{ productoId, cantidad }], hoy: HOY },
    null,
  )

describe('el cobro es un documento aparte — RN-VEN-07', () => {
  /**
   * Modelarlo como un campo de la venta haría imposibles las dos cosas que más
   * pasan: un pago parcial y un pago que cubre varias ventas.
   */
  it('un cobro parcial reduce la deuda sin cerrar la venta', async () => {
    await venderACredito(3)

    const { deudaRestante, quedaSaldada } = await registrarCobro(
      { clienteId, monto: '10000.00', medioDePago: 'efectivo' },
      null,
    )

    expect(deudaRestante).toBe('20000.00')
    expect(quedaSaldada).toBe(false)
    expect(await deudaDe(clienteId)).toBe('20000.00')
  })

  it('un cobro puede cubrir varias ventas de una', async () => {
    await venderACredito(1)
    await venderACredito(2)

    const { quedaSaldada } = await registrarCobro(
      { clienteId, monto: '30000.00', medioDePago: 'transferencia' },
      null,
    )

    expect(quedaSaldada).toBe(true)
    expect(await deudaDe(clienteId)).toBe('0.00')
  })
})

/**
 * ── Cobrar de más se rechaza, y es una decisión ─────────────────────────────
 *
 * El dominio no dice qué pasa si alguien paga de más. Aceptarlo dejaría una
 * deuda negativa que ningún módulo sabe gastar: no hay forma de aplicarla a una
 * venta futura ni de devolverla.
 *
 * Rechazar con la deuda REAL es reversible; aceptarlo en silencio no lo es.
 */
describe('cobrar de más', () => {
  it('se rechaza, con el número real', async () => {
    await venderACredito(1)

    await expect(
      registrarCobro({ clienteId, monto: '50000.00', medioDePago: 'efectivo' }, null),
    ).rejects.toMatchObject({ code: 'COBRO_MAYOR_QUE_LA_DEUDA' })
  })

  it('a un cliente sin deuda, también', async () => {
    await expect(
      registrarCobro({ clienteId, monto: '1000.00', medioDePago: 'efectivo' }, null),
    ).rejects.toMatchObject({ code: 'COBRO_MAYOR_QUE_LA_DEUDA' })
  })

  it('justo la deuda entera, sí', async () => {
    await venderACredito(2)

    await expect(
      registrarCobro({ clienteId, monto: '20000.00', medioDePago: 'efectivo' }, null),
    ).resolves.toMatchObject({ quedaSaldada: true })
  })
})

/**
 * Anular una venta a crédito baja la deuda. Si el cliente ya había pagado, la
 * deuda queda en negativo — pero eso lo produce la anulación, no un cobro, y es
 * información correcta: el negocio le debe.
 */
describe('la deuda después de anular', () => {
  it('anular una venta ya cobrada deja saldo a favor visible', async () => {
    const autor = await usuarioAutenticado('admin')
    const { venta } = await venderACredito(2)
    await registrarCobro({ clienteId, monto: '20000.00', medioDePago: 'efectivo' }, null)

    await anularVenta(venta.id, 'el cliente devolvió todo sin abrir', {
      id: autor.usuario.id,
      roles: ['admin'],
    } as UserContext)

    // Negativo: el negocio le debe. No lo produjo un cobro de más.
    expect(await deudaDe(clienteId)).toBe('-20000.00')
  })
})

describe('la cartera', () => {
  it('lista quién debe, de mayor a menor', async () => {
    const [otro] = await db
      .insert(clientes)
      .values({
        nombre: 'Panadería',
        tipoDocumento: 'NIT',
        numeroDocumento: '900123456',
        verificacionEstado: 'verificado',
        verificadoEn: new Date(),
        verificacionMetodo: 'admin_oficial',
        creditoHabilitado: true,
      })
      .returning()

    await venderACredito(1)
    await registrarVenta(
      { medioDePago: 'credito', clienteId: otro!.id, items: [{ productoId, cantidad: 5 }], hoy: HOY },
      null,
    )

    const filas = await cartera()

    expect(filas.map((f) => f.cliente.nombre)).toEqual(['Panadería', 'Yeimy'])
    expect(filas[0]?.deuda).toBe('50000.00')
  })

  it('quien no debe nada no aparece', async () => {
    expect(await cartera()).toHaveLength(0)
  })
})

describe('los códigos de descuento', () => {
  const datos = {
    codigo: 'verano2026',
    tipo: 'porcentaje' as const,
    valor: '15',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2026-12-31',
  }

  it('se guardan en mayúsculas', async () => {
    expect((await crearCodigo(datos, null)).codigo).toBe('VERANO2026')
  })

  it('un porcentaje mayor que 100 se rechaza diciendo qué está mal', async () => {
    await expect(crearCodigo({ ...datos, valor: '500' }, null)).rejects.toMatchObject({
      code: 'PORCENTAJE_INVALIDO',
    })
  })

  /**
   * ── Quién rechaza una vigencia al revés ───────────────────────────────────
   *
   * El servicio la chequeaba con su propio código de error, y esa línea era
   * **inalcanzable por HTTP**: el esquema de Zod la atrapa antes, con un 400.
   * Una regla con dos códigos es peor que una con uno — el día que alguien vea
   * `VIGENCIA_INVALIDA` en un log va a buscarlo donde no se produce.
   *
   * Se borró del servicio. Lo que sostiene el invariante es el `CHECK` de la
   * base, y por eso este test afirma que la fila NO ENTRA, sin pedirle un
   * código de negocio a algo que ya no lo emite.
   */
  it('una vigencia al revés no entra: lo frena el CHECK de la base', async () => {
    await expect(
      crearCodigo({ ...datos, vigenciaDesde: '2026-12-31', vigenciaHasta: '2026-01-01' }, null),
    ).rejects.toThrow()

    expect(await listarCodigos()).toHaveLength(0)
  })

  it('dos códigos con el mismo nombre, no', async () => {
    await crearCodigo(datos, null)

    await expect(crearCodigo(datos, null)).rejects.toMatchObject({ code: 'CODIGO_DUPLICADO' })
  })

  /**
   * Se desactiva, no se borra: una venta pasada lo referencia y `DELETE` está
   * revocado. Sigue explicando por qué aquella venta costó lo que costó.
   */
  it('se desactiva y deja de listarse entre los vigentes', async () => {
    const codigo = await crearCodigo(datos, null)

    expect(await listarCodigos(true, HOY)).toHaveLength(1)

    await desactivarCodigo(codigo.id)

    expect(await listarCodigos(true, HOY)).toHaveLength(0)
    expect(await listarCodigos()).toHaveLength(1)
  })

  it('un código fuera de vigencia no aparece entre los vigentes', async () => {
    await crearCodigo({ ...datos, vigenciaDesde: '2025-01-01', vigenciaHasta: '2025-12-31' }, null)

    expect(await listarCodigos(true, HOY)).toHaveLength(0)
  })
})
