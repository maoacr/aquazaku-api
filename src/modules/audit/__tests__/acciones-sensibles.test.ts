import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, productos } from '@/db/schema'
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
