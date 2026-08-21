import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { lotes, movimientosStock, productos } from '@/db/schema'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

/** Producto sobre el que colgar los lotes. */
async function unProducto(): Promise<string> {
  const [creado] = await db
    .insert(productos)
    .values({
      codigo: 'P20U_600ML',
      nombre: 'Paca de 20 bolsas de 600 ml',
      presentacion: 'paca',
      contenidoMl: 600,
      unidades: 20,
      precioResidencial: '12000.00',
      precioComercial: '11000.00',
      precioMinimo: '9000.00',
    })
    .returning({ id: productos.id })
  return creado!.id
}

function unLote(productoId: string, sobrescribe: Partial<typeof lotes.$inferInsert> = {}) {
  return {
    productoId,
    codigo: '2026-08-22-L1',
    fechaEmpaque: '2026-08-22',
    fechaVencimiento: '2026-09-21', // empaque + 30 días
    cantidadInicial: 100,
    cantidadDisponible: 100,
    ...sobrescribe,
  }
}

describe('schema de stock (M2)', () => {
  let productoId: string

  beforeEach(async () => {
    await resetDb()
    productoId = await unProducto()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('el saldo no puede ser negativo — RN-STK-03', () => {
    it('rechaza un lote que nace con saldo negativo', async () => {
      const error = await pgErrorOf(
        db.insert(lotes).values(unLote(productoId, { cantidadDisponible: -1 })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('lotes_saldo_no_negativo')
    })

    it('rechaza un UPDATE directo que lo deje negativo — la promesa real de la regla', async () => {
      await db.insert(lotes).values(unLote(productoId))

      const error = await pgErrorOf(
        db.update(lotes).set({ cantidadDisponible: -5 }).where(eq(lotes.productoId, productoId)),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('lotes_saldo_no_negativo')
    })

    it('acepta llegar exactamente a cero', async () => {
      await db.insert(lotes).values(unLote(productoId))

      await db.update(lotes).set({ cantidadDisponible: 0 }).where(eq(lotes.productoId, productoId))

      const [lote] = await db.select().from(lotes)
      expect(lote?.cantidadDisponible).toBe(0)
    })
  })

  describe('fechas coherentes', () => {
    it('un lote no puede vencer antes de empacarse', async () => {
      const error = await pgErrorOf(
        db.insert(lotes).values(unLote(productoId, { fechaVencimiento: '2026-08-21' })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('lotes_vence_despues_de_empacar')
    })

    it('el vencimiento se guarda tal cual: no lo recalcula la base', async () => {
      // Es la diferencia con `productos.litros`. Si esta columna fuera generada,
      // cambiar la regla de 30 días reescribiría el pasado.
      await db.insert(lotes).values(unLote(productoId, { fechaVencimiento: '2027-01-01' }))

      const [lote] = await db.select().from(lotes)
      expect(lote?.fechaVencimiento).toBe('2027-01-01')
    })
  })

  describe('el libro es append-only — RN-STK-02', () => {
    async function unMovimiento(): Promise<number> {
      const [lote] = await db.insert(lotes).values(unLote(productoId)).returning({ id: lotes.id })
      const [mov] = await db
        .insert(movimientosStock)
        .values({ loteId: lote!.id, cantidad: 100, tipo: 'ajuste', motivo: 'carga inicial' })
        .returning({ id: movimientosStock.id })
      return mov!.id
    }

    it('el rol de la aplicación no puede modificar un movimiento', async () => {
      const id = await unMovimiento()

      const error = await pgErrorOf(
        db.update(movimientosStock).set({ cantidad: 999 }).where(eq(movimientosStock.id, id)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('tampoco puede borrarlo', async () => {
      const id = await unMovimiento()

      const error = await pgErrorOf(
        db.delete(movimientosStock).where(eq(movimientosStock.id, id)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('un lote tampoco se borra: se queda en cero', async () => {
      await db.insert(lotes).values(unLote(productoId))

      const error = await pgErrorOf(db.delete(lotes).where(eq(lotes.productoId, productoId)))

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('pero sí puede mover el saldo del lote: es lo único que cambia', async () => {
      await db.insert(lotes).values(unLote(productoId))

      await db.update(lotes).set({ cantidadDisponible: 80 }).where(eq(lotes.productoId, productoId))

      const [lote] = await db.select().from(lotes)
      expect(lote?.cantidadDisponible).toBe(80)
    })
  })

  describe('un movimiento sin su justificación no existe', () => {
    let loteId: string

    beforeEach(async () => {
      const [lote] = await db.insert(lotes).values(unLote(productoId)).returning({ id: lotes.id })
      loteId = lote!.id
    })

    it('un ajuste sin motivo es un UPDATE disfrazado — RN-STK-02', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosStock).values({ loteId, cantidad: 10, tipo: 'ajuste' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('movimientos_ajuste_con_motivo')
    })

    it('un descarte sin causa no se registra — RN-STK-06', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosStock).values({ loteId, cantidad: -5, tipo: 'descarte' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('movimientos_descarte_con_causa')
    })

    it('una venta NO necesita motivo: el CHECK es condicional a propósito', async () => {
      await db.insert(movimientosStock).values({ loteId, cantidad: -3, tipo: 'venta' })

      const [mov] = await db.select().from(movimientosStock)
      expect(mov?.motivo).toBeNull()
    })

    it('un movimiento en cero no dice nada, así que no existe', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosStock).values({ loteId, cantidad: 0, tipo: 'ajuste', motivo: 'ajuste de prueba del schema' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('movimientos_cantidad_no_cero')
    })
  })

  describe('el código de lote es único', () => {
    it('dos lotes no comparten código', async () => {
      await db.insert(lotes).values(unLote(productoId))

      const error = await pgErrorOf(db.insert(lotes).values(unLote(productoId)))

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
      expect(error.constraint).toBe('lotes_codigo_key')
    })
  })

  describe('el libro sobrevive a quien lo escribió', () => {
    it('borrar el usuario deja el movimiento con responsable nulo, no lo borra', async () => {
      const [lote] = await db.insert(lotes).values(unLote(productoId)).returning({ id: lotes.id })
      await db
        .insert(movimientosStock)
        .values({ loteId: lote!.id, cantidad: 100, tipo: 'ajuste', motivo: 'carga inicial' })

      const [mov] = await db.select().from(movimientosStock)
      expect(mov?.registradoPor).toBeNull()
      expect(mov?.cantidad).toBe(100)
    })
  })
})
