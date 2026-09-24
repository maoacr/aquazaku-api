import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, lineasDeVenta, productos } from '@/db/schema'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado, direccionDe } from '@/test/fixtures'

/**
 * La acción que SALE BIEN deja rastro.
 *
 * Parece de más decirlo, y es justo lo que estaba roto: durante veinte rutas
 * —`ventas:crear` incluida— la bitácora solo registraba los intentos
 * RECHAZADOS, porque el único `emit` de esos módulos vivía dentro del manejador
 * de errores. Una venta que fallaba por stock quedaba escrita; una venta de dos
 * millones cobrada y entregada, no.
 *
 * `opt-out-de-auditoria.test.ts` cuida que nadie vuelva a eximirse en silencio.
 * Este cuida lo otro, que es lo que de verdad importa: que la fila llegue a la
 * tabla. Un guardián que lee el fuente puede estar verde con la bitácora rota.
 */

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let productoId: string
let clienteId: string
let direccionId: string

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
  direccionId = await direccionDe(clienteId)
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const filasDe = (accion: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, accion), eq(auditLog.result, 'ok')))

describe('una venta normal deja fila en la bitácora', () => {
  it('`ventas:crear` con resultado ok', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie: admin.cookie },
      payload: { medioDePago: 'efectivo', items: [{ productoId, cantidad: 2 }] },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('ventas:crear')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.userId).toBe(admin.usuario.id)

    /*
     * ── Y la fila DICE QUÉ VENTA FUE ────────────────────────────────────────
     *
     * Esto es lo que la fila del middleware no podía dar: se escribía en el
     * `preHandler`, antes de que la venta existiera, así que salía sin
     * `resourceId` y sin `payload`.
     *
     * Medido en producción: 225 filas de `ventas:crear`, las 225 con las dos
     * columnas en NULL. Servían para decir «alguien con permiso intentó
     * vender» — no cuál venta, ni si llegó a hacerse. Con un total que no
     * cuadra contra una copia impresa, eso no explica nada.
     *
     * Por eso se asertan los CAMPOS y no solo la existencia de la fila: una
     * fila vacía existe igual, y el test pasaría sin que la bitácora sirva.
     */
    expect(filas[0]!.payload).toMatchObject({
      resourceId: res.json().venta.id,
      total: res.json().venta.total,
      medioDePago: 'efectivo',
      lineas: 1,
    })
    expect(filas[0]!.resource).toBe('ventas')
  })

  /*
   * Sin esto, el test de arriba pasaría igual con el middleware escribiendo la
   * fila por la venta EQUIVOCADA. Dos ventas, dos filas: la bitácora cuenta
   * cuántas veces pasó, no si pasó alguna vez.
   */
  it('dos ventas dejan dos filas', async () => {
    const vender = () =>
      app.inject({
        method: 'POST',
        url: '/ventas',
        headers: { cookie: admin.cookie },
        payload: { medioDePago: 'efectivo', items: [{ productoId, cantidad: 1 }] },
      })

    await vender()
    await vender()

    expect(await filasDe('ventas:crear')).toHaveLength(2)
  })
})

describe('el resto de los módulos que estaban mudos', () => {
  it('`clientes:crear`', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clientes',
      headers: { cookie: admin.cookie },
      payload: { nombreLibre: 'Ferney', tipoDocumento: 'CC', numeroDocumento: '1020304050' },
    })

    expect(res.statusCode).toBe(201)
    expect(await filasDe('clientes:crear')).toHaveLength(1)
  })

  it('`cobros:registrar`', async () => {
    await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie: admin.cookie },
      payload: {
        medioDePago: 'credito',
        clienteId,
        // Toda venta con cliente dice dónde se entrega — RN-VEN-18.
        direccionId,
        items: [{ productoId, cantidad: 1 }],
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/cobros',
      headers: { cookie: admin.cookie },
      payload: { clienteId, monto: '10000.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(201)
    expect(await filasDe('cobros:registrar')).toHaveLength(1)
  })
})

/**
 * La exención de auditoría se COMPRUEBA, no se declara y ya.
 *
 * ── Por qué hace falta este bloque ──────────────────────────────────────────
 *
 * `requirePermission(..., { auditaLaRuta: true })` APAGA la fila automática del
 * middleware. Es una promesa: «yo, la ruta, escribo una con más detalle».
 *
 * `opt-out-de-auditoria.test.ts` vigila que esa promesa esté DECLARADA. No
 * vigila que se cumpla — y es justo la mitad que importa, porque una bitácora
 * a la que le falta una acción se ve idéntica a una donde esa acción no pasó.
 *
 * Así se perdieron veinte acciones antes: el único `emit` de esos módulos vivía
 * dentro del manejador de errores, así que la venta RECHAZADA aparecía y la
 * exitosa no. La bitácora mostraba lo contrario de lo que había pasado.
 *
 * Este caso cierra esa mitad para `clientes:editar`. Las otras nueve exenciones
 * siguen declaradas y sin comprobar.
 */
