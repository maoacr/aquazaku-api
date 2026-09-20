import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import {
  bases,
  clientes,
  direcciones,
  lotes,
  movimientosBase,
  movimientosBotellon,
  movimientosStock,
  productos,
  ventas,
} from '@/db/schema'
import type { UserContext } from '@/modules/authz/can'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { anularVenta, puedeAnular } from '@/modules/ventas/anulacion'
import { darDeAltaBase } from '@/modules/retornables/bases'
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

    expect(anulada.venta.estado).toBe('anulada')
    expect(anulada.venta.anuladaPor).toBe(autor.usuario.id)
    expect(anulada.venta.motivoAnulacion).toBe(MOTIVO)
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

/**
 * ── Reversión de los movimientos físicos — RN-ENV-09 + decisión D5/D8 ──────
 *
 * La anulación revierte TODO lo que la venta hizo salir o entrar al parque:
 * botellones entregados (→ retorno), botellones recibidos (→ entrega), y base
 * prestada (→ retorno + `UPDATE bases SET direccionId = NULL`). Ventas
 * `tipo='dano_base'` se excluyen porque no tienen movimientos origen.
 */

describe('la anulación revierte los botellones despachados', () => {
  it('entregados=3 → dos filas retorno con ±3 y documentoId=venta.id', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id, {
      clienteId,
      botellonesEntregados: 3,
      botellonesRecibidos: 0,
    })

    await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    /*
     * La entrega original (+3 / −3) sigue intacta en su `documentoId=venta.id`.
     * La reversión inserta OTRO par con tipo='retorno' y mismo documentoId:
     * cliente devuelve los 3 envases que se llevó, bodega los recibe.
     */
    const retornos = await db
      .select()
      .from(movimientosBotellon)
      .where(
        and(eq(movimientosBotellon.documentoId, venta.id), eq(movimientosBotellon.tipo, 'retorno')),
      )

    expect(retornos).toHaveLength(2)
    expect(retornos.map((r) => r.cantidad).sort((a, b) => a - b)).toEqual([-3, 3])
  })
})

describe('la anulación revierte los botellones recibidos', () => {
  it('recibidos=2 → dos filas entrega con ±2 y documentoId=venta.id', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id, {
      clienteId,
      botellonesEntregados: 0,
      botellonesRecibidos: 2,
    })

    await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    /*
     * El cliente había traído 2 vacíos. La anulación emite una `entrega` con
     * signo opuesto: la planta devuelve esos 2 al cliente. La simetría
     * contable es «recibir es dar y dar es recibir».
     */
    const entregas = await db
      .select()
      .from(movimientosBotellon)
      .where(
        and(eq(movimientosBotellon.documentoId, venta.id), eq(movimientosBotellon.tipo, 'entrega')),
      )

    /*
     * Hay 2 entregas reversoras (las nuevas) más las que ya existían si la
     * venta original tenía `botellonesEntregados > 0`. Acá son 0 originales
     * y 2 reversoras: total 2.
     */
    expect(entregas).toHaveLength(2)
    expect(entregas.map((e) => e.cantidad).sort((a, b) => a - b)).toEqual([-2, 2])
  })
})

describe('la anulación revierte ambos campos juntos', () => {
  it('entregados=3 y recibidos=2 → 4 filas nuevas (2 retorno + 2 entrega)', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id, {
      clienteId,
      botellonesEntregados: 3,
      botellonesRecibidos: 2,
    })

    await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    const movimientos = await db
      .select()
      .from(movimientosBotellon)
      .where(eq(movimientosBotellon.documentoId, venta.id))

    /*
     * Originales: 2 entrega (+3/−3) + 2 retorno (−2/+2) = 4 filas.
     * Reversión: 2 retorno (+3/−3) + 2 entrega (+2/−2) = 4 filas.
     * Total: 8 filas con la misma venta.
     */
    expect(movimientos).toHaveLength(8)
    const porTipo = movimientos.reduce<Record<string, number>>((acc, m) => {
      acc[m.tipo] = (acc[m.tipo] ?? 0) + 1
      return acc
    }, {})
    expect(porTipo.entrega).toBe(4)
    expect(porTipo.retorno).toBe(4)
  })
})

