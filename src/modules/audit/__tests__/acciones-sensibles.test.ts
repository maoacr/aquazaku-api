import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, insumos, lineasDeVenta, productos } from '@/db/schema'
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

    const filas = await filasDe('clientes:crear')

    expect(filas).toHaveLength(1)

    /*
     * Acá también decía solo `toHaveLength(1)`. La fila existía con `payload`
     * en NULL y el test pasaba: un alta de cliente registrada sin decir a QUIÉN
     * se dio de alta.
     *
     * El documento va porque es la identidad con la que el cliente entra al
     * sistema, y el índice único lo hace irrepetible: es la forma de encontrar
     * la fila cuando alguien pregunta por un alta concreta.
     */
    expect(filas[0]!.payload).toMatchObject({
      resourceId: res.json().id,
      nombre: 'Ferney',
      documento: '1020304050',
    })
    expect(filas[0]!.resource).toBe('clientes')
  })

  /**
   * Verificar un documento es alguien afirmando que lo tuvo en la mano
   * (RN-CLI-14). La fila tiene que decir CON QUÉ MÉTODO, porque no pesan
   * igual: `admin_oficial` es una ratificación contra el documento oficial y
   * `seller_manual` es un cotejo en la calle.
   */
  it('`clientes:verificar_documento` dice con qué método', async () => {
    const [sinVerificar] = await db
      .insert(clientes)
      .values({ nombreLibre: 'Deyanira', tipoDocumento: 'CC', numeroDocumento: '52987654' })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: `/clientes/${sinVerificar!.id}/verificacion`,
      headers: { cookie: admin.cookie },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('clientes:verificar_documento')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: sinVerificar!.id,
      metodo: 'admin_oficial',
      revertida: false,
    })
  })

  /**
   * Y la REVERSIÓN comparte el nombre de la acción con la verificación, porque
   * comparten el permiso. Si la fila no distingue la dirección, la bitácora no
   * puede decir si alguien respondió por un documento o retiró ese respaldo —
   * que son hechos opuestos.
   *
   * Lo resuelve el payload y no un nombre de acción nuevo: renombrarla tocaría
   * el catálogo de `web/` y cambiaría los filtros de la pantalla de auditoría.
   */
  it('`clientes:verificar_documento` distingue la reversión', async () => {
    /*
     * Un cliente verificado y SIN crédito: `RN-CLI-04` prohíbe desmarcar la
     * verificación de alguien con crédito habilitado, porque el crédito la
     * exige. El cliente del `beforeEach` tiene crédito, así que no sirve acá.
     */
    const [verificado] = await db
      .insert(clientes)
      .values({
        nombreLibre: 'Nubia',
        tipoDocumento: 'CC',
        numeroDocumento: '41234567',
        verificacionEstado: 'verificado',
        verificadoEn: new Date(),
        verificacionMetodo: 'admin_oficial',
      })
      .returning()

    const res = await app.inject({
      method: 'DELETE',
      url: `/clientes/${verificado!.id}/verificacion`,
      headers: { cookie: admin.cookie },
      payload: { motivo: 'la cédula que se cotejó era de la hermana, no de ella' },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('clientes:verificar_documento')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: verificado!.id,
      revertida: true,
      motivo: 'la cédula que se cotejó era de la hermana, no de ella',
    })
  })

  /**
   * Quién extendió crédito y con qué tope es la pregunta de auditoría del
   * módulo. Sin el tope en la fila, una deuda que creció sin control no se
   * puede explicar: no se sabe si alguien subió el límite o nunca hubo uno.
   */
  it('`clientes:habilitar_credito` dice el tope que quedó', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/clientes/${clienteId}/credito`,
      headers: { cookie: admin.cookie },
      payload: { habilitado: true, limite: 500000 },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('clientes:habilitar_credito')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: clienteId,
      habilitado: true,
      limite: '500000.00',
    })
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

    const filas = await filasDe('cobros:registrar')

    expect(filas).toHaveLength(1)

    /*
     * ── El nombre del test prometía más de lo que el cuerpo cumplía ──────────
     *
     * Acá solo decía `toHaveLength(1)`. La fila existía —la escribe el
     * middleware— y el test pasaba con la columna `payload` en NULL, que es
     * justo lo que la pantalla de auditoría necesita para mostrar el detalle.
     *
     * Un cobro no se edita ni se borra. Si la bitácora no dice de cuánto fue,
     * por qué medio y cuánta deuda quedó, no hay con qué reconstruir una
     * cobranza que no cuadra — y el documento que la corregiría tampoco existe.
     */
    expect(filas[0]!.payload).toMatchObject({
      resourceId: res.json().cobro.id,
      monto: '10000.00',
      medioDePago: 'efectivo',
      clienteId,
      deudaRestante: res.json().deudaRestante,
      quedaSaldada: res.json().quedaSaldada,
    })
    expect(filas[0]!.resource).toBe('cobros')
  })
})

/**
 * Una acción deja UNA fila, no dos.
 *
 * ── De dónde salió este bloque ──────────────────────────────────────────────
 *
 * `requirePermission` escribe la fila `ok` por su cuenta salvo que la ruta
 * declare `auditaLaRuta`. Una ruta que emite la suya SIN declararlo deja las
 * dos, y el resultado es peor que no auditar: contar «cuántas anulaciones
 * hubo» con `action='ventas:anular' AND result='ok'` devuelve el doble.
 *
 * `opt-out-de-auditoria.test.ts` vigila el caso contrario —declarar la exención
 * sin cumplirla— y por eso este no lo atrapaba: nadie contaba las filas de un
 * `POST` real.
 */
/**
 * Los botellones son el activo que más sale de la planta.
 *
 * Un botellón entregado y no registrado es un activo perdido con papeles, y la
 * bitácora es lo único que después dice quién lo movió y cuántos. La fila
 * automática del middleware no dice ni la cantidad ni a qué cliente.
 */
describe('la bitácora de botellones dice cuántos y de quién', () => {
  it('`botellones:entregar` dice cuántos y a qué cliente', async () => {
    await app.inject({
      method: 'POST',
      url: '/botellones/compra',
      headers: { cookie: admin.cookie },
      payload: { cantidad: 50, motivo: 'compra inicial del parque' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/botellones/entrega',
      headers: { cookie: admin.cookie },
      payload: { clienteId, cantidad: 3 },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('botellones:entregar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: clienteId,
      cantidad: 3,
      enPoderDelCliente: res.json().enPoderDelCliente,
      enBodega: res.json().enBodega,
    })
    expect(filas[0]!.resource).toBe('botellones')
  })

  it('`botellones:recibir_retorno` dice cuántos volvieron', async () => {
    await app.inject({
      method: 'POST',
      url: '/botellones/compra',
      headers: { cookie: admin.cookie },
      payload: { cantidad: 50, motivo: 'compra inicial del parque' },
    })
    await app.inject({
      method: 'POST',
      url: '/botellones/entrega',
      headers: { cookie: admin.cookie },
      payload: { clienteId, cantidad: 4 },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/botellones/retorno',
      headers: { cookie: admin.cookie },
      payload: { clienteId, cantidad: 2 },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('botellones:recibir_retorno')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: clienteId,
      cantidad: 2,
      enPoderDelCliente: res.json().enPoderDelCliente,
    })
  })

  it('`botellones:descartar` dice cuántos se dieron de baja y por qué', async () => {
    await app.inject({
      method: 'POST',
      url: '/botellones/compra',
      headers: { cookie: admin.cookie },
      payload: { cantidad: 50, motivo: 'compra inicial del parque' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/botellones/descarte',
      headers: { cookie: admin.cookie },
      payload: { cantidad: 2, motivo: 'se rajaron en el lavado' },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('botellones:descartar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      cantidad: 2,
      motivo: 'se rajaron en el lavado',
      enBodega: res.json().enBodega,
    })
  })

  /**
   * Comprar y ajustar comparten el permiso `botellones:registrar`, así que
   * comparten el nombre de la acción — el mismo caso que verificar y revertir
   * en clientes. Son hechos distintos: una compra suma parque, un ajuste
   * corrige un conteo que no cuadraba.
   *
   * Sin `operacion`, la bitácora no puede separarlos y «entraron 50» se lee
   * igual que «faltaban 50».
   */
  it('la compra y el ajuste comparten acción, y el payload los distingue', async () => {
    const compra = await app.inject({
      method: 'POST',
      url: '/botellones/compra',
      headers: { cookie: admin.cookie },
      payload: { cantidad: 50, motivo: 'compra inicial del parque' },
    })

    expect(compra.statusCode).toBe(201)

    const ajuste = await app.inject({
      method: 'POST',
      url: '/botellones/ajuste',
      headers: { cookie: admin.cookie },
      payload: { diferencia: -3, motivo: 'el conteo de bodega daba tres menos' },
    })

    expect(ajuste.statusCode).toBe(201)

    const filas = await filasDe('botellones:registrar')

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => (f.payload as { operacion: string }).operacion).sort()).toEqual([
      'ajuste',
      'compra',
    ])

    const laDelAjuste = filas.find((f) => (f.payload as { operacion: string }).operacion === 'ajuste')

    expect(laDelAjuste!.payload).toMatchObject({
      diferencia: -3,
      motivo: 'el conteo de bodega daba tres menos',
      saldo: ajuste.json().saldo,
    })
  })
})

/**
 * Una base hay que ir a BUSCARLA a un lugar concreto (RN-BAS-03), así que la
 * bitácora de un préstamo tiene que decir a qué dirección fue. Sin eso, una
 * base prestada deja de ser reclamable.
 */
describe('la bitácora de bases dice dónde quedó cada una', () => {
  const darDeAlta = async (sticker: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/bases',
      headers: { cookie: admin.cookie },
      payload: { idSticker: sticker },
    })
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }

  it('`bases:prestar` dice qué base y a qué dirección', async () => {
    const baseId = await darDeAlta('0042')

    const res = await app.inject({
      method: 'POST',
      url: `/bases/${baseId}/prestamo`,
      headers: { cookie: admin.cookie },
      payload: { direccionId },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('bases:prestar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({ resourceId: baseId, direccionId })
    expect(filas[0]!.resource).toBe('bases')
  })

  /**
   * Marcar dañada y descartar comparten el permiso `bases:descartar` —está
   * documentado en la ruta: la matriz no tiene `marcar_dano` y no se inventa
   * una acción desde acá—. Pero son hechos distintos: una base dañada SIGUE
   * EXISTIENDO y una descartada no.
   */
  it('el daño y el descarte comparten acción, y el payload los distingue', async () => {
    const dañada = await darDeAlta('0043')
    const descartada = await darDeAlta('0044')

    await app.inject({
      method: 'POST',
      url: `/bases/${dañada}/prestamo`,
      headers: { cookie: admin.cookie },
      payload: { direccionId },
    })

    const dano = await app.inject({
      method: 'POST',
      url: `/bases/${dañada}/dano`,
      headers: { cookie: admin.cookie },
      payload: {
        motivo: 'llegó con la tapa partida',
        monto: '15000.00',
        medioDePago: 'efectivo',
      },
    })

    expect(dano.statusCode).toBe(201)

    const descarte = await app.inject({
      method: 'POST',
      url: `/bases/${descartada}/descarte`,
      headers: { cookie: admin.cookie },
      payload: { motivo: 'se partió el soporte y no tiene arreglo' },
    })

    expect(descarte.statusCode).toBe(200)

    const filas = await filasDe('bases:descartar')

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => (f.payload as { operacion: string }).operacion).sort()).toEqual([
      'dano',
      'descarte',
    ])
  })

  /**
   * ── Consultar el próximo código NO es registrar una base ──────────────────
   *
   * `GET /bases/proximo-codigo` vive bajo `bases:registrar` a propósito: quien
   * no puede dar de alta no tiene qué hacer con el número siguiente. Pero es
   * una LECTURA, y la política del módulo dice que las lecturas puras no dejan
   * rastro al permitirse.
   *
   * Sin la exención, cada vez que alguien abre el formulario de alta queda una
   * fila `bases:registrar` que se lee como un alta que nunca pasó.
   */
  it('consultar el próximo código no ensucia la bitácora con un alta falsa', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bases/proximo-codigo',
      headers: { cookie: admin.cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(await filasDe('bases:registrar')).toHaveLength(0)
  })
})

describe('la bitácora no duplica la fila de una acción', () => {
  it('`ventas:anular` deja una sola fila, y es la que tiene el detalle', async () => {
    const venta = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie: admin.cookie },
      payload: { medioDePago: 'efectivo', items: [{ productoId, cantidad: 1 }] },
    })

    expect(venta.statusCode).toBe(201)

    const res = await app.inject({
      method: 'POST',
      url: `/ventas/${venta.json().venta.id}/anulacion`,
      headers: { cookie: admin.cookie },
      payload: { motivo: 'se cargó el producto equivocado y el cliente ya se fue' },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('ventas:anular')

    expect(filas).toHaveLength(1)

    /*
     * Y que la que sobrevive sea la RICA. Con dos filas, quedarse con la del
     * middleware dejaría la bitácora sin saber qué se revirtió.
     */
    expect(filas[0]!.payload).toMatchObject({
      resourceId: venta.json().venta.id,
      motivo: 'se cargó el producto equivocado y el cliente ya se fue',
    })
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

/**
 * Lo que entra por la puerta de atrás también se audita.
 *
 * Una compra es dinero que SALE, y la bitácora la registraba sin decir a quién
 * ni por cuánto: `compras:crear` con `payload` en NULL. Tres meses después,
 * «se le compró a alguien algo» no sirve para conciliar nada.
 */
describe('la bitácora de proveedores y compras dice a quién y por cuánto', () => {
  const conProveedor = async (nombre = 'Tapas del Valle') => {
    const res = await app.inject({
      method: 'POST',
      url: '/proveedores',
      headers: { cookie: admin.cookie },
      payload: { nombre, nit: '900123456-1', contacto: 'Don Hernán' },
    })

    expect(res.statusCode).toBe(201)

    return res.json().id as string
  }

  it('`proveedores:crear` dice qué proveedor quedó', async () => {
    const id = await conProveedor('Etiquetas Pereira')
    const filas = await filasDe('proveedores:crear')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: id,
      nombre: 'Etiquetas Pereira',
      nit: '900123456-1',
    })
  })

  /*
   * Activar y desactivar son la MISMA ruta con distinto valor (RN-PRO-01), y la
   * fila tiene que decir en qué estado quedó: reactivar es lo que evita que
   * alguien cree un duplicado con el mismo NIT, y es una decisión que se
   * revisa.
   */
  it('`proveedores:editar` dice en qué estado quedó el proveedor', async () => {
    const id = await conProveedor()

    const apagar = await app.inject({
      method: 'PATCH',
      url: `/proveedores/${id}/estado`,
      headers: { cookie: admin.cookie },
      payload: { activo: false },
    })

    expect(apagar.statusCode).toBe(200)

    const prender = await app.inject({
      method: 'PATCH',
      url: `/proveedores/${id}/estado`,
      headers: { cookie: admin.cookie },
      payload: { activo: true },
    })

    expect(prender.statusCode).toBe(200)

    const filas = await filasDe('proveedores:editar')

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => (f.payload as { activo: boolean }).activo).sort()).toEqual([
      false,
      true,
    ])
    expect(filas[0]!.payload).toMatchObject({ resourceId: id })
  })

  /*
   * Registrar la compra y marcarla pagada comparten `compras:crear` porque
   * comparten permiso. Las separa `operacion`: una suma una deuda, la otra la
   * cierra. Sin eso, «compras:crear» a crédito y su pago se leen como dos
   * compras.
   */
  it('la compra y el pago comparten acción, y el payload los distingue', async () => {
    const proveedorId = await conProveedor()

    const compra = await app.inject({
      method: 'POST',
      url: '/compras',
      headers: { cookie: admin.cookie },
      payload: {
        proveedorId,
        medioDePago: 'credito',
        venceEl: '2027-01-15',
        lineas: [{ botellones: 20, cantidad: 20, costoUnitario: '18000.00' }],
      },
    })

    expect(compra.statusCode).toBe(201)

    const compraId = compra.json().compra.id as string

    const pago = await app.inject({
      method: 'POST',
      url: `/compras/${compraId}/pago`,
      headers: { cookie: admin.cookie },
    })

    expect(pago.statusCode).toBe(200)

    const filas = await filasDe('compras:crear')

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => (f.payload as { operacion: string }).operacion).sort()).toEqual([
      'pago',
      'registrar',
    ])

    const laDeLaCompra = filas.find(
      (f) => (f.payload as { operacion: string }).operacion === 'registrar',
    )

    expect(laDeLaCompra!.payload).toMatchObject({
      resourceId: compraId,
      proveedorId,
      medioDePago: 'credito',
      total: '360000.00',
      venceEl: '2027-01-15',
      lineas: 1,
    })

    const laDelPago = filas.find((f) => (f.payload as { operacion: string }).operacion === 'pago')

    expect(laDelPago!.payload).toMatchObject({ resourceId: compraId, total: '360000.00' })
  })

  /*
   * `GET /compras/vencidas` es una LECTURA, pero vive bajo `compras:crear`
   * porque no existe `compras:ver` en la matriz y no se inventa un permiso
   * desde una ruta (ADR-0003). Sin la exención, cada vez que alguien revisa qué
   * le debe a los proveedores queda una fila que se lee como una compra nueva.
   *
   * Es el segundo caso del sistema, después de `GET /bases/proximo-codigo`.
   */
  it('revisar lo vencido no ensucia la bitácora con una compra falsa', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/compras/vencidas',
      headers: { cookie: admin.cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(await filasDe('compras:crear')).toHaveLength(0)
  })
})

/**
 * El agua es el único inventario que no se puede contar.
 *
 * No hay medidor ni regleta (RN-PRD-11), así que el libro de los tanques es la
 * ÚNICA fuente: si un ajuste no deja rastro de quién lo hizo y por qué, el
 * saldo del tanque deja de ser auditable y pasa a ser una opinión. Las dos
 * rutas emitían con `payload` en NULL.
 */
describe('la bitácora de los tanques dice qué se tocó y por qué', () => {
  /*
   * «Llegó agua y se llenó el tanque» — SIN cantidad. El movimiento entra con
   * cero litros a propósito: el payload dice el tanque y el tipo del
   * movimiento, no una cifra, porque inventar litros acá sería convertir un
   * hueco conocido en un número que parece medido.
   */
  it('`tanques:registrar_reposicion` dice qué tanque, sin inventar litros', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tanques/reposicion',
      headers: { cookie: admin.cookie },
      payload: { tanque: 'crudo' },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('tanques:registrar_reposicion')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: res.json().id,
      tanque: 'crudo',
      tipo: 'ingreso_red',
    })
    expect(filas[0]!.payload).not.toHaveProperty('litros')
  })

  /*
   * Un ajuste es la única escritura que CORRIGE el libro, y el motivo es
   * obligatorio en la ruta. La fila tiene que traer los dos números: el delta
   * con signo y el saldo en que quedó. Sin el saldo, reconstruir el estado del
   * tanque en una fecha obliga a sumar todos los movimientos anteriores.
   */
  it('`tanques:ajustar` dice el delta con signo, el motivo y el saldo que quedó', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tanques/ajuste',
      headers: { cookie: admin.cookie },
      payload: {
        tanque: 'crudo',
        litros: 6500,
        motivo: 'llegó agua de la red y el tanque quedó a medio llenar',
      },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('tanques:ajustar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: 'crudo',
      litros: 6500,
      motivo: 'llegó agua de la red y el tanque quedó a medio llenar',
      saldo: 6500,
      nivelCalculado: 'medio',
    })
  })

  /*
   * Un ajuste NEGATIVO es el caso que más importa: es agua que el libro decía
   * tener y no está. El signo tiene que llegar a la bitácora tal cual, porque
   * «faltaban 2000» y «sobraban 2000» son hechos opuestos.
   */
  it('el ajuste a la baja llega con el signo puesto', async () => {
    const llenar = await app.inject({
      method: 'POST',
      url: '/tanques/ajuste',
      headers: { cookie: admin.cookie },
      payload: { tanque: 'crudo', litros: 6500, motivo: 'saldo inicial del libro' },
    })

    expect(llenar.statusCode).toBe(200)

    const bajar = await app.inject({
      method: 'POST',
      url: '/tanques/ajuste',
      headers: { cookie: admin.cookie },
      payload: { tanque: 'crudo', litros: -2000, motivo: 'el tanque se ve más bajo que el libro' },
    })

    expect(bajar.statusCode).toBe(200)

    const filas = await filasDe('tanques:ajustar')

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => (f.payload as { litros: number }).litros).sort((a, b) => a - b)).toEqual([
      -2000, 6500,
    ])

    const laDeLaBaja = filas.find((f) => (f.payload as { litros: number }).litros === -2000)

    expect(laDeLaBaja!.payload).toMatchObject({ saldo: 4500 })
  })
})

/**
 * Un código de descuento es una autorización para cobrar menos.
 *
 * Y `configuracion:editar` lo usan DOS módulos: los umbrales de alertas, que
 * ya cumplían, y los códigos de descuento, que no. Eso es justo lo que escondió
 * estas dos rutas durante toda la revisión: un grep por acción las daba por
 * hechas, porque `alertas` declara la misma acción.
 *
 * Por eso el payload de descuentos lleva `operacion` con el OBJETO adentro
 * (`descuento_crear`, no `crear`): en la bitácora, las filas de esta acción
 * vienen de dos lugares distintos y tienen que poder separarse de un vistazo.
 */
describe('la bitácora de los códigos de descuento dice qué se autorizó', () => {
  const unCodigo = {
    codigo: 'VERANO10',
    tipo: 'porcentaje' as const,
    valor: '10.00',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2027-12-31',
  }

  const crear = async (payload: Record<string, unknown> = unCodigo) => {
    const res = await app.inject({
      method: 'POST',
      url: '/descuentos',
      headers: { cookie: admin.cookie },
      payload,
    })

    expect(res.statusCode).toBe(201)

    return res.json()
  }

  it('crear un código dice el código, el tipo, el valor y hasta cuándo vale', async () => {
    const creado = await crear({ ...unCodigo, usosMaximos: 50 })
    const filas = await filasDe('configuracion:editar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      operacion: 'descuento_crear',
      resourceId: creado.id,
      codigo: 'VERANO10',
      tipo: 'porcentaje',
      valor: '10.00',
      vigenciaHasta: '2027-12-31',
      usosMaximos: 50,
    })
  })

  /*
   * Desactivar, no borrar: una venta pasada referencia el código y sigue
   * explicando por qué costó lo que costó. La fila tiene que nombrar el
   * código, no solo su id, porque es el id que aparece en la venta vieja.
   */
  it('desactivar un código deja su propia fila, separada por `operacion`', async () => {
    const creado = await crear()

    const res = await app.inject({
      method: 'PATCH',
      url: `/descuentos/${creado.id}/desactivar`,
      headers: { cookie: admin.cookie },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('configuracion:editar')

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => (f.payload as { operacion: string }).operacion).sort()).toEqual([
      'descuento_crear',
      'descuento_desactivar',
    ])

    const laDeLaBaja = filas.find(
      (f) => (f.payload as { operacion: string }).operacion === 'descuento_desactivar',
    )

    expect(laDeLaBaja!.payload).toMatchObject({ resourceId: creado.id, codigo: 'VERANO10' })
  })

  /*
   * El test que protege la trampa.
   *
   * Las dos fuentes de `configuracion:editar` conviven en la misma acción, y la
   * bitácora tiene que poder decir cuál fue cuál: un umbral de alertas movido
   * y un descuento autorizado son hechos de distinta naturaleza bajo el mismo
   * nombre.
   */
  it('un umbral de alertas y un descuento comparten acción, y las filas se distinguen', async () => {
    const umbral = await app.inject({
      method: 'PUT',
      url: '/parametros/dias_entrega_bases',
      headers: { cookie: admin.cookie },
      payload: { valor: 14 },
    })

    expect(umbral.statusCode).toBe(200)

    await crear()

    const filas = await filasDe('configuracion:editar')

    expect(filas).toHaveLength(2)

    const laDelUmbral = filas.find((f) => !(f.payload as { operacion?: string }).operacion)
    const laDelDescuento = filas.find(
      (f) => (f.payload as { operacion?: string }).operacion === 'descuento_crear',
    )

    expect(laDelUmbral!.payload).toMatchObject({ despues: 14, etiqueta: expect.any(String) })
    expect(laDelDescuento!.payload).toMatchObject({ codigo: 'VERANO10' })
  })
})

/**
 * Renombrar un producto y cerrar el día de la planta.
 *
 * Dos acciones de distinta naturaleza y el mismo hueco: la fila llegaba sin
 * `payload`. Van juntas porque son las dos últimas rutas sueltas del catálogo
 * y de producción; los cinco hechos de `insumos:ajustar` van aparte.
 */
describe('la bitácora del catálogo dice de qué a qué cambió el nombre', () => {
  /*
   * El PATCH general solo cambia el nombre —los precios tienen su propia ruta y
   * su propio permiso— así que el antes y el después son lo único que hay para
   * contar, y sin ellos la fila dice «se editó un producto» y nada más.
   *
   * El módulo `productos` escribe la columna `resource_id` además del payload,
   * y esta fila sigue esa convención.
   */
  it('`productos:editar` dice el código y el nombre de antes y de después', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/productos/${productoId}`,
      headers: { cookie: admin.cookie },
      payload: { nombre: 'Recarga de botellón de 20 litros' },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('productos:editar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.resourceId).toBe(productoId)
    expect(filas[0]!.payload).toMatchObject({
      codigo: 'BOT_20L',
      antes: { nombre: 'Recarga de botellón de 20 L' },
      despues: { nombre: 'Recarga de botellón de 20 litros' },
    })
  })
})