describe('las rutas que se auditan solas, cumplen', () => {
  it('`clientes:desactivar` escribe su fila, con el motivo y los conteos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/clientes/${clienteId}/desactivar`,
      headers: { cookie: admin.cookie },
      payload: { motivo: 'se mudó de ciudad y devolvió todo' },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('clientes:desactivar')
    expect(filas).toHaveLength(1)

    /*
     * Los conteos son lo que hace auditable la operación tres meses después:
     * «volvieron 2 bases y 8 botellones» se lee de la fila, sin cruzar
     * `movimientos_base` con `movimientos_botellon`. Sin ellos la fila existe y
     * no sirve, que es la forma cara de este error.
     */
    expect(filas[0]?.payload).toMatchObject({
      resourceId: clienteId,
      motivo: 'se mudó de ciudad y devolvió todo',
      basesDevueltas: expect.any(Number),
      botellonesDevueltos: expect.any(Number),
    })
  })
})

/**
 * Una devolución NO es una venta, y la bitácora tiene que poder distinguirlas.
 *
 * ── El defecto ──────────────────────────────────────────────────────────────
 *
 * `POST /devoluciones` comparte el permiso `ventas:crear` —devolver es parte de
 * vender, y la matriz lo dice ahí—. Con la fila automática del middleware, eso
 * la dejaba registrada con ESE nombre: dos hechos opuestos bajo la misma
 * etiqueta.
 *
 * Quien audite «cuántas ventas se hicieron» contaba devoluciones adentro. Y
 * quien busque una devolución no la encuentra por su nombre.
 */
describe('una devolución deja su propia fila', () => {
  it('`ventas:devolucion`, con lo que volvió y lo que se acreditó', async () => {
    const venta = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie: admin.cookie },
      payload: { medioDePago: 'efectivo', items: [{ productoId, cantidad: 2 }] },
    })

    /*
     * El id de la línea sale de la BASE: `POST /ventas` devuelve las líneas
     * como resumen —lote, producto, cantidad, precio— y no sus ids, porque a
     * quien cobra no le sirven.
     */
    const [linea] = await db
      .select({ id: lineasDeVenta.id })
      .from(lineasDeVenta)
      .where(eq(lineasDeVenta.ventaId, venta.json().venta.id))

    const lineaId = linea!.id

    const res = await app.inject({
      method: 'POST',
      url: '/devoluciones',
      headers: { cookie: admin.cookie },
      payload: {
        lineaId,
        cantidad: 1,
        estadoProducto: 'sano',
        motivo: 'el cliente se llevó dos y una no le entraba en el carro',
      },
    })

    expect(res.statusCode).toBe(201)

    /* No se llama `ventas:crear`: eso es lo que se vino a arreglar. */
    expect(await filasDe('ventas:devolucion')).toHaveLength(1)

    const fila = (await filasDe('ventas:devolucion'))[0]!

    /*
     * Las dos CONSECUENCIAS, no solo el hecho: cuánto se le bajó de la deuda y
     * si el producto volvió al stock. Un «sano» vuelve, un «dañado» no — y esa
     * diferencia es la que explica un inventario tres meses después.
     */
    expect(fila.payload).toMatchObject({
      lineaId,
      cantidad: 1,
      estadoProducto: 'sano',
      volvioAlStock: true,
    })
  })
})

/**
 * `productos:desactivar` — la última exención que quedaba sin comprobar.
 *
 * Las diez rutas con `auditaLaRuta: true` prometen escribir su propia fila.
 * `opt-out-de-auditoria` vigila que la promesa esté DECLARADA; que se cumpla lo
 * vigila un caso como este, y hasta hoy esta era la única sin uno.
 *
 * Apagar un producto lo saca del catálogo: deja de poder venderse. El `codigo`
 * va en la fila porque es cómo se lo nombra en la planta — un UUID no le dice
 * nada a quien tres meses después pregunta por qué no aparece el botellón de 20.
 */
describe('desactivar un producto deja fila con su código', () => {
  it('`productos:desactivar`', async () => {
    /*
     * Un producto PROPIO, sin lote ni stock: el del archivo tiene cien unidades
     * y apagarlo devuelve 409 —no se saca del catálogo algo que está en bodega—.
     * Ese rechazo es correcto y no es lo que este caso mira.
     */
    const [suelto] = await db
      .insert(productos)
      .values({
        codigo: 'PARA_APAGAR',
        nombre: 'Producto para apagar',
        presentacion: 'botellon',
        contenidoMl: 20000,
        unidades: 1,
        precioResidencial: '10000.00',
        precioComercial: '9000.00',
        precioMinimo: '8000.00',
      })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: `/productos/${suelto!.id}/desactivar`,
      headers: { cookie: admin.cookie },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('productos:desactivar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({ codigo: res.json().codigo })
  })
})
