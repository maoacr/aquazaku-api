import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { bases, clientes, lineasDeVenta, movimientosBotellon, ventas } from '@/db/schema'
import {
  botellonesDe,
  botellonesEnBodega,
  verificarConservacion,
} from '@/modules/retornables/conservacion'
import { pgErrorOf, resetDb } from '@/test/db'

/**
 * La ley de conservación — RN-ENV-02, y los invariantes de M7 en la base.
 *
 * El dominio pidió este test por su nombre: *«escribilo temprano, corrélo
 * seguido, y hacelo fallar ruidosamente»*. La razón es que sin identificador
 * individual, un botellón perdido **no deja hueco en ninguna tabla** — solo
 * descuadra la suma.
 */

let clienteId: string

beforeEach(async () => {
  await resetDb()

  const [cliente] = await db
    .insert(clientes)
    .values({ nombre: 'Yeimy', tipoDocumento: 'CC', numeroDocumento: '79123456' })
    .returning()
  clienteId = cliente!.id
})

afterAll(async () => {
  await closeDb()
})

/** Compra: entran al parque, a la bodega. */
const comprar = (cantidad: number) =>
  db.insert(movimientosBotellon).values({ cantidad, tipo: 'compra', registradoPor: null })

/** Una entrega son DOS filas: sale de la bodega, entra al cliente. */
const entregar = (cantidad: number) =>
  db.insert(movimientosBotellon).values([
    { cantidad: -cantidad, tipo: 'entrega', registradoPor: null },
    { cantidad, tipo: 'entrega', clienteId, registradoPor: null },
  ])

describe('la ley de conservación', () => {
  it('cierra con el parque vacío', async () => {
    expect((await verificarConservacion()).cuadra).toBe(true)
  })

  it('cierra después de comprar', async () => {
    await comprar(100)

    const c = await verificarConservacion()
    expect(c).toMatchObject({ cuadra: true, registrados: 100, enPoderDeAlguien: 100 })
  })

  /**
   * Una transferencia **no cambia el total**: mueve. Las dos filas suman cero
   * entre sí, y por eso el invariante sigue cerrando.
   */
  it('una entrega mueve pero no cambia el total', async () => {
    await comprar(100)
    await entregar(30)

    const c = await verificarConservacion()

    expect(c.cuadra).toBe(true)
    expect(c.registrados).toBe(100)
    expect(await botellonesEnBodega()).toBe(70)
    expect(await botellonesDe(clienteId)).toBe(30)
  })

  it('un descarte sí baja el total, y sigue cerrando', async () => {
    await comprar(100)
    await db
      .insert(movimientosBotellon)
      .values({ cantidad: -5, tipo: 'descarte', motivo: 'se rompieron en la bodega', registradoPor: null })

    const c = await verificarConservacion()

    expect(c.cuadra).toBe(true)
    expect(c.registrados).toBe(95)
    expect(await botellonesEnBodega()).toBe(95)
  })

  /**
   * ── El caso que da sentido a todo lo demás ────────────────────────────────
   *
   * Una entrega escrita a MEDIAS —solo la fila del cliente, sin la de la
   * bodega— es exactamente cómo se pierde un botellón en un sistema sin ID.
   * No hay fila huérfana, no hay error, no hay nada raro que mirar.
   *
   * Solo la suma deja de cerrar. Si este test no existiera, ese descuadre
   * viviría en la base hasta que alguien contara los botellones a mano.
   */
  it('una transferencia a medias la rompe, y lo dice con el número', async () => {
    await comprar(100)

    // Solo la mitad de la entrega: entra al cliente y no sale de la bodega.
    await db
      .insert(movimientosBotellon)
      .values({ cantidad: 30, tipo: 'entrega', clienteId, registradoPor: null })

    const c = await verificarConservacion()

    expect(c.cuadra).toBe(false)
    expect(c.diferencia).toBe(30)
  })

  it('y al revés: la fila de la bodega sin la del cliente', async () => {
    await comprar(100)
    await db
      .insert(movimientosBotellon)
      .values({ cantidad: -30, tipo: 'entrega', registradoPor: null })

    expect((await verificarConservacion()).diferencia).toBe(-30)
  })
})

