import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { auditLog, lotes, movimientosStock, productos } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { DIAS_DE_VENCIMIENTO, codigoDeLote, vencimientoDe } from '@/modules/stock/codigo-lote'
import { ajustarLote, descartar, registrarEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'

const CONTEXTO = { userId: null, rolEjercido: ['admin'], requestId: 'req-de-prueba' }
const EMPAQUE = '2026-08-22'

let productoId: string

async function errorDeNegocioDe(operacion: Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await operacion
  } catch (err) {
    if (err instanceof ErrorDeNegocio) return err
    throw err
  }
  throw new Error('Se esperaba un ErrorDeNegocio, pero la operación terminó bien')
}

beforeEach(async () => {
  await resetDb()
  const [p] = await db
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
  productoId = p!.id
})

afterAll(async () => {
  await closeDb()
})

describe('vencimiento — RN-STK-08', () => {
  it('son 30 días desde el empaque', () => {
    expect(vencimientoDe('2026-08-22')).toBe('2026-09-21')
    expect(DIAS_DE_VENCIMIENTO).toBe(30)
  })

  it('cruza el fin de mes y el fin de año sin desviarse', () => {
    expect(vencimientoDe('2026-12-20')).toBe('2027-01-19')
    expect(vencimientoDe('2026-01-31')).toBe('2026-03-02')
  })

  it('opera en UTC: no se corre un día según el huso horario', () => {
    // Con parseo en hora local, un huso al oeste devolvería el día anterior.
    expect(vencimientoDe('2026-03-01')).toBe('2026-03-31')
  })

  it('una fecha inválida falla en vez de producir una basura', () => {
    expect(() => vencimientoDe('no-es-fecha')).toThrow(/inválida/)
  })
})

describe('código de lote — RN-STK-08', () => {
  it('el primero del día es L1', () => {
    expect(codigoDeLote('2026-08-22', [])).toBe('2026-08-22-L1')
  })

  it('sigue la secuencia dentro del mismo día', () => {
    expect(codigoDeLote('2026-08-22', ['2026-08-22-L1', '2026-08-22-L2'])).toBe('2026-08-22-L3')
  })

  it('no recicla el código de un lote agotado', () => {
    // El código viaja en las ventas: reusarlo haría que un comprobante viejo
    // apunte a producto que no es el suyo.
    expect(codigoDeLote('2026-08-22', ['2026-08-22-L1'])).toBe('2026-08-22-L2')
  })
})

describe('entrada de inventario', () => {
  it('crea el lote con su código, su vencimiento y su saldo', async () => {
    const lote = await registrarEntrada(
      { productoId, cantidad: 100, fechaEmpaque: EMPAQUE, motivo: 'carga inicial' },
      CONTEXTO,
    )

    expect(lote.codigo).toBe('2026-08-22-L1')
    expect(lote.fechaVencimiento).toBe('2026-09-21')
    expect(lote.cantidadDisponible).toBe(100)
  })

  it('el saldo llega por movimiento, no por un salto inicial sin documento', async () => {
    const lote = await registrarEntrada(
      { productoId, cantidad: 100, fechaEmpaque: EMPAQUE, motivo: 'carga inicial' },
      CONTEXTO,
    )

    const movimientos = await db
      .select()
      .from(movimientosStock)
      .where(eq(movimientosStock.loteId, lote.id))

    expect(movimientos).toHaveLength(1)
    expect(movimientos[0]?.cantidad).toBe(100)
    expect(movimientos[0]?.tipo).toBe('ajuste')
  })

  it('dos entradas el mismo día generan L1 y L2', async () => {
    await registrarEntrada({ productoId, cantidad: 50, fechaEmpaque: EMPAQUE, motivo: 'carga inicial de inventario' }, CONTEXTO)
    const segundo = await registrarEntrada(
      { productoId, cantidad: 50, fechaEmpaque: EMPAQUE, motivo: 'carga inicial de inventario' },
      CONTEXTO,
    )

    expect(segundo.codigo).toBe('2026-08-22-L2')
  })

  it.each([
    ['vacío', '   '],
    ['de relleno', 'x'],
    ['de nueve caracteres', 'no cuadró'],
  ])('un motivo %s no alcanza: RN-STK-02', async (_caso, motivo) => {
    const error = await errorDeNegocioDe(
      registrarEntrada({ productoId, cantidad: 10, fechaEmpaque: EMPAQUE, motivo }, CONTEXTO),
    )

    expect(error.code).toBe('MOTIVO_REQUERIDO')
    expect(error.status).toBe(422)
  })

  it('diez caracteres alcanzan: el mínimo es el mínimo, no una sugerencia', async () => {
    const lote = await registrarEntrada(
      { productoId, cantidad: 10, fechaEmpaque: EMPAQUE, motivo: 'sobrantes' + 'X' },
      CONTEXTO,
    )

    expect(lote.cantidadDisponible).toBe(10)
  })

  it('un producto inexistente da 404, no un lote huérfano', async () => {
    const error = await errorDeNegocioDe(
      registrarEntrada(
        {
          productoId: '00000000-0000-0000-0000-000000000000',
          cantidad: 10,
          fechaEmpaque: EMPAQUE,
          motivo: 'carga inicial de inventario',
        },
        CONTEXTO,
      ),
    )

    expect(error.code).toBe('PRODUCTO_NO_ENCONTRADO')
    expect(await db.select().from(lotes)).toHaveLength(0)
  })
})

