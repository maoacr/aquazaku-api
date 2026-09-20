import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import {
  bases,
  clientes,
  direcciones,
  lineasDeVenta,
  lotes,
  movimientosBotellon,
  productos,
  ventas,
} from '@/db/schema'
import type { UserContext } from '@/modules/authz/can'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { anularVenta } from '@/modules/ventas/anulacion'
import { corregirVenta } from '@/modules/ventas/correccion'
import { registrarDevolucion } from '@/modules/ventas/devoluciones'
import { deudaDe } from '@/modules/ventas/saldo'
import { registrarVenta } from '@/modules/ventas/venta'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Corregir una venta registrada — RN-VEN-16.
 *
 * Lo que se prueba no es que aparezca una venta nueva: es que el sistema quede
 * contando UNA sola. Una corrección que deja las dos vivas —o que devuelve el
 * stock dos veces— es peor que no poder corregir, porque el descuadre aparece
 * meses después sin nada que lo explique.
 */

const HOY = '2026-08-26'
const MOTIVO = 'el precio se cargó mal: se cobraron 8.000 y quedaron 10.000'

let productoId: string
let otroProductoId: string
let clienteId: string
let otroClienteId: string

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

  const [otro] = await db
    .insert(productos)
    .values({
      codigo: 'BOLSA_600',
      nombre: 'Paca de bolsas de 600 ml',
      presentacion: 'paca',
      contenidoMl: 600,
      unidades: 25,
      precioResidencial: '7000.00',
      precioComercial: '6500.00',
      precioMinimo: '5000.00',
    })
    .returning()
  otroProductoId = otro!.id

  await crearLoteConEntrada(
    { productoId, fechaEmpaque: HOY, cantidad: 50, tipo: 'produccion', registradoPor: null },
    db,
  )
  await crearLoteConEntrada(
    {
      productoId: otroProductoId,
      fechaEmpaque: HOY,
      cantidad: 40,
      tipo: 'produccion',
      registradoPor: null,
    },
    db,
  )

  const conCredito = {
    verificacionEstado: 'verificado' as const,
    verificadoEn: new Date(),
    verificacionMetodo: 'admin_oficial' as const,
    creditoHabilitado: true,
  }

  const [cliente] = await db
    .insert(clientes)
    .values({ nombreLibre: 'Yeimy', tipoDocumento: 'CC', numeroDocumento: '79123456', ...conCredito })
    .returning()
  clienteId = cliente!.id

  const [otroCliente] = await db
    .insert(clientes)
    .values({ nombreLibre: 'Marleny', tipoDocumento: 'CC', numeroDocumento: '52987654', ...conCredito })
    .returning()
  otroClienteId = otroCliente!.id
})

afterAll(async () => {
  await closeDb()
})

const como = (id: string, roles: UserContext['roles']): UserContext =>
  ({ id, roles }) as UserContext

const saldoDe = async (id: string) =>
  (await db.select().from(lotes).where(eq(lotes.productoId, id)))[0]!.cantidadDisponible

const vender = (registradoPor: string | null, extra = {}) =>
  registrarVenta(
    { medioDePago: 'efectivo', items: [{ productoId, cantidad: 3 }], hoy: HOY, ...extra },
    registradoPor,
  )

const corregir = (ventaId: string, usuario: UserContext, extra = {}) =>
  corregirVenta(
    ventaId,
    {
      medioDePago: 'efectivo',
      items: [{ productoId, cantidad: 3 }],
      hoy: HOY,
      motivo: MOTIVO,
      ...extra,
    },
    usuario,
  )