/**
 * El cierre del día es el documento que mueve los tres saldos a la vez: agua,
 * botellones y stock de producto terminado (RN-PRD-23). Es la escritura más
 * grande del sistema, y dejaba su fila sin decir de qué día era.
 */
describe('la bitácora dice qué día se cerró la planta', () => {
  /*
   * El cierre pide el catálogo COMPLETO aunque no se envase de todo: el consumo
   * evalúa la equivalencia de los tres productos y rechaza con 422 si falta
   * alguno, porque resolver con cero subestimaría el balance del agua en
   * silencio. Y llenar un botellón consume tapa y sello — RN-PRD-09.
   */
  beforeEach(async () => {
    await db.insert(productos).values([
      {
        codigo: 'P20U_600ML',
        nombre: 'Paca de 20 bolsas de 600 ml',
        presentacion: 'paca',
        contenidoMl: 600,
        unidades: 20,
        precioResidencial: '10000.00',
        precioComercial: '9000.00',
        precioMinimo: '8000.00',
      },
      {
        codigo: 'P50U_300ML',
        nombre: 'Paca de 50 bolsas de 300 ml',
        presentacion: 'paca',
        contenidoMl: 300,
        unidades: 50,
        precioResidencial: '10000.00',
        precioComercial: '9000.00',
        precioMinimo: '8000.00',
      },
    ])

    await db.insert(insumos).values([
      { codigo: 'TAPA_20L', nombre: 'Tapa para botellón de 20 L', minimo: 200, saldo: 500 },
      { codigo: 'SELLO_BOTELLON', nombre: 'Sello termoencogible', minimo: 200, saldo: 500 },
    ])
  })

  it('`produccion:registrar_cierre` dice la fecha, el agua y los lotes que salieron', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/produccion/cierres',
      headers: { cookie: admin.cookie },
      payload: { fecha: '2026-08-26', minutosProcesando: 120, botellonesLlenados: 30 },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('produccion:registrar_cierre')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: res.json().cierre.id,
      fecha: '2026-08-26',
      minutosProcesando: 120,
      litrosProcesados: res.json().cierre.litrosProcesados,
      litrosConsumidos: res.json().cierre.litrosConsumidos,
      botellonesLlenados: 30,
      lotes: res.json().lotes.length,
    })
  })

  /*
   * La FECHA es lo que hace al cierre reclamable, y no es la del request: un
   * cierre se puede registrar al día siguiente. Si la fila no la trae, saber
   * qué día se cerró obliga a ir a buscar el documento.
   */
  it('la fecha de la fila es la del cierre, no la de hoy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/produccion/cierres',
      headers: { cookie: admin.cookie },
      payload: { fecha: '2026-08-20', minutosProcesando: 60, botellonesLlenados: 10 },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('produccion:registrar_cierre')

    expect(filas).toHaveLength(1)
    expect((filas[0]!.payload as { fecha: string }).fecha).toBe('2026-08-20')
    expect((filas[0]!.payload as { fecha: string }).fecha).not.toBe(HOY)
  })
})

