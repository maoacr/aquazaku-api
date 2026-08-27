import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, lotes, movimientosStock, productos, ventas } from '@/db/schema'
import type { UserContext } from '@/modules/authz/can'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { anularVenta, puedeAnular } from '@/modules/ventas/anulacion'
import { deudaDe } from '@/modules/ventas/saldo'
import { registrarVenta } from '@/modules/ventas/venta'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * La anulación — RN-VEN-03 y RN-VEN-08.
 *
 * Lo que se prueba no es que la venta cambie de estado: es que **los efectos se
 * reviertan de verdad**. Una anulación que no devuelve el inventario genera
 * faltantes fantasma que después nadie puede explicar.
 */

const HOY = '2026-08-26'
const MOTIVO = 'el cliente devolvió el botellón sin abrir'

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
    { productoId, fechaEmpaque: HOY, cantidad: 50, tipo: 'produccion', registradoPor: null },
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

/** El contexto que el middleware arma a partir de la sesión. */
const como = (id: string, roles: UserContext['roles']): UserContext =>
  ({ id, roles }) as UserContext

const saldo = async () =>
  (await db.select().from(lotes).where(eq(lotes.productoId, productoId)))[0]!.cantidadDisponible

const vender = (registradoPor: string | null, extra = {}) =>
  registrarVenta(
    { medioDePago: 'efectivo', items: [{ productoId, cantidad: 3 }], hoy: HOY, ...extra },
    registradoPor,
  )

describe('anular revierte los efectos', () => {
  it('el producto vuelve AL MISMO lote', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)
    expect(await saldo()).toBe(47)

    await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    expect(await saldo()).toBe(50)
  })

  it('con un movimiento de devolución que apunta a la venta', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)

    await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    const [devolucion] = await db
      .select()
      .from(movimientosStock)
      .where(eq(movimientosStock.tipo, 'devolucion'))

    expect(devolucion?.cantidad).toBe(3)
    expect(devolucion?.documentoId).toBe(venta.id)
  })

  /**
   * ── La ventaja concreta de que el saldo sea derivado ─────────────────────
   *
   * `deudaDe` suma las ventas a crédito CONFIRMADAS. Cambiar el estado la saca
   * de la cuenta sin tocar ninguna otra tabla — y sin poder quedar
   * desincronizada, porque no hay una segunda copia del número.
   */
  it('la deuda baja sola, sin tocar otra tabla', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id, { medioDePago: 'credito', clienteId })
    expect(await deudaDe(clienteId)).toBe('30000.00')

    await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    expect(await deudaDe(clienteId)).toBe('0.00')
  })

  /**
   * La venta NO desaparece: cambia de estado. Sus líneas quedan intactas como
   * testimonio de que se vendió eso, a ese precio, ese día.
   */
  it('la venta queda, con quién y por qué', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)

    const anulada = await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    expect(anulada.estado).toBe('anulada')
    expect(anulada.anuladaPor).toBe(autor.usuario.id)
    expect(anulada.motivoAnulacion).toBe(MOTIVO)
    expect(await db.select().from(ventas)).toHaveLength(1)
  })
})

/**
 * ── Solo el autor, o el admin — RN-VEN-08 ───────────────────────────────────
 *
 * El chequeo va sobre el `user_id` del autor y NO sobre el rol: los roles se
 * suman (RN-ACC-01), así que preguntar «¿es un pos?» no contesta «¿es quien la
 * hizo?».
 */
describe('quién puede anular', () => {
  it('el autor sí', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)

    await expect(
      anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos'])),
    ).resolves.toBeDefined()
  })

  it('otro `pos` no, aunque tenga el mismo rol', async () => {
    const autor = await usuarioAutenticado('pos')
    const otro = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)

    await expect(
      anularVenta(venta.id, MOTIVO, como(otro.usuario.id, ['pos'])),
    ).rejects.toMatchObject({ code: 'NO_ES_SU_VENTA' })
  })

  it('un `seller` no anula la de un `pos`', async () => {
    const autor = await usuarioAutenticado('pos')
    const vendedor = await usuarioAutenticado('seller')
    const { venta } = await vender(autor.usuario.id)

    await expect(
      anularVenta(venta.id, MOTIVO, como(vendedor.usuario.id, ['seller'])),
    ).rejects.toMatchObject({ code: 'NO_ES_SU_VENTA' })
  })

  it('el `admin` anula cualquiera', async () => {
    const autor = await usuarioAutenticado('pos')
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(autor.usuario.id)

    await expect(
      anularVenta(venta.id, MOTIVO, como(admin.usuario.id, ['admin'])),
    ).resolves.toBeDefined()
  })

  /**
   * Multi-rol: alguien que es `pos` Y `admin` anula la de otro por su rol de
   * admin. Si el chequeo mirara «el primer rol» o «el rol con el que entró»,
   * este caso saldría mal — y los roles se SUMAN.
   */
  it('alguien que es pos y admin a la vez, sí', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)

    expect(puedeAnular(como('otro-id', ['pos', 'admin']), venta)).toBe(true)
    expect(puedeAnular(como('otro-id', ['pos']), venta)).toBe(false)
  })
})

describe('lo que la anulación exige', () => {
  it('un motivo de verdad, también para el admin', async () => {
    const admin = await usuarioAutenticado('admin')
    const { venta } = await vender(admin.usuario.id)

    await expect(
      anularVenta(venta.id, 'x', como(admin.usuario.id, ['admin'])),
    ).rejects.toMatchObject({ code: 'MOTIVO_REQUERIDO' })
  })

  it('anular dos veces se rechaza', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)
    const quien = como(autor.usuario.id, ['pos'] as const)

    await anularVenta(venta.id, MOTIVO, quien)

    await expect(anularVenta(venta.id, MOTIVO, quien)).rejects.toMatchObject({
      code: 'YA_ANULADA',
    })
  })

  it('una venta que no existe', async () => {
    const admin = await usuarioAutenticado('admin')

    await expect(
      anularVenta('00000000-0000-0000-0000-000000000000', MOTIVO, como(admin.usuario.id, ['admin'])),
    ).rejects.toMatchObject({ code: 'VENTA_NO_ENCONTRADA' })
  })
})
