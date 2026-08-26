import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { cierresProduccion, movimientosAgua } from '@/db/schema'
import { PG_ERROR, ownerSql, pgErrorOf, resetDb } from '@/test/db'

/**
 * Los invariantes de M4, verificados contra la base real.
 *
 * Cada `CHECK` se prueba INTENTANDO el `INSERT` inválido y esperando el
 * rechazo. Un test que solo insertara filas válidas diría que el esquema
 * funciona sin decir nada sobre lo que impide.
 */

function unCierre(sobrescribe: Partial<typeof cierresProduccion.$inferInsert> = {}) {
  return {
    fecha: '2026-08-26',
    minutosProcesando: 120,
    pacas600: 40,
    pacas300: 20,
    botellonesLlenados: 30,
    botellonesLavados: 30,
    litrosConsumidos: 1980,
    ...sobrescribe,
  }
}

async function crearCierre(
  sobrescribe: Partial<typeof cierresProduccion.$inferInsert> = {},
): Promise<string> {
  const [creado] = await db
    .insert(cierresProduccion)
    .values(unCierre(sobrescribe))
    .returning({ id: cierresProduccion.id })
  return creado!.id
}

describe('schema de producción (M4)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('el cierre diario', () => {
    it('acepta un cierre bien formado', async () => {
      const id = await crearCierre()
      const [leido] = await db
        .select()
        .from(cierresProduccion)
        .where(eq(cierresProduccion.id, id))

      expect(leido?.pacas600).toBe(40)
      expect(leido?.litrosConsumidos).toBe(1980)
    })

    /**
     * Un cierre por día — RN-PRD-22.
     *
     * Dos cierres serían dos verdades sobre el mismo día, y no habría forma de
     * decidir cuál manda. El registro es diario, no por tanda.
     */
    it('rechaza un segundo cierre para la misma fecha', async () => {
      await crearCierre()

      const error = await pgErrorOf(db.insert(cierresProduccion).values(unCierre()))

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    })

    it('acepta un cierre de otro día', async () => {
      await crearCierre()

      await expect(
        db.insert(cierresProduccion).values(unCierre({ fecha: '2026-08-27' })),
      ).resolves.not.toThrow()
    })

    it('rechaza cero minutos de procesamiento', async () => {
      // Un cierre sin procesamiento no es un cierre: no hubo producción.
      const error = await pgErrorOf(
        db.insert(cierresProduccion).values(unCierre({ minutosProcesando: 0 })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza un conteo negativo', async () => {
      const error = await pgErrorOf(
        db.insert(cierresProduccion).values(unCierre({ pacas600: -1 })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('acepta un día sin envasar: se procesó y no se envasó nada', async () => {
      // Los conteos en cero son válidos. Cero minutos NO, cero pacas SÍ.
      await expect(
        db.insert(cierresProduccion).values(
          unCierre({
            pacas600: 0,
            pacas300: 0,
            botellonesLlenados: 0,
            botellonesLavados: 0,
            litrosConsumidos: 0,
          }),
        ),
      ).resolves.not.toThrow()
    })
  })

  /**
   * ── El procesamiento va completo o no va ─────────────────────────────────
   *
   * El caudal TODAVÍA NO SE MIDIÓ (preguntas 4 y 5). Mientras no exista, el
   * cierre se guarda sin él y `litros_procesados` queda en NULL: el sistema no
   * estima.
   *
   * Lo que no puede pasar es que quede uno sin el otro. Sin el caudal que se
   * usó, unos litros procesados no se pueden auditar — no hay forma de saber si
   * el número salió de una medición o de un dedo.
   */
  describe('el procesamiento', () => {
    it('acepta un cierre SIN caudal: la medición todavía no existe', async () => {
      const id = await crearCierre()
      const [leido] = await db
        .select()
        .from(cierresProduccion)
        .where(eq(cierresProduccion.id, id))

      expect(leido?.caudalGpm).toBeNull()
      expect(leido?.litrosProcesados).toBeNull()
    })

    it('acepta los dos juntos', async () => {
      await expect(
        db
          .insert(cierresProduccion)
          .values(unCierre({ caudalGpm: '5.000', litrosProcesados: 1589 })),
      ).resolves.not.toThrow()
    })

    it('rechaza litros procesados sin el caudal que se usó', async () => {
      const error = await pgErrorOf(
        db.insert(cierresProduccion).values(unCierre({ litrosProcesados: 1589 })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza el caudal sin los litros que produjo', async () => {
      const error = await pgErrorOf(
        db.insert(cierresProduccion).values(unCierre({ caudalGpm: '5.000' })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza un caudal de cero', async () => {
      const error = await pgErrorOf(
        db.insert(cierresProduccion).values(unCierre({ caudalGpm: '0', litrosProcesados: 0 })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })
  })

  describe('el libro del agua', () => {
    let cierreId: string

    beforeEach(async () => {
      cierreId = await crearCierre()
    })

    it('registra una salida por envasado', async () => {
      await db
        .insert(movimientosAgua)
        .values({ tanque: 'procesado', litros: -1980, tipo: 'envasado', cierreId })

      const [leido] = await db.select().from(movimientosAgua)
      expect(leido?.litros).toBe(-1980)
    })

    /**
     * ── El ingreso de red es el único movimiento en CERO ─────────────────────
     *
     * Y esa excepción ES la regla RN-PRD-11 hecha `CHECK`: llegó agua, no
     * sabemos cuánta. No hay medidor ni regleta.
     *
     * Registrar el hecho sin cantidad es lo que mantiene separado lo medido de
     * lo estimado. El saldo se recalibra después con un `ajuste` que exige
     * motivo, y ahí queda claro que ese número es una estimación.
     */
    it('el ingreso de red va en cero: llegó agua, no sabemos cuánta', async () => {
      await expect(
        db.insert(movimientosAgua).values({ tanque: 'crudo', litros: 0, tipo: 'ingreso_red' }),
      ).resolves.not.toThrow()
    })

    it('un ingreso de red CON cantidad se rechaza', async () => {
      // Es el defecto que este CHECK vino a impedir: alguien poniendo un número
      // a ojo porque el campo estaba ahí.
      const error = await pgErrorOf(
        db.insert(movimientosAgua).values({ tanque: 'crudo', litros: 5000, tipo: 'ingreso_red' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('cualquier otro movimiento en cero se rechaza', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosAgua).values({ tanque: 'procesado', litros: 0, tipo: 'envasado' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('rechaza un ajuste sin motivo', async () => {
      const error = await pgErrorOf(
        db.insert(movimientosAgua).values({ tanque: 'crudo', litros: -500, tipo: 'ajuste' }),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    })

    it('no exige motivo en un envasado: el CHECK es condicional', async () => {
      await expect(
        db
          .insert(movimientosAgua)
          .values({ tanque: 'procesado', litros: -100, tipo: 'envasado', cierreId }),
      ).resolves.not.toThrow()
    })
  })

  /**
   * ── Los dos libros son append-only ───────────────────────────────────────
   *
   * El cierre pesa doble: es el único evento que convierte litros en producto,
   * así que editarlo cambiaría a la vez el agua, el stock y los insumos, sin
   * dejar rastro de qué decía antes — RN-PRD-08.
   */
  describe('nada de esto se edita', () => {
    it('un cierre no se puede modificar', async () => {
      const id = await crearCierre()

      const error = await pgErrorOf(
        db.update(cierresProduccion).set({ pacas600: 999 }).where(eq(cierresProduccion.id, id)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('un cierre no se puede borrar', async () => {
      const id = await crearCierre()

      const error = await pgErrorOf(
        db.delete(cierresProduccion).where(eq(cierresProduccion.id, id)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('un movimiento de agua no se puede modificar', async () => {
      const cierreId = await crearCierre()
      await db
        .insert(movimientosAgua)
        .values({ tanque: 'procesado', litros: -100, tipo: 'envasado', cierreId })

      const error = await pgErrorOf(
        db.update(movimientosAgua).set({ litros: -1 }).where(eq(movimientosAgua.cierreId, cierreId)),
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })
  })

  /**
   * ── El test más raro de M4, y el más valioso ─────────────────────────────
   *
   * Verifica que una columna NO EXISTA.
   *
   * El ingreso de agua de la red no se puede medir: no hay medidor ni regleta
   * (RN-PRD-11). La tentación —y va a volver, porque un formulario con un hueco
   * incomoda— es agregar `litros_ingresados` y dejar que alguien lo llene a ojo.
   *
   * Eso convierte un hueco CONOCIDO en un número que parece medido. El día que
   * el saldo no cuadre, nadie va a saber si el problema fue el consumo, la merma
   * o esa estimación. RN-PRD-15: nunca mostrar precisión que no existe.
   *
   * Un comentario pidiendo que no se agregue se ignora. Un test rojo, no.
   */
  it('NO existe una columna de litros ingresados, y es a propósito', async () => {
    const sqlOwner = ownerSql()
    try {
      const columnas = await sqlOwner<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_name in ('cierres_produccion', 'movimientos_agua')
      `
      const nombres = columnas.map((c) => c.column_name)

      const sospechosas = nombres.filter((n) => /ingres|entrada|recib/i.test(n))

      expect(
        sospechosas,
        'el ingreso de la red NO se mide: se registra el hecho, no la cantidad (RN-PRD-11)',
      ).toEqual([])
    } finally {
      await sqlOwner.end()
    }
  })
})
