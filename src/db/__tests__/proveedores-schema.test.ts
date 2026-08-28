import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { compras, lineasDeCompra, proveedores } from '@/db/schema'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

/**
 * Proveedores y compras, del lado de la base — M9.
 *
 * Lo que se prueba acá no es que las columnas existan: es que los estados
 * imposibles del dominio sean imposibles de escribir.
 */

let proveedorId: string

beforeEach(async () => {
  await resetDb()

  const [p] = await db.insert(proveedores).values({ nombre: 'Plásticos del Caribe' }).returning()
  proveedorId = p!.id
})

afterAll(async () => {
  await closeDb()
})

const compraDeContado = () => ({
  proveedorId,
  medioDePago: 'efectivo' as const,
  pagada: true,
  total: '150000.00',
})

describe('el proveedor', () => {
  it('nace activo: no se borra, se desactiva — RN-PRO-01', async () => {
    const [p] = await db.select().from(proveedores).where(eq(proveedores.id, proveedorId))

    expect(p!.activo).toBe(true)
  })

  /*
   * `nit` y `contacto` son opcionales a propósito: un proveedor puede ser el
   * señor que trae las tapas en su camioneta. Exigirle NIT llevaría a inventar
   * uno — el mismo error que RN-CLI-13 evita del otro lado.
   */
  it('no exige NIT ni contacto', async () => {
    await expect(db.insert(proveedores).values({ nombre: 'El de las tapas' })).resolves.toBeDefined()
  })

  it('pero dos proveedores no comparten NIT: sería el mismo cargado dos veces', async () => {
    await db.insert(proveedores).values({ nombre: 'Uno', nit: '900123456' })

    const error = await pgErrorOf(db.insert(proveedores).values({ nombre: 'Otro', nit: '900123456' }))

    expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
  })

  it('un nombre en blanco no identifica a nadie', async () => {
    const error = await pgErrorOf(db.insert(proveedores).values({ nombre: '   ' }))

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('proveedores_nombre_no_vacio')
  })
})

/**
 * ── El crédito está modelado y no se ejerce — RN-PRO-06 y 07 ────────────────
 *
 * Hoy Aquazaku paga todo de contado o por transferencia. La columna existe con
 * `credito` entre sus valores porque agregarla después obligaría a migrar las
 * compras viejas y a decidir qué significan retroactivamente.
 */
