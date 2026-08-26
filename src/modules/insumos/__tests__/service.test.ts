import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { insumos, movimientosInsumo } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import {
  ajustarInsumo,
  crearInsumo,
  descartarInsumo,
  editarInsumo,
  listarInsumos,
  registrarEntrada,
} from '@/modules/insumos/service'
import { resetDb } from '@/test/db'

/** Un insumo que se compra por unidad: tapas. */
async function unaTapa() {
  return crearInsumo({ codigo: 'TAPA_20L', nombre: 'Tapa para botellón de 20 L', minimo: 200 })
}

/** Un insumo que se compra por peso. Con equivalencia solo si se la pasan. */
async function unaBolsa(equivalenciaPorKilo?: number) {
  return crearInsumo({
    codigo: 'BOLSA_600',
    nombre: 'Bolsa de 600 ml',
    minimo: 1000,
    equivalenciaPorKilo,
  })
}

/** Un error de negocio con su código, o falla el test diciendo qué llegó. */
async function errorDeNegocioDe(operacion: Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await operacion
  } catch (err) {
    if (err instanceof ErrorDeNegocio) return err
    throw err
  }
  throw new Error('se esperaba un ErrorDeNegocio, pero la operación terminó bien')
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

describe('el aviso de stock mínimo — RN-INS-03', () => {
  /**
   * La frontera exacta.
   *
   * «Al mínimo o por debajo», no «por debajo». Avisar un paso después es avisar
   * cuando ya se consumió la reserva que el mínimo representaba — y el mínimo
   * existe justamente para cubrir lo que se consume mientras llega el pedido.
   */
  it('avisa EN el mínimo, no un paso después', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 200 }, null)

    const [listado] = await listarInsumos()
    expect(listado?.saldo).toBe(200)
    expect(listado?.bajoMinimo).toBe(true)
  })

  it('no avisa con una unidad por encima del mínimo', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 201 }, null)

    const [listado] = await listarInsumos()
    expect(listado?.bajoMinimo).toBe(false)
  })

  it('avisa en cero, que es el caso que frena la planta', async () => {
    await unaTapa()

    const [listado] = await listarInsumos()
    expect(listado?.saldo).toBe(0)
    expect(listado?.bajoMinimo).toBe(true)
  })

  it('no lista los inactivos salvo que se pidan', async () => {
    const insumo = await unaTapa()
    await editarInsumo(insumo.id, { activo: false })

    expect(await listarInsumos()).toHaveLength(0)
    expect(await listarInsumos(true)).toHaveLength(1)
  })
})