describe('la anulación devuelve la base prestada', () => {
  it('prestada → bases.direccionId=NULL + fila movimientos_base tipo retorno', async () => {
    const admin = await usuarioAutenticado('admin')

    /*
     * El cliente necesita tener una dirección para que la base pueda salir a
     * algún lado. La plantamos.
     */
    const [direccion] = await db
      .insert(direcciones)
      .values({ clienteId, etiqueta: 'Casa', viaTipo: 'calle', viaNumero: '1' })
      .returning()

    const base = await darDeAltaBase('0099', admin.usuario.id)

    /*
     * `registrarVenta` con `base` en el body se encarga del préstamo en la
     * misma transacción: la base sale y queda atada a la venta via
     * `documentoId` en `movimientos_base`.
     */
    const { venta } = await registrarVenta(
      {
        medioDePago: 'efectivo',
        clienteId,
        items: [{ productoId, cantidad: 1 }],
        base: { sticker: base.idSticker, direccionId: direccion!.id },
        hoy: HOY,
      },
      admin.usuario.id,
    )

    const [baseAntesDeAnular] = await db.select().from(bases).where(eq(bases.id, base.id))
    expect(baseAntesDeAnular?.direccionId).toBe(direccion!.id)

    await anularVenta(venta.id, MOTIVO, como(admin.usuario.id, ['admin']))

    const [baseTrasAnular] = await db.select().from(bases).where(eq(bases.id, base.id))
    expect(baseTrasAnular?.direccionId).toBeNull()

    const retornos = await db
      .select()
      .from(movimientosBase)
      .where(
        and(eq(movimientosBase.documentoId, venta.id), eq(movimientosBase.tipo, 'retorno')),
      )

    expect(retornos).toHaveLength(1)
    expect(retornos[0]?.baseId).toBe(base.id)
  })
})

describe('la anulación sin botella ni base sigue funcionando', () => {
  it('venta simple (producto sin botellones, sin base) → comportamiento idéntico al previo', async () => {
    const autor = await usuarioAutenticado('pos')
    const { venta } = await vender(autor.usuario.id)

    /*
     * No hay botellones ni base. La anulación sigue devolviendo el stock al
     * lote y dejando la venta en estado `anulada` con su motivo. Los libros
     * de activos no se tocan.
     */
    const anulada = await anularVenta(venta.id, MOTIVO, como(autor.usuario.id, ['pos']))

    expect(anulada.venta.estado).toBe('anulada')
    expect(await saldo()).toBe(50)

    const movimientos = await db
      .select()
      .from(movimientosBotellon)
      .where(eq(movimientosBotellon.documentoId, venta.id))

    expect(movimientos).toHaveLength(0)
  })
})

describe('la anulación de una venta tipo dano_base no toca movimientos', () => {
  it('excluye el bloque activo: ni botellones ni base', async () => {
    /*
     * Un recargo por daño (`tipo='dano_base'`) no genera movimientos de
     * activos. La anulación tiene que respetar eso y NO revertir nada — el
     * handler ignora el bloque entero para no inventar movimientos que
     * nunca existieron.
     *
     * No probamos el camino de la base ni de los botellones por separado
     * porque la guarda está al tope del bloque: si se rompe, fallan los dos.
     */
    const autor = await usuarioAutenticado('admin')

    const [ventaDano] = await db
      .insert(ventas)
      .values({
        tipo: 'dano_base',
        medioDePago: 'efectivo',
        total: '5000.00',
        registradoPor: autor.usuario.id,
        motivoAnulacion: null,
        anuladaEn: null,
        anuladaPor: null,
        botellonesEntregados: 0,
        botellonesRecibidos: 0,
      })
      .returning()

    await anularVenta(ventaDano!.id, MOTIVO, como(autor.usuario.id, ['admin']))

    /*
     * Cero filas en los dos libros: la anulación del recargo solo cambia
     * el estado de la venta. Los movimientos de activos, si los hubo, son
     * de OTRA venta (la original del daño) y no se tocan acá.
     */
    const botellas = await db
      .select()
      .from(movimientosBotellon)
      .where(eq(movimientosBotellon.documentoId, ventaDano!.id))

    expect(botellas).toHaveLength(0)

    const bases = await db
      .select()
      .from(movimientosBase)
      .where(eq(movimientosBase.documentoId, ventaDano!.id))

    expect(bases).toHaveLength(0)
  })
})
