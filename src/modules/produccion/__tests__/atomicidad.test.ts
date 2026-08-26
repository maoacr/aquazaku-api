import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import {
  cierresProduccion,
  insumos,
  lotes,
  movimientosAgua,
  movimientosInsumo,
  movimientosStock,
  productos,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { type DatosDelCierre, registrarCierre } from '@/modules/produccion/cierre'
import { resetDb } from '@/test/db'

/**
 * La compuerta de M4.
 *
 * Un cierre escribe en CUATRO tablas. Si falla el tercero, lo que queda es peor
 * que nada: un documento que dice que se envasaron 200 botellones, con el agua
 * descontada y las tapas intactas.
 *
 * **Un cierre parcial no es un cierre a medias — es una mentira consistente.**
 * Parece un documento perfectamente normal, y nadie lo sospecha hasta que la
 * planta no puede envasar.
 *
 * Estos tests verifican lo que NO quedó escrito, que es lo difícil de probar y
 * lo único que importa acá.
 */

const CATALOGO = [
  { codigo: 'BOT_20L', nombre: 'Recarga de botellón de 20 L', presentacion: 'botellon' as const, contenidoMl: 20000, unidades: 1 },
  { codigo: 'P20U_600ML', nombre: 'Paca de 20 bolsas de 600 ml', presentacion: 'paca' as const, contenidoMl: 600, unidades: 20 },
  { codigo: 'P50U_300ML', nombre: 'Paca de 50 bolsas de 300 ml', presentacion: 'paca' as const, contenidoMl: 300, unidades: 50 },
]

function unCierre(sobrescribe: Partial<DatosDelCierre> = {}): DatosDelCierre {
  return {
    fecha: '2026-08-26',
    minutosProcesando: 120,
    pacas600: 10,
    pacas300: 5,
    botellonesLlenados: 30,
    botellonesLavados: 0,
    ...sobrescribe,
  }
}

/**
 * `sinProducto` y `sinInsumo` NO borran: siembran de menos.
 *
 * `productos` e `insumos` tienen el DELETE revocado —un producto no se borra,
 * se desactiva— así que un test que intente borrarlos pelea con el sistema en
 * vez de probarlo. Sembrar de menos llega al mismo estado sin pedir permisos
 * que la aplicación no tiene ni debe tener.
 */
async function sembrar({
  tapas = 500,
  sellos = 500,
  sinProducto,
  sinInsumo,
}: {
  tapas?: number
  sellos?: number
  sinProducto?: string
  sinInsumo?: string
} = {}) {
  await db.insert(productos).values(
    CATALOGO.filter((p) => p.codigo !== sinProducto).map((p) => ({
      ...p,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })),
  )

  const disponibles = [
    { codigo: 'TAPA_20L', nombre: 'Tapa para botellón de 20 L', minimo: 200, saldo: tapas },
    { codigo: 'SELLO_BOTELLON', nombre: 'Sello termoencogible', minimo: 200, saldo: sellos },
  ].filter((i) => i.codigo !== sinInsumo)

  await db.insert(insumos).values(disponibles)
}

/** Qué quedó escrito en las cuatro tablas. Cero en todas = la transacción revirtió. */
async function loEscrito() {
  const [cierres, agua, insumosMov, lotesFilas, stock] = await Promise.all([
    db.select().from(cierresProduccion),
    db.select().from(movimientosAgua),
    db.select().from(movimientosInsumo),
    db.select().from(lotes),
    db.select().from(movimientosStock),
  ])

  return {
    cierres: cierres.length,
    agua: agua.length,
    insumos: insumosMov.length,
    lotes: lotesFilas.length,
    stock: stock.length,
  }
}

const NADA = { cierres: 0, agua: 0, insumos: 0, lotes: 0, stock: 0 }

beforeEach(async () => {
  await resetDb()
  await sembrar()
})

afterAll(async () => {
  await closeDb()
})

describe('el cierre escribe las cuatro cosas, o ninguna', () => {
  it('un cierre bien formado deja las cuatro', async () => {
    await registrarCierre(unCierre(), null)

    const escrito = await loEscrito()

    expect(escrito.cierres).toBe(1)
    // Un movimiento por producto envasado: dos pacas y los botellones.
    expect(escrito.lotes).toBe(3)
    expect(escrito.stock).toBe(3)
    // Una tapa y un sello por botellón — RN-PRD-09.
    expect(escrito.insumos).toBe(2)
    // Sin caudal medido no hay movimiento de procesamiento; sí el de envasado.
    expect(escrito.agua).toBe(1)
  })

  /**
   * ── El escrito que rompe la transacción es el TERCERO ─────────────────────
   *
   * Los insumos insuficientes cortan el cierre DESPUÉS de haber insertado el
   * documento y descontado el agua. Si la transacción no envolviera todo, lo
   * que quedaría es exactamente la mentira consistente: un cierre con agua
   * descontada y tapas intactas.
   */
  it('LA PRUEBA DE ATOMICIDAD: si los insumos no alcanzan, no queda nada', async () => {
    await resetDb()
    await sembrar({ tapas: 10 })

    await expect(registrarCierre(unCierre({ botellonesLlenados: 30 }), null)).rejects.toThrow(
      ErrorDeNegocio,
    )

    expect(await loEscrito()).toEqual(NADA)
  })

  it('el mensaje dice cuánto falta y qué hacer', async () => {
    await resetDb()
    await sembrar({ tapas: 10 })

    try {
      await registrarCierre(unCierre({ botellonesLlenados: 30 }), null)
      throw new Error('debería haber fallado')
    } catch (err) {
      expect(err).toBeInstanceOf(ErrorDeNegocio)
      const e = err as ErrorDeNegocio
      expect(e.code).toBe('INSUMOS_INSUFICIENTES')
      expect(e.message).toMatch(/quedan 10/)
      // No basta con decir que falló: hay que decir cómo salir.
      expect(e.message).toMatch(/ajuste/)
    }
  })

  /**
   * Un producto que falta corta ANTES de escribir nada.
   *
   * Este test estaba etiquetado como «si falla el último escrito» y no era
   * cierto: `calcularConsumo` busca las equivalencias en el paso 1, así que
   * revienta antes del `INSERT` del documento. Se descubrió al quitar la
   * transacción y ver que seguía pasando — un test que pasa con el mecanismo
   * quitado no estaba midiendo el mecanismo.
   *
   * Lo que sí prueba, y vale: el sistema no inventa una equivalencia en cero
   * para un producto que no está. Con `undefined` sin ese chequeo, `NaN` se
   * propagaría a `litros_consumidos` y rompería cada suma posterior.
   *
   * **La atomicidad la prueba el test de insumos insuficientes**, que corta en
   * el paso 3 con el documento y el agua ya escritos.
   */
  it('un producto que falta corta antes de escribir nada', async () => {
    await resetDb()
    await sembrar({ sinProducto: 'P50U_300ML' })

    await expect(registrarCierre(unCierre({ pacas300: 5 }), null)).rejects.toThrow(ErrorDeNegocio)

    expect(await loEscrito()).toEqual(NADA)
  })

  /*
   * El `UNIQUE(fecha)` corta en el paso 1, así que este test tampoco depende de
   * la transacción. Vale igual: verifica que un día no pueda tener dos
   * verdades, y que el intento fallido no deje movimientos huérfanos.
   */
  it('un segundo cierre para la misma fecha no deja rastro del intento', async () => {
    await registrarCierre(unCierre(), null)
    const despuesDelPrimero = await loEscrito()

    await expect(registrarCierre(unCierre(), null)).rejects.toThrow()

    // Ni un movimiento de más: el segundo intento revirtió entero.
    expect(await loEscrito()).toEqual(despuesDelPrimero)
  })
})

describe('lo que el cierre se niega a inventar', () => {
  /**
   * El lavado consume agua sin generar producto. Sin saber cuánta, el balance
   * cerraría con un término en cero y el consumo saldría subestimado — un
   * número que parece correcto y no lo es.
   */
  it('rechaza lavados sin saber cuántos litros consume un lavado', async () => {
    await expect(
      registrarCierre(unCierre({ botellonesLavados: 20 }), null),
    ).rejects.toMatchObject({ code: 'SIN_LITROS_DE_LAVADO' })

    expect(await loEscrito()).toEqual(NADA)
  })

  it('con la medición cargada, el lavado entra al balance', async () => {
    await registrarCierre(unCierre({ botellonesLavados: 20, litrosPorLavado: 3 }), null)

    const [cierre] = await db.select().from(cierresProduccion)
    // 10×12 + 5×15 + 30×20 = 795 de envasado, más 20×3 = 60 de lavado.
    expect(cierre?.litrosConsumidos).toBe(855)

    // Van SEPARADOS: uno genera producto y el otro no. Sumarlos perdería eso.
    const tipos = (await db.select().from(movimientosAgua)).map((m) => m.tipo)
    expect(tipos).toContain('envasado')
    expect(tipos).toContain('lavado')
  })

  /**
   * Sin caudal no se calcula el procesamiento — preguntas 4 y 5. El cierre SÍ
   * se registra: el envasado se sabe aunque el procesamiento no.
   */
  it('sin caudal medido, el cierre entra pero sin litros procesados', async () => {
    await registrarCierre(unCierre(), null)

    const [cierre] = await db.select().from(cierresProduccion)
    expect(cierre?.caudalGpm).toBeNull()
    expect(cierre?.litrosProcesados).toBeNull()

    // Y no hay movimiento de procesamiento, porque no se sabe cuánto entró.
    const tipos = (await db.select().from(movimientosAgua)).map((m) => m.tipo)
    expect(tipos).not.toContain('procesamiento')
  })

  it('con caudal, mueve los DOS tanques', async () => {
    await registrarCierre(unCierre({ caudalGpm: 5 }), null)

    const movimientos = await db.select().from(movimientosAgua)
    const procesamiento = movimientos.filter((m) => m.tipo === 'procesamiento')

    expect(procesamiento).toHaveLength(2)
    // Sale del crudo, entra al procesado.
    expect(procesamiento.find((m) => m.tanque === 'crudo')!.litros).toBeLessThan(0)
    expect(procesamiento.find((m) => m.tanque === 'procesado')!.litros).toBeGreaterThan(0)
  })

  /**
   * El crudo que se consume incluye el 30 % que rechaza el filtro — RN-PRD-12.
   * Descontar solo lo utilizable dejaría el almacenamiento crudo diciendo que
   * hay más agua de la que hay.
   */
  it('el crudo descontado incluye la merma del filtro', async () => {
    await registrarCierre(unCierre({ caudalGpm: 5 }), null)

    const movimientos = await db.select().from(movimientosAgua)
    const crudo = movimientos.find((m) => m.tanque === 'crudo')!
    const procesado = movimientos.find(
      (m) => m.tanque === 'procesado' && m.tipo === 'procesamiento',
    )!

    // |crudo| ≈ procesado ÷ 0,70
    expect(Math.abs(crudo.litros)).toBe(Math.round(procesado.litros / 0.7))
    expect(Math.abs(crudo.litros)).toBeGreaterThan(procesado.litros)
  })

  it('rechaza un cierre sin tiempo de procesamiento', async () => {
    await expect(registrarCierre(unCierre({ minutosProcesando: 0 }), null)).rejects.toMatchObject({
      code: 'SIN_PROCESAMIENTO',
    })
  })

  it('rechaza conteos negativos', async () => {
    await expect(registrarCierre(unCierre({ pacas600: -1 }), null)).rejects.toMatchObject({
      code: 'CONTEO_INVALIDO',
    })
  })

  it('rechaza cerrar si falta el insumo en el catálogo', async () => {
    await resetDb()
    await sembrar({ sinInsumo: 'SELLO_BOTELLON' })

    await expect(registrarCierre(unCierre(), null)).rejects.toMatchObject({
      code: 'INSUMO_NO_CARGADO',
    })

    expect(await loEscrito()).toEqual(NADA)
  })
})

describe('un día sin envasar', () => {
  it('se registra, y no consume insumos ni genera lotes', async () => {
    await registrarCierre(
      unCierre({ pacas600: 0, pacas300: 0, botellonesLlenados: 0 }),
      null,
    )

    const escrito = await loEscrito()
    expect(escrito.cierres).toBe(1)
    expect(escrito.insumos).toBe(0)
    expect(escrito.lotes).toBe(0)
    // Tampoco movimiento de agua: no salió nada del tanque.
    expect(escrito.agua).toBe(0)
  })
})

/**
 * ── La primitiva de M2, usada desde adentro de la transacción de M4 ─────────
 *
 * `crearLoteConEntrada` se extrajo en T3 para que el cierre no reimplementara
 * el código de lote ni el vencimiento. Lo que hay que verificar es que
 * **respete la transacción de quien la llama**: si abriera una propia, el lote
 * commitearía aparte y sobreviviría a un cierre que revirtió.
 *
 * Ese lote huérfano sería stock que nadie produjo, apuntando a un cierre que no
 * existe.
 */
describe('el lote respeta la transacción de quien lo crea', () => {
  it('un cierre que revierte NO deja el lote que alcanzó a crear', async () => {
    await resetDb()
    // Con tapas de menos, el cierre corta en el paso 3 — después de haber
    // escrito el documento y el agua, y antes de los lotes.
    await sembrar({ tapas: 10 })

    await expect(registrarCierre(unCierre({ botellonesLlenados: 30 }), null)).rejects.toThrow()

    expect((await db.select().from(lotes)).length).toBe(0)
    expect((await db.select().from(movimientosStock)).length).toBe(0)
  })

  /**
   * Los tres lotes de un mismo cierre no pueden pedir el mismo código.
   *
   * `crearLoteConEntrada` consulta los del día POR EL EJECUTOR: leer fuera de
   * la transacción vería un estado viejo y los tres saldrían `-L1`.
   */
  it('los lotes de un mismo cierre llevan códigos distintos', async () => {
    const { lotes: generados } = await registrarCierre(unCierre(), null)

    const codigos = generados.map((l) => l.codigo)
    expect(codigos).toHaveLength(3)
    expect(new Set(codigos).size).toBe(3)
    // Y todos del día del cierre.
    expect(codigos.every((c) => c.startsWith('2026-08-26-L'))).toBe(true)
  })

  /** El lote nace en cero y sube por movimiento — el libro lo explica entero. */
  it('el saldo del lote lo explica su movimiento', async () => {
    await registrarCierre(unCierre({ pacas600: 10, pacas300: 0, botellonesLlenados: 0 }), null)

    const [lote] = await db.select().from(lotes)
    const movimientos = await db.select().from(movimientosStock)

    expect(lote?.cantidadDisponible).toBe(10)
    expect(movimientos).toHaveLength(1)
    expect(movimientos[0]?.cantidad).toBe(10)
    expect(movimientos[0]?.tipo).toBe('produccion')
  })
})