describe('lo que la base no deja escribir', () => {
  it('un movimiento de cero no movió nada', async () => {
    await expect(
      db.insert(movimientosBotellon).values({ cantidad: 0, tipo: 'ajuste', registradoPor: null }),
    ).rejects.toThrow()
  })

  /**
   * `compra` siempre suma y `descarte` siempre resta. Un signo invertido acá
   * rompe la conservación sin que ninguna fila se vea rara: una «compra» de −50
   * parece un movimiento cualquiera.
   */
  it('una compra en negativo no entra', async () => {
    await expect(
      db.insert(movimientosBotellon).values({ cantidad: -50, tipo: 'compra', registradoPor: null }),
    ).rejects.toThrow()
  })

  it('un descarte en positivo tampoco', async () => {
    await expect(
      db.insert(movimientosBotellon).values({ cantidad: 5, tipo: 'descarte', registradoPor: null }),
    ).rejects.toThrow()
  })

  it('el libro es append-only: no se edita ni se borra', async () => {
    await comprar(10)

    await expect(
      db.update(movimientosBotellon).set({ cantidad: 999 }).where(eq(movimientosBotellon.tipo, 'compra')),
    ).rejects.toThrow()
    await expect(db.delete(movimientosBotellon)).rejects.toThrow()
  })
})

describe('las bases — el activo que SÍ tiene identidad', () => {
  it('dos bases no comparten sticker', async () => {
    await db.insert(bases).values({ idSticker: '0913' })

    await expect(db.insert(bases).values({ idSticker: '0913' })).rejects.toThrow()
  })

  /** Media evidencia de daño no sirve para cobrarle a nadie. */
  it('marcar dañada sin fecha no entra', async () => {
    const [base] = await db.insert(bases).values({ idSticker: '0001' }).returning()

    await expect(
      db.update(bases).set({ estado: 'danada' }).where(eq(bases.id, base!.id)),
    ).rejects.toThrow()
  })

  it('una base no se borra: se desactiva', async () => {
    const [base] = await db.insert(bases).values({ idSticker: '0002' }).returning()

    await expect(db.delete(bases).where(eq(bases.id, base!.id))).rejects.toThrow()
  })
})

/**
 * ── El invariante que cruza dos tablas ──────────────────────────────────────
 *
 * Una venta de producto tiene líneas; un recargo por daño no —no hay lote del
 * que salga una base rota—. Las dos direcciones se defienden distinto, y la
 * segunda necesita un trigger DIFERIDO porque las líneas llegan después de la
 * venta.
 */
describe('venta de producto contra recargo por daño', () => {
  it('un recargo por daño NO acepta líneas', async () => {
    const [venta] = await db
      .insert(ventas)
      .values({ medioDePago: 'efectivo', total: '50000.00', tipo: 'dano_base' })
      .returning()

    const err = await pgErrorOf(
      db.insert(lineasDeVenta).values({
        ventaId: venta!.id,
        productoId: '00000000-0000-0000-0000-000000000000',
        loteId: '00000000-0000-0000-0000-000000000000',
        cantidad: 1,
        precioListaAplicado: '1.00',
        precioMinimoAplicado: '1.00',
        precioFinal: '1.00',
      }),
    )

    expect(err.message).toMatch(/no lleva lineas|violates foreign key/)
  })

  /**
   * Este es el que necesita el trigger diferido: al insertar la venta todavía
   * no hay líneas —van después— así que el chequeo tiene que correr al COMMIT.
   */
  it('una venta de PRODUCTO sin líneas se rechaza al cerrar la transacción', async () => {
    const err = await pgErrorOf(
      db.transaction(async (tx) => {
        await tx.insert(ventas).values({ medioDePago: 'efectivo', total: '10000.00' })
      }),
    )

    expect(err.message).toMatch(/sin lineas/)
  })

  it('un recargo por daño sin líneas, en cambio, es lo normal', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(ventas)
          .values({ medioDePago: 'efectivo', total: '50000.00', tipo: 'dano_base' })
      }),
    ).resolves.toBeUndefined()
  })
})