describe('ajuste de un lote', () => {
  let loteId: string

  beforeEach(async () => {
    const lote = await registrarEntrada(
      { productoId, cantidad: 100, fechaEmpaque: EMPAQUE, motivo: 'carga inicial' },
      CONTEXTO,
    )
    loteId = lote.id
  })

  it('un ajuste negativo se registra como ajuste, NUNCA como venta', async () => {
    await ajustarLote({ loteId, cantidad: -8, motivo: 'conteo físico dio menos' }, CONTEXTO)

    const [ultimo] = await db
      .select()
      .from(movimientosStock)
      .orderBy(desc(movimientosStock.id))

    // Registrarlo como venta inflaría el reporte de ventas con unidades que
    // nadie compró.
    expect(ultimo?.tipo).toBe('ajuste')
    expect(ultimo?.cantidad).toBe(-8)
  })

  it('un ajuste positivo suma', async () => {
    const { saldo } = await ajustarLote({ loteId, cantidad: 5, motivo: 'aparecieron' }, CONTEXTO)

    expect(saldo).toBe(105)
  })

  it('no se puede ajustar por debajo de cero', async () => {
    const error = await errorDeNegocioDe(
      ajustarLote({ loteId, cantidad: -500, motivo: 'intento de descontar mas de lo que hay' }, CONTEXTO),
    )

    expect(error.code).toBe('STOCK_INSUFICIENTE')
    expect(error.message).toContain('100')
  })

  it('un ajuste de cero no corrige nada', async () => {
    const error = await errorDeNegocioDe(ajustarLote({ loteId, cantidad: 0, motivo: 'carga inicial de inventario' }, CONTEXTO))

    expect(error.code).toBe('CANTIDAD_INVALIDA')
  })

  it('sin motivo no se ajusta', async () => {
    const error = await errorDeNegocioDe(ajustarLote({ loteId, cantidad: -1, motivo: '' }, CONTEXTO))

    expect(error.code).toBe('MOTIVO_REQUERIDO')
  })
})

