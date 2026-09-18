import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, productos, ventas } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let productoId: string
let clienteId: string

const HOY = new Date().toISOString().slice(0, 10)

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

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
      nombreLibre: 'Yeimy',
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
  await app?.close()
  await closeDb()
})

const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

const como = async (rol: Role, pedido: Omit<InjectOptions, 'headers'>) => {
  const usuario = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie: usuario.cookie } })
}

const UNA_VENTA = { medioDePago: 'efectivo', items: [{ productoId: '', cantidad: 2 }] }
const conProducto = (extra: object = {}) => ({
  ...UNA_VENTA,
  items: [{ productoId, cantidad: 2 }],
  ...extra,
})

describe('POST /ventas', () => {
  it('el `pos` vende: es quien está en el mostrador', async () => {
    const res = await como('pos', { method: 'POST', url: '/ventas', payload: conProducto() })

    expect(res.statusCode).toBe(201)
    expect(res.json().venta.total).toBe('20000.00')
  })

  it('el `contador` mira pero no vende', async () => {
    expect((await como('contador', { method: 'GET', url: '/ventas' })).statusCode).toBe(200)

    const res = await como('contador', { method: 'POST', url: '/ventas', payload: conProducto() })
    expect(res.statusCode).toBe(403)
  })

  it('un intento denegado queda auditado', async () => {
    await como('contador', { method: 'POST', url: '/ventas', payload: conProducto() })

    const [ultimo] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('ventas')
  })

  it('vender más de lo que hay responde 422 con el número real', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 999 }] }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('STOCK_INSUFICIENTE')
    expect(res.json().mensaje).toMatch(/quedan 100/)
  })

  it('a crédito sin cliente lo atrapa Zod antes que el servicio', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ medioDePago: 'credito' }),
    })

    // El CHECK de la base también lo impediría; acá falla antes, y está bien.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})

/**
 * ── El contrato incluye lo que NO existe ────────────────────────────────────
 *
 * Una venta confirmada no se edita — RN-VEN-02. Es la regla que más se pide
 * romper por comodidad y la que más caro sale romper.
 */
describe('una venta no se edita', () => {
  it('no existe PATCH', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    expect(
      (await comoAdmin({
        method: 'PATCH',
        url: `/ventas/${venta.venta.id}`,
        payload: { total: '1.00' },
      })).statusCode,
    ).toBe(404)
  })

  it('no existe DELETE', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/ventas/${venta.venta.id}` })).statusCode,
    ).toBe(404)
  })
})

/**
 * ── El alcance sale de la matriz, no de la ruta ─────────────────────────────
 *
 * `pos` y `seller` ven y anulan lo PROPIO; `admin`, todo.
 */
describe('el alcance de ver y anular', () => {
  it('un `pos` solo ve sus ventas', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const res = await como('pos', { method: 'GET', url: '/ventas' })

    expect(res.json()).toHaveLength(0)
  })

  it('el `admin` ve todas', async () => {
    await como('pos', { method: 'POST', url: '/ventas', payload: conProducto() })

    expect((await comoAdmin({ method: 'GET', url: '/ventas' })).json()).toHaveLength(1)
  })

  it('un `pos` no anula la venta de otro', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    const res = await como('pos', {
      method: 'POST',
      url: `/ventas/${venta.venta.id}/anulacion`,
      payload: { motivo: 'me equivoqué de producto al cargar' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('NO_ES_SU_VENTA')
  })

  it('sin motivo no se anula, ni siendo admin', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${venta.venta.id}/anulacion`,
      payload: { motivo: 'x' },
    })

    expect(res.statusCode).toBe(400)
  })
})

/**
 * ── Cada fila de la lista tiene que explicarse sola ─────────────────────────
 *
 * La pantalla de ventas promete «qué salió, a quién y cómo se pagó». De las
 * tres, la fila cruda contesta una: `clienteId` y `registradoPor` son UUIDs, y
 * las líneas viven en otra tabla.
 *
 * Resolverlo desde `web/` costaría una consulta por fila —o traerse la tabla de
 * clientes entera, que es justo lo que el mostrador dejó de hacer—. Así que los
 * nombres viajan resueltos, igual que en el libro de movimientos de stock.
 */
describe('GET /ventas — cada fila se explica sola', () => {
  it('trae el nombre del cliente y el de quien la registró', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.clienteNombre).toBe('Yeimy')
    expect(fila.registradoPorNombre).toBe('Usuario de prueba')
  })

  /*
   * El caso NORMAL del mostrador: alguien compra un botellón y se va. `null` no
   * es un dato que faltó cargar — es la venta sin cliente que la tabla permite
   * a propósito (ver el comentario de `ventas.clienteId`).
   */
  it('una venta sin cliente llega con `clienteNombre` en null', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.clienteId).toBeNull()
    expect(fila.clienteNombre).toBeNull()
  })

  it('trae qué se vendió: el nombre del producto y cuántos', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.lineas).toEqual([{ productoNombre: 'Recarga de botellón de 20 L', cantidad: 2 }])
  })

  /*
   * ── Una línea es un par producto+LOTE, y eso no se muestra ────────────────
   *
   * Pedir 150 cuando el primer lote tiene 100 parte la venta en dos líneas del
   * MISMO producto (FEFO). El lote importa para el stock y para anular; en la
   * lista sería «100 × Recarga» y «50 × Recarga», dos renglones para una sola
   * cosa que se pidió una vez.
   */
  it('dos lotes del mismo producto son UNA línea en la lista', async () => {
    await crearLoteConEntrada(
      { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
      db,
    )

    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 150 }] }),
    })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.lineas).toEqual([{ productoNombre: 'Recarga de botellón de 20 L', cantidad: 150 }])
  })

  /*
   * Un recargo por daño es una venta con `tipo = 'dano_base'` y SIN líneas —hay
   * un trigger que lo impide, migración 0009—. Sin el `tipo` en la respuesta, la
   * pantalla lo dibujaría como una venta a la que se le perdieron los productos.
   */
  it('un recargo por daño llega con su tipo y sin líneas', async () => {
    await db
      .insert(ventas)
      .values({ clienteId, medioDePago: 'efectivo', tipo: 'dano_base', total: '35000.00' })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.tipo).toBe('dano_base')
    expect(fila.lineas).toEqual([])
  })
})

