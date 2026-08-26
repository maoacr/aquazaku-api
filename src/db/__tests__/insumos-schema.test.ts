import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { insumos, movimientosInsumo } from '@/db/schema'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

/**
 * Los invariantes de M3, verificados contra la base real.
 *
 * Cada `CHECK` se prueba INTENTANDO el `INSERT` inválido y esperando el
 * rechazo. Un test que solo insertara filas válidas diría que el esquema
 * funciona sin decir nada sobre lo que impide.
 *
 * Van en la base y no en el servicio porque un ajuste sin motivo que entre por
 * un script deja el inventario descuadrado sin nadie a quién preguntarle
 * ([ADR-0006](/decisiones/0006-invariantes-en-la-base/)).
 */

function unInsumo(sobrescribe: Partial<typeof insumos.$inferInsert> = {}) {
  return {
    codigo: 'TAPA_20L',
    nombre: 'Tapa para botellón de 20 L',
    minimo: 200,
    saldo: 0,
    ...sobrescribe,
  }
}

async function crearInsumo(
  sobrescribe: Partial<typeof insumos.$inferInsert> = {},
): Promise<string> {
  const [creado] = await db
    .insert(insumos)
    .values(unInsumo(sobrescribe))
    .returning({ id: insumos.id })
  return creado!.id
}

describe('schema de insumos (M3)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('el catálogo', () => {
    it('acepta un insumo bien formado', async () => {
      const id = await crearInsumo()
      const [leido] = await db.select().from(insumos).where(eq(insumos.id, id))

      expect(leido?.codigo).toBe('TAPA_20L')
      expect(leido?.saldo).toBe(0)
      expect(leido?.activo).toBe(true)
      // El saldo se cuenta en unidades SIEMPRE — RN-INS-02.
      expect(leido?.unidad).toBe('unidad')
    })

    it('nace sin equivalencia, y eso no es un descuido', async () => {
      // Cuántas bolsas trae un kilo es una medición de planta que todavía no se
      // hizo (pregunta 37). Mientras siga NULL, el servicio rechaza la entrada
      // por kilos en vez de inventar un número.
      const id = await crearInsumo({ codigo: 'BOLSA_600' })
      const [leido] = await db.select().from(insumos).where(eq(insumos.id, id))

      expect(leido?.equivalenciaPorKilo).toBeNull()
    })

    it('rechaza un código repetido', async () => {
      await crearInsumo()

      const error = await pgErrorOf(db.insert(insumos).values(unInsumo()))

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    })

    it('rechaza un mínimo de cero', async () => {
      // Un mínimo en cero nunca dispara el aviso: es lo mismo que no tenerlo,
      // pero parece configurado.
      const error = await pgErrorOf(db.insert(insumos).values(unInsumo({ minimo: 0 })))

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza un saldo negativo', async () => {
      const error = await pgErrorOf(db.insert(insumos).values(unInsumo({ saldo: -1 })))

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza una equivalencia de cero unidades por kilo', async () => {
      // Convertiría cualquier compra en cero unidades, en silencio.
      const error = await pgErrorOf(
        db.insert(insumos).values(unInsumo({ equivalenciaPorKilo: '0' })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('no se puede borrar: se desactiva', async () => {
      // Borrarlo dejaría movimientos apuntando a un insumo inexistente y el
      // libro sin poder explicar qué se consumió — RN-INS-01.
      const id = await crearInsumo()

      const error = await pgErrorOf(db.delete(insumos).where(eq(insumos.id, id)))

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })
  })

  describe('el libro', () => {
    let insumoId: string

    beforeEach(async () => {
      insumoId = await crearInsumo()
    })

    it('acepta una compra en unidades, sin campos de conversión', async () => {
      await db.insert(movimientosInsumo).values({ insumoId, cantidad: 500, tipo: 'compra' })

      const [leido] = await db.select().from(movimientosInsumo)
      expect(leido?.cantidad).toBe(500)
      expect(leido?.kilos).toBeNull()
    })

    it('acepta una compra en kilos con los dos campos de conversión', async () => {
      await db.insert(movimientosInsumo).values({
        insumoId,
        cantidad: 1200,
        tipo: 'compra',
        kilos: '12.000',
        equivalencia: '100.000',
      })

      const [leido] = await db.select().from(movimientosInsumo)
      expect(leido?.kilos).toBe('12.000')
      expect(leido?.equivalencia).toBe('100.000')
    })

    it('rechaza cantidad cero: un movimiento que no mueve nada no es un movimiento', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosInsumo).values({ insumoId, cantidad: 0, tipo: 'compra' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza un ajuste sin motivo', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosInsumo).values({ insumoId, cantidad: -8, tipo: 'ajuste' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza un descarte sin causa', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosInsumo).values({ insumoId, cantidad: -5, tipo: 'descarte' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('no exige motivo en una compra: el CHECK es condicional', async () => {
      // La contracara del test anterior. Sin la condición, cargar una compra
      // exigiría un motivo que nadie tiene para dar.
      await expect(
        db.insert(movimientosInsumo).values({ insumoId, cantidad: 500, tipo: 'compra' }),
      ).resolves.not.toThrow()
    })

    /**
     * ── El CHECK que más se presta a olvidar ─────────────────────────────────
     *
     * Sin él se puede guardar «entraron 12 kilos» sin decir a cuántas unidades
     * se convirtieron. Ese movimiento NO se puede auditar después: no hay forma
     * de saber si el descuadre vino de la balanza o de la equivalencia.
     */
    it('rechaza kilos sin la equivalencia que se usó', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosInsumo).values({
          insumoId,
          cantidad: 1200,
          tipo: 'compra',
          kilos: '12.000',
        }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza la equivalencia sin los kilos de los que salió', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosInsumo).values({
          insumoId,
          cantidad: 1200,
          tipo: 'compra',
          equivalencia: '100.000',
        }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza una conversión desde cero kilos', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosInsumo).values({
          insumoId,
          cantidad: 1200,
          tipo: 'compra',
          kilos: '0',
          equivalencia: '100.000',
        }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('el libro es append-only: no se edita', async () => {
      await db.insert(movimientosInsumo).values({ insumoId, cantidad: 500, tipo: 'compra' })

      const error = await pgErrorOf(
        db
          .update(movimientosInsumo)
          .set({ cantidad: 999 })
          .where(eq(movimientosInsumo.insumoId, insumoId)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('el libro es append-only: no se borra', async () => {
      await db.insert(movimientosInsumo).values({ insumoId, cantidad: 500, tipo: 'compra' })

      const error = await pgErrorOf(
        db.delete(movimientosInsumo).where(eq(movimientosInsumo.insumoId, insumoId)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('no acepta un movimiento de un insumo que no existe', async () => {
      const error = await pgErrorOf(db.insert(movimientosInsumo).values({
          insumoId: '00000000-0000-0000-0000-000000000000',
          cantidad: 500,
          tipo: 'compra',
        }))

      expect(error.code).toBe(PG_ERROR.FOREIGN_KEY_VIOLATION)
    })
  })

  /**
   * `venta` NO existe como tipo, y es `RN-INS-01` hecha tipo: un insumo no se
   * despacha a un cliente, desaparece cuando se convierte en producto.
   *
   * El enum lo hace imposible en la base, no solo en TypeScript.
   */
  it('un insumo no se puede vender: el enum no tiene `venta`', async () => {
    const insumoId = await crearInsumo()

    await expect(
      db.execute(
        `INSERT INTO movimientos_insumo (insumo_id, cantidad, tipo)
         VALUES ('${insumoId}', -5, 'venta')`,
      ),
    ).rejects.toThrow()
  })
})