describe('descarte — RN-STK-06', () => {
  let loteId: string

  beforeEach(async () => {
    const lote = await registrarEntrada(
      { productoId, cantidad: 100, fechaEmpaque: EMPAQUE, motivo: 'carga inicial' },
      CONTEXTO,
    )
    loteId = lote.id
  })

  it('es selectivo: descartar unidades no destruye el lote', async () => {
    const { saldo } = await descartar({ loteId, cantidad: 3, causa: 'falla_produccion' }, CONTEXTO)

    expect(saldo).toBe(97)
  })

  it('guarda la causa, que es la que tiene consecuencias', async () => {
    await descartar(
      { loteId, cantidad: 2, causa: 'mal_manejo_cliente', observaciones: 'bolsa rota' },
      CONTEXTO,
    )

    const [ultimo] = await db.select().from(movimientosStock).orderBy(desc(movimientosStock.id))
    expect(ultimo?.causa).toBe('mal_manejo_cliente')
    expect(ultimo?.tipo).toBe('descarte')
  })

  /**
   * R20 del sistema de diseño: las otras tres causas ya dicen qué pasó.
   * `otro` no dice nada — sin texto, el registro queda como "se descartaron 12
   * unidades por otro", un número sin significado.
   */
  it('con causa "otro" hay que explicar qué pasó', async () => {
    const error = await errorDeNegocioDe(
      descartar({ loteId, cantidad: 2, causa: 'otro' }, CONTEXTO),
    )

    expect(error.code).toBe('CAUSA_REQUERIDA')
    expect(error.status).toBe(422)
  })

  it('con causa "otro" y una explicación corta, tampoco', async () => {
    const error = await errorDeNegocioDe(
      descartar({ loteId, cantidad: 2, causa: 'otro', observaciones: 'se mojó' }, CONTEXTO),
    )

    expect(error.code).toBe('CAUSA_REQUERIDA')
  })

  it('con causa "otro" y explicación suficiente, sí', async () => {
    const { saldo } = await descartar(
      { loteId, cantidad: 2, causa: 'otro', observaciones: 'se cayeron del estante al mover' },
      CONTEXTO,
    )

    expect(saldo).toBe(98)
  })

  it.each(['falla_produccion', 'mal_manejo_cliente', 'vencido'] as const)(
    'la causa %s no necesita explicación: ya dice qué pasó',
    async (causa) => {
      const { saldo } = await descartar({ loteId, cantidad: 1, causa }, CONTEXTO)

      expect(saldo).toBe(99)
    },
  )

  it('no se puede descartar más de lo que hay', async () => {
    const error = await errorDeNegocioDe(
      descartar({ loteId, cantidad: 500, causa: 'vencido' }, CONTEXTO),
    )

    expect(error.code).toBe('STOCK_INSUFICIENTE')
  })
})

describe('la bitácora explica el descuadre — ADR-0007 y RN-ACC-04', () => {
  let loteId: string

  beforeEach(async () => {
    const lote = await registrarEntrada(
      { productoId, cantidad: 100, fechaEmpaque: EMPAQUE, motivo: 'carga inicial' },
      CONTEXTO,
    )
    loteId = lote.id
  })

  it('un ajuste deja el saldo antes y después, no solo que hubo un ajuste', async () => {
    await ajustarLote({ loteId, cantidad: -8, motivo: 'conteo físico' }, CONTEXTO)

    const [entrada] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'stock:ajustar'))
      .orderBy(desc(auditLog.id))

    const payload = entrada?.payload as { antes: number; despues: number; motivo: string }
    expect(payload.antes).toBe(100)
    expect(payload.despues).toBe(92)
    expect(payload.motivo).toBe('conteo físico')
  })

  it('un descarte deja la causa en la bitácora', async () => {
    await descartar({ loteId, cantidad: 5, causa: 'vencido' }, CONTEXTO)

    const [entrada] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'stock:descartar'))
      .orderBy(desc(auditLog.id))

    const payload = entrada?.payload as { causa: string; antes: number; despues: number }
    expect(payload.causa).toBe('vencido')
    expect(payload.antes).toBe(100)
    expect(payload.despues).toBe(95)
  })

  it('una operación rechazada no escribe en la bitácora', async () => {
    await errorDeNegocioDe(ajustarLote({ loteId, cantidad: -500, motivo: 'intento de descontar mas de lo que hay' }, CONTEXTO))

    const entradas = await db.select().from(auditLog).where(eq(auditLog.action, 'stock:ajustar'))

    // Solo la de la carga inicial: el intento fallido no cuenta como ajuste.
    expect(entradas).toHaveLength(1)
  })
})