describe('la fecha de vencimiento viaja con el crédito, en los dos sentidos', () => {
  it('una compra a crédito SIN vencimiento no se puede reclamar ni avisar', async () => {
    const error = await pgErrorOf(
      db.insert(compras).values({ ...compraDeContado(), medioDePago: 'credito', pagada: false }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('compras_vencimiento_solo_a_credito')
  })

  it('y una de contado CON vencimiento no significa nada', async () => {
    const error = await pgErrorOf(
      db.insert(compras).values({ ...compraDeContado(), venceEl: '2026-09-30' }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('compras_vencimiento_solo_a_credito')
  })

  it('a crédito con su fecha entra', async () => {
    await expect(
      db.insert(compras).values({
        ...compraDeContado(),
        medioDePago: 'credito',
        pagada: false,
        venceEl: '2026-09-30',
      }),
    ).resolves.toBeDefined()
  })

  /*
   * Lo que se pagó de contado nace pagado: no hay nada que cobrar después, y
   * una compra de contado «pendiente» aparecería en el aviso de vencidos sin
   * que nadie deba nada.
   */
  it('lo de contado nace pagado', async () => {
    const error = await pgErrorOf(
      db.insert(compras).values({ ...compraDeContado(), pagada: false }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('compras_contado_nace_pagada')
  })
})

/**
 * ── Una compra recibida no se edita — el mismo criterio que RN-VEN-02 ───────
 *
 * Registró mercadería que entró y plata que salió. Corregirla en caliente
 * reescribiría el costo histórico con el que se calcula el margen, que es
 * justamente el número que RN-PRO-04 protege.
 */
describe('la inmutabilidad de la compra', () => {
  const unaCompra = async () => {
    const [c] = await db.insert(compras).values(compraDeContado()).returning()
    return c!.id
  }

  it('el total no se reescribe', async () => {
    const id = await pgErrorOf(
      db.update(compras).set({ total: '999.00' }).where(eq(compras.id, await unaCompra())),
    )

    expect(id.message).toMatch(/no se edita/)
  })

  it('el proveedor tampoco: cambiaría a quién se le compró', async () => {
    const [otro] = await db.insert(proveedores).values({ nombre: 'Otro' }).returning()

    const error = await pgErrorOf(
      db
        .update(compras)
        .set({ proveedorId: otro!.id })
        .where(eq(compras.id, await unaCompra())),
    )

    expect(error.message).toMatch(/no se edita/)
  })

  /*
   * Las DOS transiciones permitidas. `pagada` es la única razón por la que no
   * está en la lista de columnas congeladas.
   */
  it('marcarla pagada sí se puede: es el ciclo normal del crédito', async () => {
    const [c] = await db
      .insert(compras)
      .values({
        ...compraDeContado(),
        medioDePago: 'credito',
        pagada: false,
        venceEl: '2026-09-30',
      })
      .returning()

    await expect(
      db.update(compras).set({ pagada: true }).where(eq(compras.id, c!.id)),
    ).resolves.toBeDefined()
  })

  it('y anularla con motivo también', async () => {
    await expect(
      db
        .update(compras)
        .set({ estado: 'anulada', motivoAnulacion: 'el proveedor facturó otra cosa' })
        .where(eq(compras.id, await unaCompra())),
    ).resolves.toBeDefined()
  })

  it('pero anular sin motivo no', async () => {
    const error = await pgErrorOf(
      db
        .update(compras)
        .set({ estado: 'anulada' })
        .where(eq(compras.id, await unaCompra())),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('compras_anulacion_con_motivo')
  })

  it('una anulada ya no se toca', async () => {
    const id = await unaCompra()
    await db
      .update(compras)
      .set({ estado: 'anulada', motivoAnulacion: 'el proveedor facturó otra cosa' })
      .where(eq(compras.id, id))

    const error = await pgErrorOf(db.update(compras).set({ pagada: true }).where(eq(compras.id, id)))

    expect(error.message).toMatch(/anulada no se modifica/)
  })
})

describe('la línea dice UNA cosa', () => {
  const conLinea = async (extra: Record<string, unknown>) => {
    const [c] = await db.insert(compras).values(compraDeContado()).returning()
    return pgErrorOf(
      db
        .insert(lineasDeCompra)
        .values({ compraId: c!.id, cantidad: '10.000', costoUnitario: '1500.00', ...extra }),
    )
  }

  /*
   * Una línea que sea insumo y botellón a la vez no se puede convertir en un
   * movimiento de inventario sin adivinar cuál — y adivinar ahí es inventar
   * stock en un lado y perderlo en el otro.
   */
  it('ninguna cosa no es una línea', async () => {
    const error = await conLinea({})

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('lineas_compra_una_sola_cosa')
  })

  it('dos cosas a la vez tampoco', async () => {
    const error = await conLinea({ botellones: 5, bases: 5 })

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('lineas_compra_una_sola_cosa')
  })

  it('una sola entra', async () => {
    const [c] = await db.insert(compras).values(compraDeContado()).returning()

    await expect(
      db
        .insert(lineasDeCompra)
        .values({ compraId: c!.id, botellones: 50, cantidad: '50.000', costoUnitario: '3000.00' }),
    ).resolves.toBeDefined()
  })

  it('el detalle de lo que llegó no se edita: se anula la compra', async () => {
    const [c] = await db.insert(compras).values(compraDeContado()).returning()
    const [l] = await db
      .insert(lineasDeCompra)
      .values({ compraId: c!.id, botellones: 50, cantidad: '50.000', costoUnitario: '3000.00' })
      .returning()

    const error = await pgErrorOf(
      db.update(lineasDeCompra).set({ cantidad: '1.000' }).where(eq(lineasDeCompra.id, l!.id)),
    )

    /*
     * Gana el REVOKE, no el trigger — y eso es lo correcto: Postgres chequea el
     * permiso antes de llegar a ejecutar nada. El trigger queda como segunda
     * línea, para el día que alguien opere con un rol que sí tenga UPDATE.
     */
    expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
  })
})