/**
 * ── Las ventas de UN cliente — `?clienteId` ────────────────────────────────
 *
 * La ficha de un cliente muestra sus últimas ventas, y la única forma de
 * armarla sin este filtro sería traerse las cien últimas del negocio y
 * descartar en `web/` las que no son suyas: un cliente que compró la semana
 * pasada quedaría sin una sola venta a la vista porque el corte de cien se lo
 * comió.
 *
 * El filtro es el MISMO parámetro que ya usa `GET /cobros?clienteId`. No es un
 * endpoint nuevo: es la misma lista, recortada.
 */
describe('GET /ventas?clienteId — las ventas de un cliente', () => {
  const otroCliente = async () => {
    const [otro] = await db
      .insert(clientes)
      .values({ nombreLibre: 'Wilmer', tipoDocumento: 'CC', numeroDocumento: '1098765432' })
      .returning()

    return otro!.id
  }

  it('trae solo las de ese cliente', async () => {
    const otroId = await otroCliente()
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId: otroId }) })
    // La de mostrador: sin cliente, y no es de nadie.
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const filas = (await comoAdmin({ method: 'GET', url: `/ventas?clienteId=${clienteId}` })).json()

    expect(filas).toHaveLength(1)
    expect(filas[0].clienteNombre).toBe('Yeimy')
    expect(filas[0].lineas).toEqual([{ productoNombre: 'Recarga de botellón de 20 L', cantidad: 2 }])
  })

  /*
   * El filtro RECORTA, no reemplaza: un `pos` filtrando por cliente sigue
   * viendo lo propio. Si las dos condiciones no se combinaran, este parámetro
   * sería una puerta de atrás a la matriz (RN-ACC-03) — y se abriría desde la
   * barra de direcciones.
   */
  it('el alcance del rol sigue mandando', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })

    const res = await como('pos', { method: 'GET', url: `/ventas?clienteId=${clienteId}` })

    expect(res.json()).toHaveLength(0)
  })

  it('sin el parámetro siguen llegando todas', async () => {
    const otroId = await otroCliente()
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId: otroId }) })

    expect((await comoAdmin({ method: 'GET', url: '/ventas' })).json()).toHaveLength(2)
  })
})

describe('los cobros', () => {
  const venderACredito = () =>
    comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ medioDePago: 'credito', clienteId }),
    })

  it('un cobro parcial deja la deuda restante', async () => {
    await venderACredito()

    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '5000.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().deudaRestante).toBe('15000.00')
    expect(res.json().quedaSaldada).toBe(false)
  })

  it('cobrar de más se rechaza con la deuda real', async () => {
    await venderACredito()

    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '99999.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('COBRO_MAYOR_QUE_LA_DEUDA')
  })

  /** `credito` no es un medio de PAGO: pagar deuda con deuda no la reduce. */
  it('no se cobra a crédito', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '5000.00', medioDePago: 'credito' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('la deuda del cliente es consultable', async () => {
    await venderACredito()

    const res = await comoAdmin({ method: 'GET', url: `/clientes/${clienteId}/deuda` })

    expect(res.json().deuda).toBe('20000.00')
  })
})

describe('los códigos de descuento son del admin — RN-VEN-13', () => {
  const UN_CODIGO = {
    codigo: 'VERANO2026',
    tipo: 'porcentaje',
    valor: '10',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2026-12-31',
  }

  it('el `pos` no los crea', async () => {
    expect(
      (await como('pos', { method: 'POST', url: '/descuentos', payload: UN_CODIGO })).statusCode,
    ).toBe(403)
  })

  it('el admin sí, y se aplica en la venta', async () => {
    expect(
      (await comoAdmin({ method: 'POST', url: '/descuentos', payload: UN_CODIGO })).statusCode,
    ).toBe(201)

    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ codigoDescuento: 'VERANO2026' }),
    })

    expect(res.json().venta.total).toBe('18000.00')
  })

  it('se desactivan, no se borran', async () => {
    const codigo = (await comoAdmin({ method: 'POST', url: '/descuentos', payload: UN_CODIGO })).json()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/descuentos/${codigo.id}` })).statusCode,
    ).toBe(404)

    const res = await comoAdmin({ method: 'PATCH', url: `/descuentos/${codigo.id}/desactivar` })
    expect(res.json().activo).toBe(false)
  })
})

describe('la devolución', () => {
  it('vuelve al stock y queda colgada de la venta', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()
    const detalle = (await comoAdmin({ method: 'GET', url: `/ventas/${venta.venta.id}` })).json()

    const res = await comoAdmin({
      method: 'POST',
      url: '/devoluciones',
      payload: {
        lineaId: detalle.lineas[0].id,
        cantidad: 1,
        estadoProducto: 'sano',
        motivo: 'el cliente pidió de menos de lo que necesitaba',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().volvioAlStock).toBe(true)

    const conDevolucion = (await comoAdmin({ method: 'GET', url: `/ventas/${venta.venta.id}` })).json()
    expect(conDevolucion.devoluciones).toHaveLength(1)
  })
})
