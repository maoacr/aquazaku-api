import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { productos } from '@/db/schema'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

/** Un producto válido cualquiera, para no repetir el objeto en cada test. */
function unProducto(sobrescribe: Partial<typeof productos.$inferInsert> = {}) {
  return {
    codigo: 'PACA-600',
    nombre: 'Paca de bolsas 600 ml',
    presentacion: 'paca' as const,
    contenidoMl: 600,
    unidades: 20,
    precioResidencial: '12000.00',
    precioComercial: '11000.00',
    precioMinimo: '9000.00',
    ...sobrescribe,
  }
}

describe('schema de productos (M1)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('litros es una columna generada — RN-PRD-01', () => {
    it('calcula los litros de los tres productos reales sin que nadie los escriba', async () => {
      await db.insert(productos).values([
        unProducto({ codigo: 'PACA-600', contenidoMl: 600, unidades: 20 }),
        unProducto({ codigo: 'PACA-300', contenidoMl: 300, unidades: 50 }),
        unProducto({ codigo: 'BOT-20', contenidoMl: 20000, unidades: 1, presentacion: 'botellon' }),
      ])

      const filas = await db.select().from(productos).orderBy(productos.codigo)
      const litrosPorCodigo = Object.fromEntries(filas.map((f) => [f.codigo, Number(f.litros)]))

      expect(litrosPorCodigo).toEqual({ 'PACA-600': 12, 'PACA-300': 15, 'BOT-20': 20 })
    })

    it('recalcula sola cuando cambian sus entradas', async () => {
      await db.insert(productos).values(unProducto())

      // El día que salga una paca de 24 — RN-PRD-01: es un dato, no un deploy.
      await db.update(productos).set({ unidades: 24 }).where(eq(productos.codigo, 'PACA-600'))

      const [fila] = await db.select().from(productos)
      expect(Number(fila?.litros)).toBe(14.4)
    })
  })

  describe('el piso de precio es un CHECK, no una validación de servicio — RN-CAT-04', () => {
    it('rechaza un INSERT cuyo piso supera el precio residencial', async () => {
      const error = await pgErrorOf(
        db.insert(productos).values(unProducto({ precioMinimo: '13000.00' })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('productos_precio_minimo_es_piso')
    })

    it('rechaza un INSERT cuyo piso supera el precio comercial', async () => {
      const error = await pgErrorOf(
        db.insert(productos).values(
          unProducto({ precioResidencial: '12000.00', precioComercial: '8000.00', precioMinimo: '9000.00' }),
        ),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('productos_precio_minimo_es_piso')
    })

    it('rechaza también un UPDATE que rompa el piso — que es la promesa real de la regla', async () => {
      await db.insert(productos).values(unProducto())

      const error = await pgErrorOf(
        db.update(productos).set({ precioResidencial: '5000.00' }).where(eq(productos.codigo, 'PACA-600')),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('productos_precio_minimo_es_piso')
    })

    it('rechaza un precio mínimo negativo', async () => {
      const error = await pgErrorOf(
        db.insert(productos).values(unProducto({ precioMinimo: '-1.00' })),
      )

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('productos_precios_no_negativos')
    })

    it('acepta que el piso sea exactamente igual a un precio de lista', async () => {
      await db.insert(productos).values(
        unProducto({ precioComercial: '9000.00', precioMinimo: '9000.00' }),
      )

      const filas = await db.select().from(productos)
      expect(filas).toHaveLength(1)
    })
  })

  describe('la paca es indivisible y el contenido es real — RN-CAT-10', () => {
    it('rechaza cero unidades', async () => {
      const error = await pgErrorOf(db.insert(productos).values(unProducto({ unidades: 0 })))

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('productos_unidades_positivas')
    })

    it('rechaza contenido cero', async () => {
      const error = await pgErrorOf(db.insert(productos).values(unProducto({ contenidoMl: 0 })))

      expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
      expect(error.constraint).toBe('productos_contenido_positivo')
    })
  })

  describe('el código es único y no se recicla — RN-CAT-11', () => {
    it('rechaza dos productos con el mismo código', async () => {
      await db.insert(productos).values(unProducto())

      const error = await pgErrorOf(
        db.insert(productos).values(unProducto({ nombre: 'Otra cosa' })),
      )

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
      expect(error.constraint).toBe('productos_codigo_key')
    })

    it('el código de un producto desactivado sigue tomado', async () => {
      await db.insert(productos).values(unProducto())
      await db.update(productos).set({ activo: false }).where(eq(productos.codigo, 'PACA-600'))

      const error = await pgErrorOf(db.insert(productos).values(unProducto()))

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    })
  })

  describe('un producto no se borra — RN-CAT-02', () => {
    it('el rol de la aplicación no tiene privilegio de DELETE', async () => {
      await db.insert(productos).values(unProducto())

      const error = await pgErrorOf(db.delete(productos).where(eq(productos.codigo, 'PACA-600')))

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    })

    it('desactivar sí funciona, y la fila sigue existiendo', async () => {
      await db.insert(productos).values(unProducto())

      await db.update(productos).set({ activo: false }).where(eq(productos.codigo, 'PACA-600'))

      const [fila] = await db.select().from(productos)
      expect(fila?.activo).toBe(false)
      expect(fila?.codigo).toBe('PACA-600')
    })
  })

  describe('defaults', () => {
    it('nace activo, con el precio incluyendo impuestos y tarifa en cero — RN-CAT-09', async () => {
      const [creado] = await db.insert(productos).values(unProducto()).returning()

      expect(creado?.activo).toBe(true)
      expect(creado?.precioIncluyeImpuestos).toBe(true)
      expect(Number(creado?.tarifaIvaPorcentaje)).toBe(0)
      expect(creado?.unidades).toBe(20)
    })
  })
})