describe('la corrección reemplaza, no edita', () => {
  it('la venta vieja queda corregida y apunta a la nueva', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    const { venta: nueva, reemplazada } = await corregir(
      venta.id,
      como(admin.usuario.id, ['admin']),
    )

    expect(reemplazada.estado).toBe('corregida')
    expect(reemplazada.corregidaPorId).toBe(nueva.id)
    expect(nueva.corrigeAId).toBe(venta.id)
    expect(nueva.estado).toBe('confirmada')
  })

  /**
   * El testimonio de la venta vieja queda intacto — RN-VEN-02.
   *
   * Es la diferencia entre corregir y editar, y la única forma de verla es
   * mirar la fila vieja DESPUÉS: si su total cambió, esto es una edición con
   * otro nombre.
   */
  it('el total de la venta vieja NO se toca', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)
    expect(venta.total).toBe('30000.00')

    const { reemplazada, venta: nueva } = await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      items: [{ productoId, cantidad: 3, precioManual: '8000' }],
    })

    expect(reemplazada.total).toBe('30000.00')
    expect(nueva.total).toBe('24000.00')
  })

  it('deja quién, cuándo y por qué en la venta reemplazada', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    const { reemplazada } = await corregir(venta.id, como(admin.usuario.id, ['admin']))

    expect(reemplazada.anuladaPor).toBe(admin.usuario.id)
    expect(reemplazada.anuladaEn).toBeInstanceOf(Date)
    expect(reemplazada.motivoAnulacion).toBe(MOTIVO)
  })

  /**
   * ── La fecha del hecho, en la corrección — RN-VEN-16 ─────────────────────
   *
   * Por **default** la corrección hereda el instante exacto de la venta que
   * reemplaza. Cuando el admin manda un `ocurrioEn` válido, la venta nueva
   * queda anclada al mediodía de la planta de ESE día. Cuando manda un día
   * futuro o a más de 90 días, el rechazo del piso de RN-VEN-14 corto-circuita
   * antes del INSERT — y la original sigue `confirmada`.
   */
  it('sin `ocurrioEn` hereda el instante exacto de la vieja', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, { ocurrioEn: '2026-08-20' })

    const { venta: nueva } = await corregir(venta.id, como(admin.usuario.id, ['admin']))

    expect(nueva.createdAt.getTime()).toBe(venta.createdAt.getTime())
  })

  it('con `ocurrioEn` válido usa la fecha validada al mediodía de la planta', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    const { venta: nueva } = await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      ocurrioEn: '2026-08-20',
    })

    /*
     * 2026-08-20 al mediodía de Bogotá es 2026-08-20T17:00:00.000Z — el helper
     * `exigirFechaRegistrable` ancla a `T12:00:00-05:00`, que es la zona de la
     * planta. La hora UTC sale de sumar 5 horas al mediodía local.
     */
    expect(nueva.createdAt.toISOString()).toBe('2026-08-20T17:00:00.000Z')
    expect(venta.createdAt.getTime()).not.toBe(nueva.createdAt.getTime())
  })

  it('con `ocurrioEn` futuro rechaza con VENTA_EN_EL_FUTURO sin tocar la original', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    await expect(
      corregir(venta.id, como(admin.usuario.id, ['admin']), { ocurrioEn: '2099-01-01' }),
    ).rejects.toMatchObject({ code: 'VENTA_EN_EL_FUTURO' })

    /*
     * El rechazo corta antes del INSERT — la venta original sigue `confirmada`
     * y nadie tuvo que tocar nada para verificarlo.
     */
    const [sinTocar] = await db.select().from(ventas).where(eq(ventas.id, venta.id))
    expect(sinTocar?.estado).toBe('confirmada')
  })

  it('con `ocurrioEn` a más de 90 días rechaza con VENTA_DEMASIADO_VIEJA', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    await expect(
      corregir(venta.id, como(admin.usuario.id, ['admin']), { ocurrioEn: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'VENTA_DEMASIADO_VIEJA' })
  })

  /**
   * La fecha pre-cargada del modal llega al servidor explícita — D10.
   *
   * Aunque coincida con la original, no se filtra: el admin vio el campo,
   * confirmó el día, y la auditoría tiene que registrar esa intención. Sin
   * el envío explícito, el reporte perdería la diferencia entre «corrigió
   * con la misma fecha a propósito» y «corrigió y el sistema la heredó».
   */
  it('con `ocurrioEn` igual a la original persiste igual y la auditoría registra el visto bueno', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, { ocurrioEn: '2026-08-20' })

    const { venta: nueva, reemplazada } = await corregir(
      venta.id,
      como(admin.usuario.id, ['admin']),
      { ocurrioEn: '2026-08-20' },
    )

    expect(nueva.createdAt.getTime()).toBe(venta.createdAt.getTime())
    expect(reemplazada.createdAt.getTime()).toBe(nueva.createdAt.getTime())
  })
})