/**
 * Cinco hechos distintos bajo una sola acción.
 *
 * `insumos:ajustar` es el permiso de las CINCO rutas de escritura del módulo:
 * dar de alta, editar, recibir una entrada, ajustar el conteo y descartar. Las
 * separa `operacion` en el payload, igual que en botellones y en compras — una
 * acción nueva por cada una obligaría a tocar la matriz y los filtros de la
 * pantalla de auditoría.
 *
 * Y hay un sexto caso que no es ninguno de los cinco: cuando no alcanza. El
 * saldo de un insumo se descuenta con `descontar`, que devuelve
 * `{ ok: false, disponible }` en vez de lanzar —que no alcance es un estado
 * normal de la planta, no un error— así que ese intento NO pasa por el
 * manejador de errores. Sin una fila propia quedaría sin rastro, y «alguien
 * intentó descartar 900 tapas de las 500 que hay» es exactamente lo que una
 * bitácora existe para poder mostrar.
 */
describe('la bitácora de insumos separa los cinco hechos de una misma acción', () => {
  const deniedDe = (accion: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, accion), eq(auditLog.result, 'denied')))

  let insumoId: string

  beforeEach(async () => {
    const [insumo] = await db
      .insert(insumos)
      .values({ codigo: 'TAPA_20L', nombre: 'Tapa para botellón de 20 L', minimo: 200, saldo: 500 })
      .returning()
    insumoId = insumo!.id
  })

  it('el alta dice el código, el nombre y el mínimo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insumos',
      headers: { cookie: admin.cookie },
      payload: { codigo: 'SELLO_BOTELLON', nombre: 'Sello termoencogible', minimo: 200 },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('insumos:ajustar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      operacion: 'alta',
      resourceId: res.json().id,
      codigo: 'SELLO_BOTELLON',
      nombre: 'Sello termoencogible',
      minimo: 200,
    })
  })

  /*
   * La edición es parcial: el esquema deja mandar solo el campo que cambia. La
   * fila trae lo que VINO en el request, porque un payload con los cuatro
   * campos haría ver como que se tocaron todos.
   */
  it('la edición dice qué campos se tocaron, no todos', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/insumos/${insumoId}`,
      headers: { cookie: admin.cookie },
      payload: { minimo: 350 },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('insumos:ajustar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      operacion: 'editar',
      resourceId: insumoId,
      codigo: 'TAPA_20L',
      cambios: { minimo: 350 },
    })
    expect((filas[0]!.payload as { cambios: Record<string, unknown> }).cambios).not.toHaveProperty(
      'nombre',
    )
  })

  it('la entrada dice cuántas unidades llegaron y el saldo que quedó', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/insumos/${insumoId}/entrada`,
      headers: { cookie: admin.cookie },
      payload: { cantidad: 300 },
    })

    expect(res.statusCode).toBe(201)

    const filas = await filasDe('insumos:ajustar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      operacion: 'entrada',
      resourceId: insumoId,
      codigo: 'TAPA_20L',
      cantidad: 300,
      saldo: 800,
    })
  })

  /*
   * El ajuste va CON SIGNO y con motivo obligatorio, igual que el de los
   * tanques: «sobraban 40» y «faltaban 40» son hechos opuestos y el signo es
   * lo único que los distingue.
   */
  it('el ajuste dice la diferencia con signo, el motivo y el saldo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/insumos/${insumoId}/ajuste`,
      headers: { cookie: admin.cookie },
      payload: { diferencia: -40, motivo: 'el conteo de bodega daba cuarenta menos' },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('insumos:ajustar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      operacion: 'ajuste',
      resourceId: insumoId,
      codigo: 'TAPA_20L',
      diferencia: -40,
      motivo: 'el conteo de bodega daba cuarenta menos',
      saldo: 460,
    })
  })

  it('el descarte dice cuántas, por qué causa y el saldo que quedó', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/insumos/${insumoId}/descarte`,
      headers: { cookie: admin.cookie },
      payload: { cantidad: 25, causa: 'falla_produccion' },
    })

    expect(res.statusCode).toBe(200)

    const filas = await filasDe('insumos:ajustar')

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      operacion: 'descarte',
      resourceId: insumoId,
      codigo: 'TAPA_20L',
      cantidad: 25,
      causa: 'falla_produccion',
      saldo: 475,
    })
  })

  /*
   * El sexto caso: no alcanzó. No se movió nada, así que no hay fila `ok` que
   * escribir — pero el intento existió y queda como `denied`, con lo pedido y
   * lo que de verdad había.
   */
  it('un descarte que no alcanza no deja fila `ok`, deja una `denied` con lo disponible', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/insumos/${insumoId}/descarte`,
      headers: { cookie: admin.cookie },
      payload: { cantidad: 900, causa: 'vencido' },
    })

    expect(res.json().ok).toBe(false)
    expect(await filasDe('insumos:ajustar')).toHaveLength(0)

    const rechazos = await deniedDe('insumos:ajustar')

    expect(rechazos).toHaveLength(1)
    expect(rechazos[0]!.payload).toMatchObject({
      operacion: 'descarte',
      resourceId: insumoId,
      codigo: 'TAPA_20L',
      cantidad: 900,
      disponible: 500,
    })
  })
})
