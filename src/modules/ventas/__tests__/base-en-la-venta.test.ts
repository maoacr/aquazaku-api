import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { eq } from 'drizzle-orm'
import { bases, clientes, direcciones, movimientosBase, ventas } from '@/db/schema'
import { productos } from '@/db/schema'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Una base que sale con la venta — RN-BAS-03 y RN-BAS-07.
 *
 * ── Por qué la base viaja en la venta ───────────────────────────────────────
 *
 * Es el mismo argumento de RN-ENV-09 con los botellones: entregar la base era
 * un segundo acto en otra pantalla, y el segundo acto es el que se olvida. Con
 * la base ya en el auto del cliente, nadie vuelve a Retornables a registrarla —
 * y entonces hay un activo de la planta afuera sin ninguna fila que lo reclame.
 *
 * ── Lo que este archivo vigila con más cuidado ──────────────────────────────
 *
 * Que la venta no se haya vuelto una puerta de atrás a la matriz de permisos.
 * El `seller` tiene `ventas:crear` y **no** tiene `bases:prestar`: sin un
 * chequeo propio, prestaría bases mandando un campo más en el cuerpo.
 */

let app: FastifyInstance

async function escenario({ verificado = true } = {}) {
  const [cliente] = await db
    .insert(clientes)
    .values({
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
      tipoDocumento: 'CC',
      numeroDocumento: '1042857391',
      /*
       * Los CUATRO campos de la verificación van juntos: el CHECK
       * `clientes_verificacion_completa` rechaza media verificación —estado sin
       * responsable, o responsable sin fecha—. Poner solo el estado no compila
       * contra la base, y está bien que no compile.
       */
      ...(verificado && {
        verificacionEstado: 'verificado' as const,
        verificadoEn: new Date(),
        verificacionMetodo: 'pos_manual' as const,
      }),
    })
    .returning()

  const [direccion] = await db
    .insert(direcciones)
    .values({ clienteId: cliente!.id, etiqueta: 'La casa', direccion: 'Calle 5 # 3-24' })
    .returning()

  const [base] = await db.insert(bases).values({ idSticker: '0042' }).returning()

  return { cliente: cliente!, direccion: direccion!, base: base! }
}

/** El carrito mínimo: una recarga de botellón. */
let productoId: string
const unItem = () => [{ productoId, cantidad: 1 }]

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
    {
      productoId,
      fechaEmpaque: new Date().toISOString().slice(0, 10),
      cantidad: 50,
      tipo: 'produccion',
      registradoPor: null,
    },
    db,
  )

  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('la base sale con la venta', () => {
  it('se presta a la dirección y queda su movimiento', async () => {
    const { cookie } = await usuarioAutenticado('pos')
    const { direccion, base } = await escenario()

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: {
        medioDePago: 'efectivo',
        items: unItem(),
        base: { sticker: '0042', direccionId: direccion.id },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().basePrestada).toEqual({ idSticker: '0042' })

    const [guardada] = await db.select().from(bases).where(eq(bases.id, base.id))
    expect(guardada!.direccionId).toBe(direccion.id)

    const movimientos = await db
      .select()
      .from(movimientosBase)
      .where(eq(movimientosBase.baseId, base.id))
    expect(movimientos).toHaveLength(1)
    expect(movimientos[0]!.tipo).toBe('prestamo')
  })

  /** En el mostrador nadie conoce el UUID: conoce el número del sticker. */
  it('se identifica por el sticker, y un dedazo lo dice', async () => {
    const { cookie } = await usuarioAutenticado('pos')
    const { direccion } = await escenario()

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: {
        medioDePago: 'efectivo',
        items: unItem(),
        base: { sticker: '9999', direccionId: direccion.id },
      },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().mensaje).toMatch(/9999/)
  })

  it('sin base, la venta sigue siendo la de siempre', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: { medioDePago: 'efectivo', items: unItem() },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().basePrestada).toBeUndefined()
  })
})

/**
 * ── Las dos escrituras son una sola ────────────────────────────────────────
 *
 * Si el préstamo falla, la venta NO se hace. Quien atiende todavía no cobró:
 * corrige el número y vuelve a intentar. Al revés quedaría una venta registrada
 * y una base saliendo por la puerta sin fila que la reclame.
 */
describe('si la base no se puede prestar, no hay venta', () => {
  it('el cliente sin verificar frena todo — RN-BAS-07', async () => {
    const { cookie } = await usuarioAutenticado('pos')
    const { direccion } = await escenario({ verificado: false })

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: {
        medioDePago: 'efectivo',
        items: unItem(),
        base: { sticker: '0042', direccionId: direccion.id },
      },
    })

    expect(res.statusCode).toBe(422)
    expect(await db.select().from(ventas)).toHaveLength(0)
  })

  it('una base que ya figura prestada frena todo', async () => {
    const { cookie } = await usuarioAutenticado('pos')
    const { direccion, base } = await escenario()
    await db.update(bases).set({ direccionId: direccion.id }).where(eq(bases.id, base.id))

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: {
        medioDePago: 'efectivo',
        items: unItem(),
        base: { sticker: '0042', direccionId: direccion.id },
      },
    })

    expect(res.statusCode).toBe(422)
    expect(await db.select().from(ventas)).toHaveLength(0)
  })
})

/**
 * ── La venta no es una puerta de atrás a la matriz ─────────────────────────
 *
 * El `seller` tiene `ventas:crear` y solo `bases:ver`. Si este bloque se pone
 * en verde con un 201, el rol creció sin que nadie lo decidiera — y creció por
 * el peor camino posible: un campo nuevo en un endpoint que ya existía.
 */
describe('quién puede llevar una base en la venta', () => {
  it('el `seller` NO puede, aunque pueda vender', async () => {
    const { cookie } = await usuarioAutenticado('seller')
    const { direccion } = await escenario()

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: {
        medioDePago: 'efectivo',
        items: unItem(),
        base: { sticker: '0042', direccionId: direccion.id },
      },
    })

    expect(res.statusCode).toBe(403)
    expect(await db.select().from(ventas)).toHaveLength(0)
  })

  /** Y el rechazo es de la BASE, no de la venta: sin ella puede vender igual. */
  it('pero sí puede vender sin base', async () => {
    const { cookie } = await usuarioAutenticado('seller')

    const res = await app.inject({
      method: 'POST',
      url: '/ventas',
      headers: { cookie },
      payload: { medioDePago: 'efectivo', items: unItem() },
    })

    expect(res.statusCode).toBe(201)
  })
})