describe('el stock queda contando una sola venta', () => {
  it('corregir la cantidad descuenta la diferencia, no las dos ventas', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)
    expect(await saldoDe(productoId)).toBe(47)

    await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      items: [{ productoId, cantidad: 5 }],
    })

    expect(await saldoDe(productoId)).toBe(45)
  })

  /**
   * El caso que obliga a devolver ANTES de registrar.
   *
   * Si la corrección registrara primero, corregir el cliente de una venta que
   * vació el lote fallaría por stock insuficiente **contra su propio stock**:
   * las unidades que necesita son las que ella misma tiene tomadas.
   */
  it('corregir una venta que vació el lote no se queda sin stock', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, { items: [{ productoId, cantidad: 50 }] })
    expect(await saldoDe(productoId)).toBe(0)

    const { venta: nueva } = await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      clienteId,
      items: [{ productoId, cantidad: 50 }],
    })

    expect(nueva.clienteId).toBe(clienteId)
    expect(await saldoDe(productoId)).toBe(0)
  })

  it('cambiar el producto devuelve uno y descuenta el otro', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      items: [{ productoId: otroProductoId, cantidad: 2 }],
    })

    expect(await saldoDe(productoId)).toBe(50)
    expect(await saldoDe(otroProductoId)).toBe(38)
  })
})

describe('la deuda cuenta una sola vez', () => {
  it('corregir el monto de una venta a crédito reemplaza la deuda', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, { medioDePago: 'credito', clienteId })
    expect(await deudaDe(clienteId)).toBe('30000.00')

    await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      medioDePago: 'credito',
      clienteId,
      items: [{ productoId, cantidad: 2 }],
    })

    expect(await deudaDe(clienteId)).toBe('20000.00')
  })

  /** La venta se cargó a quien no era: la deuda tiene que cambiar de dueño. */
  it('corregir el cliente mueve la deuda entera', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, { medioDePago: 'credito', clienteId })

    await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      medioDePago: 'credito',
      clienteId: otroClienteId,
    })

    expect(await deudaDe(clienteId)).toBe('0.00')
    expect(await deudaDe(otroClienteId)).toBe('30000.00')
  })
})