describe('la entrada por peso — RN-INS-02', () => {
  /**
   * ── El rechazo que es una decisión, no una limitación ────────────────────
   *
   * Cuántas unidades trae un kilo es una medición de planta que todavía no se
   * hizo (pregunta 37). El sistema NO estima: una equivalencia inventada
   * descuadra el inventario en silencio, y el descuadre se descubre semanas
   * después sin forma de saber cuándo empezó.
   */
  it('rechaza kilos cuando el insumo no tiene equivalencia medida', async () => {
    const bolsa = await unaBolsa()

    const error = await errorDeNegocioDe(registrarEntrada(bolsa.id, { kilos: 12 }, null))

    expect(error.code).toBe('SIN_EQUIVALENCIA')
    expect(error.status).toBe(422)
    // El mensaje tiene que decir QUÉ hacer, no solo que no se pudo.
    expect(error.message).toMatch(/pesar un paquete y contarlo/)
  })

  it('el mismo insumo SÍ acepta la entrada en unidades', async () => {
    // Es lo que hace que la pregunta 37 bloquee una rama y no el módulo.
    const bolsa = await unaBolsa()

    const resultado = await registrarEntrada(bolsa.id, { cantidad: 1200 }, null)

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(1200)
  })

  it('convierte y guarda los tres datos de la conversión', async () => {
    const bolsa = await unaBolsa(100)

    const resultado = await registrarEntrada(bolsa.id, { kilos: 12.5 }, null)

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(1250)

    const [movimiento] = await db.select().from(movimientosInsumo)
    expect(movimiento?.cantidad).toBe(1250)
    expect(movimiento?.kilos).toBe('12.500')
    expect(movimiento?.equivalencia).toBe('100.000')
  })

  it('rechaza una conversión que no llega a una unidad', async () => {
    const bolsa = await unaBolsa(2)

    const error = await errorDeNegocioDe(registrarEntrada(bolsa.id, { kilos: 0.2 }, null))

    expect(error.code).toBe('CONVERSION_VACIA')
  })

  /**
   * ── Cambiar la equivalencia NO reescribe la historia ─────────────────────
   *
   * Es la razón por la que se copia en el movimiento en vez de leerse del
   * insumo. Es el mismo error que M2 evitó con `fecha_vencimiento`: con una
   * referencia viva, corregir el número de hoy cambiaría lo que significaron
   * todas las compras anteriores.
   */
  it('cambiar la equivalencia no altera ningún movimiento pasado', async () => {
    const bolsa = await unaBolsa(100)
    await registrarEntrada(bolsa.id, { kilos: 10 }, null)

    await editarInsumo(bolsa.id, { equivalenciaPorKilo: 130 })

    const [movimiento] = await db.select().from(movimientosInsumo)
    expect(movimiento?.equivalencia).toBe('100.000')
    expect(movimiento?.cantidad).toBe(1000)

    // Y el saldo tampoco se recalcula: son unidades que ya entraron.
    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, bolsa.id))
    expect(insumo?.saldo).toBe(1000)
  })

  it('la equivalencia nueva SÍ se usa en la compra siguiente', async () => {
    const bolsa = await unaBolsa(100)
    await registrarEntrada(bolsa.id, { kilos: 10 }, null)
    await editarInsumo(bolsa.id, { equivalenciaPorKilo: 130 })

    await registrarEntrada(bolsa.id, { kilos: 10 }, null)

    const movimientos = await db.select().from(movimientosInsumo)
    expect(movimientos.map((m) => m.equivalencia)).toEqual(['100.000', '130.000'])
    expect(movimientos.map((m) => m.cantidad)).toEqual([1000, 1300])
  })
})

describe('el ajuste exige un motivo que sirva', () => {
  it('rechaza un motivo corto', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 500 }, null)

    const error = await errorDeNegocioDe(
      ajustarInsumo(insumo.id, { diferencia: -8, motivo: 'x' }, null),
    )

    expect(error.code).toBe('MOTIVO_REQUERIDO')
  })

  it('un ajuste negativo descuenta', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 500 }, null)

    const resultado = await ajustarInsumo(
      insumo.id,
      { diferencia: -8, motivo: 'conteo físico del lunes, faltaban 8 tapas' },
      null,
    )

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(492)
  })

  it('un ajuste positivo suma', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 500 }, null)

    const resultado = await ajustarInsumo(
      insumo.id,
      { diferencia: 12, motivo: 'aparecieron 12 tapas en la caja del fondo' },
      null,
    )

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(512)
  })

  it('un ajuste que deja el saldo negativo devuelve ok:false, no rompe', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 10 }, null)

    const resultado = await ajustarInsumo(
      insumo.id,
      { diferencia: -50, motivo: 'conteo físico, faltan muchas más de las que hay' },
      null,
    )

    expect(resultado.ok).toBe(false)
    if (!resultado.ok) expect(resultado.disponible).toBe(10)
  })
})

describe('el descarte exige clasificar', () => {
  it('con causa `otro` hay que explicar', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 500 }, null)

    const error = await errorDeNegocioDe(
      descartarInsumo(insumo.id, { cantidad: 5, causa: 'otro', observaciones: 'x' }, null),
    )

    expect(error.code).toBe('OBSERVACIONES_REQUERIDAS')
  })

  it('las otras causas no exigen observaciones: se explican solas', async () => {
    const insumo = await unaTapa()
    await registrarEntrada(insumo.id, { cantidad: 500 }, null)

    const resultado = await descartarInsumo(
      insumo.id,
      { cantidad: 5, causa: 'mal_manejo_cliente' },
      null,
    )

    expect(resultado.ok).toBe(true)
    if (resultado.ok) expect(resultado.saldo).toBe(495)
  })
})

describe('un insumo que no existe', () => {
  it('no se le puede cargar nada', async () => {
    const inexistente = '00000000-0000-0000-0000-000000000000'

    const error = await errorDeNegocioDe(registrarEntrada(inexistente, { cantidad: 10 }, null))

    expect(error.code).toBe('INSUMO_NO_ENCONTRADO')
    expect(error.status).toBe(404)
  })
})