describe('lo que la corrección no deja hacer', () => {
  it('un pos no corrige, ni siquiera lo propio', async () => {
    const pos = await usuarioAutenticado('pos')
    const { venta } = await vender(pos.usuario.id)

    await expect(corregir(venta.id, como(pos.usuario.id, ['pos']))).rejects.toMatchObject({
      code: 'SIN_PERMISO',
    })
  })

  it('una venta ya anulada no se corrige', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)
    await anularVenta(venta.id, 'el cliente se arrepintió en el mostrador', como(admin.usuario.id, ['admin']))

    await expect(corregir(venta.id, como(admin.usuario.id, ['admin']))).rejects.toMatchObject({
      code: 'YA_ANULADA',
    })
  })

  /** Corregir dos veces se hace sobre la VIGENTE, que es la última. */
  it('una venta ya corregida no se vuelve a corregir', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)
    await corregir(venta.id, como(admin.usuario.id, ['admin']))

    await expect(corregir(venta.id, como(admin.usuario.id, ['admin']))).rejects.toMatchObject({
      code: 'YA_ANULADA',
    })
  })

  it('pero la que la reemplazó sí, y encadena', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)
    const primera = await corregir(venta.id, como(admin.usuario.id, ['admin']))

    const segunda = await corregir(primera.venta.id, como(admin.usuario.id, ['admin']), {
      items: [{ productoId, cantidad: 1 }],
    })

    expect(segunda.venta.corrigeAId).toBe(primera.venta.id)
    expect(segunda.reemplazada.corregidaPorId).toBe(segunda.venta.id)
    expect(await saldoDe(productoId)).toBe(49)
  })

  it('una venta con devoluciones no se corrige', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    const [linea] = await db
      .select()
      .from(lineasDeVenta)
      .where(eq(lineasDeVenta.ventaId, venta.id))

    await registrarDevolucion(
      { lineaId: linea!.id, cantidad: 1, estadoProducto: 'sano', motivo: 'vino con el sello roto' },
      admin.usuario.id,
    )

    await expect(corregir(venta.id, como(admin.usuario.id, ['admin']))).rejects.toMatchObject({
      code: 'VENTA_CON_DEVOLUCIONES',
    })
  })

  /**
   * El botellón salió a nombre de alguien, y la corrección no lo trae de vuelta.
   *
   * Dejar cambiar el cliente acá pondría la venta a nombre de una persona y el
   * envase a cargo de otra: a la hora de reclamarlo, nadie sabe a cuál ir.
   */
  it('tampoco si la venta prestó una base', async () => {
    const admin = await usuarioAutenticado('admin')

    const [direccion] = await db
      .insert(direcciones)
      .values({ clienteId, etiqueta: 'La casa', direccion: 'Calle 5 # 3-24' })
      .returning()

    const [base] = await db.insert(bases).values({ idSticker: '0042' }).returning()
    expect(base).toBeDefined()

    const { venta } = await vender(admin.usuario.id, {
      clienteId,
      base: { sticker: '0042', direccionId: direccion!.id },
    })

    await expect(
      corregir(venta.id, como(admin.usuario.id, ['admin']), { clienteId: otroClienteId }),
    ).rejects.toMatchObject({ code: 'ACTIVOS_A_NOMBRE_DEL_CLIENTE' })
  })

  it('no cambia el cliente si la venta despachó botellones sin vacío', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, {
      clienteId,
      botellonesEntregados: 1,
      botellonesRecibidos: 0,
    })

    await expect(
      corregir(venta.id, como(admin.usuario.id, ['admin']), { clienteId: otroClienteId }),
    ).rejects.toMatchObject({ code: 'ACTIVOS_A_NOMBRE_DEL_CLIENTE' })
  })

  it('pero sí corrige los números de esa misma venta', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id, {
      clienteId,
      botellonesEntregados: 1,
      botellonesRecibidos: 0,
    })

    const { venta: nueva } = await corregir(venta.id, como(admin.usuario.id, ['admin']), {
      clienteId,
      items: [{ productoId, cantidad: 4 }],
    })

    expect(nueva.total).toBe('40000.00')

    /*
     * El movimiento del botellón sigue colgando de la venta ORIGINAL y no se
     * duplicó. El envase salió una vez.
     */
    const movimientos = await db
      .select()
      .from(movimientosBotellon)
      .where(and(eq(movimientosBotellon.documentoId, venta.id), eq(movimientosBotellon.tipo, 'entrega')))

    expect(movimientos).toHaveLength(2)
  })

  it('un motivo corto no alcanza', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    await expect(
      corregir(venta.id, como(admin.usuario.id, ['admin']), { motivo: 'mal' }),
    ).rejects.toMatchObject({ code: 'MOTIVO_REQUERIDO' })
  })

  /**
   * Si la venta nueva no se puede escribir, la vieja tiene que seguir en pie.
   * Media corrección —la vieja anulada y ninguna que la reemplace— es una venta
   * que desapareció.
   */
  it('si la venta nueva falla, la vieja sigue confirmada y el stock no se movió', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    await expect(
      corregir(venta.id, como(admin.usuario.id, ['admin']), {
        items: [{ productoId, cantidad: 500 }],
      }),
    ).rejects.toMatchObject({ code: 'STOCK_INSUFICIENTE' })

    const [sinTocar] = await db.select().from(ventas).where(eq(ventas.id, venta.id))
    expect(sinTocar?.estado).toBe('confirmada')
    expect(sinTocar?.corregidaPorId).toBeNull()
    expect(await saldoDe(productoId)).toBe(47)
  })
})
