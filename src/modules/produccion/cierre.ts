import { and, eq, like } from 'drizzle-orm'
import { type DB, db } from '@/db/client'
import {
  type CierreProduccion,
  cierresProduccion,
  insumos,
  lotes,
  movimientosAgua,
  movimientosStock,
  productos,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { descontar as descontarInsumo } from '@/modules/insumos/saldo'
import { codigoDeLote, vencimientoDe } from '@/modules/stock/codigo-lote'

/**
 * El cierre de producción — M4, RN-PRD-04.
 *
 * ═══ LA COMPUERTA DE M4: LA ATOMICIDAD ══════════════════════════════════════
 *
 * M2 y M3 tuvieron el mismo riesgo de fondo —dos personas moviendo el mismo
 * saldo— y lo resolvieron con el `UPDATE` condicional. **Este es otro.**
 *
 * El cierre escribe en cuatro tablas: el documento, el libro del agua, el de
 * insumos, y el lote con su movimiento de stock. Una sola operación de negocio
 * repartida en cuatro escritos.
 *
 * Si falla el tercero, lo que queda es PEOR QUE NADA: un cierre que dice que se
 * envasaron 200 botellones, con el agua descontada y las tapas intactas. La
 * planta cree que tiene insumos que ya gastó, y lo descubre el día que no puede
 * envasar.
 *
 * **Un cierre parcial no es un cierre a medias — es una mentira consistente**,
 * que es la clase de dato que nadie sospecha hasta que ya causó daño.
 *
 * Por eso los cuatro reciben el MISMO `tx`. Ninguno abre su propia transacción:
 * `enTransaccion` de `saldo.ts` ya lo resuelve —abre solo si el ejecutor no es
 * una— y ese parámetro se agregó pensando en este momento.
 */

/** Los dos insumos que consume cada botellón llenado — RN-PRD-09. */
const INSUMOS_POR_BOTELLON = ['TAPA_20L', 'SELLO_BOTELLON'] as const

/** El producto que se genera por cada conteo del cierre. */
const PRODUCTO_DE = {
  pacas600: 'P20U_600ML',
  pacas300: 'P50U_300ML',
  botellonesLlenados: 'BOT_20L',
} as const

export interface DatosDelCierre {
  /** `YYYY-MM-DD`. Uno por día — RN-PRD-22. */
  fecha: string
  minutosProcesando: number
  pacas600: number
  pacas300: number
  botellonesLlenados: number
  /** Consumen agua y NO generan producto — RN-PRD-05. */
  botellonesLavados: number
  /**
   * Litros que consume lavar UN botellón.
   *
   * Es la [pregunta 6](/empezar/pendientes/) y todavía no se midió. Obligatoria
   * solo si hubo lavados: sin ella el consumo saldría subestimado y el balance
   * cerraría con un número que parece correcto.
   */
  litrosPorLavado?: number | undefined
  /** Solo si el caudal ya se midió — preguntas 4 y 5. */
  caudalGpm?: number | undefined
  nivelObservado?: CierreProduccion['nivelObservado']
}

export interface ResultadoDelCierre {
  cierre: CierreProduccion
  /** Los lotes que generó, uno por producto envasado — RN-PRD-23. */
  lotes: { codigo: string; productoId: string; cantidad: number }[]
}

/** Un galón americano. La placa puede decir imperial: es parte de la pregunta 4. */
const LITROS_POR_GALON = 3.785

/** De cada 100 litros crudos, 70 quedan utilizables — RN-PRD-12. */
const RENDIMIENTO = 0.7

/**
 * Registra el cierre del día y mueve los tres saldos, o no mueve ninguno.
 *
 * Lanza `ErrorDeNegocio` si algo no cuadra. **Que los insumos no alcancen
 * también lanza**, y es la única vez en el sistema que ese `{ ok: false }` se
 * convierte en excepción: en M3 «no alcanza» era una respuesta porque la
 * operación era una sola; acá hay tres escritos más que deshacer.
 */
export async function registrarCierre(
  datos: DatosDelCierre,
  registradoPor: string | null,
): Promise<ResultadoDelCierre> {
  exigirConteosValidos(datos)

  return db.transaction(async (tx) => {
    // ── 1 · El documento ─────────────────────────────────────────────────
    const litrosProcesados = calcularProcesamiento(datos)
    const litrosConsumidos = await calcularConsumo(tx, datos)

    const [cierre] = await tx
      .insert(cierresProduccion)
      .values({
        fecha: datos.fecha,
        minutosProcesando: datos.minutosProcesando,
        caudalGpm: datos.caudalGpm === undefined ? null : String(datos.caudalGpm),
        litrosProcesados,
        pacas600: datos.pacas600,
        pacas300: datos.pacas300,
        botellonesLlenados: datos.botellonesLlenados,
        botellonesLavados: datos.botellonesLavados,
        litrosConsumidos,
        nivelObservado: datos.nivelObservado ?? null,
        registradoPor,
      })
      .returning()

    // ── 2 · El agua ──────────────────────────────────────────────────────
    await moverAgua(tx, cierre!, datos, litrosProcesados, litrosConsumidos, registradoPor)

    // ── 3 · Los insumos ──────────────────────────────────────────────────
    await consumirInsumos(tx, datos.botellonesLlenados, cierre!.id, registradoPor)

    // ── 4 · El producto ──────────────────────────────────────────────────
    const generados = await generarLotes(tx, datos, cierre!.id, registradoPor)

    return { cierre: cierre!, lotes: generados }
  })
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]

function exigirConteosValidos(datos: DatosDelCierre): void {
  if (datos.minutosProcesando <= 0) {
    throw new ErrorDeNegocio(
      'SIN_PROCESAMIENTO',
      422,
      'un cierre sin tiempo de procesamiento no es un cierre: no hubo producción',
    )
  }

  const conteos = [
    datos.pacas600,
    datos.pacas300,
    datos.botellonesLlenados,
    datos.botellonesLavados,
  ]
  if (conteos.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new ErrorDeNegocio('CONTEO_INVALIDO', 422, 'los conteos son enteros y no negativos')
  }

  /*
   * El lavado consume agua sin generar producto. Sin saber cuánta, el balance
   * cerraría con un término en cero y el consumo saldría subestimado — un
   * número que parece correcto y no lo es.
   *
   * Mismo criterio que la equivalencia de las bolsas en M3: se rechaza y se
   * dice qué medir, en vez de estimar.
   */
  if (datos.botellonesLavados > 0 && datos.litrosPorLavado === undefined) {
    throw new ErrorDeNegocio(
      'SIN_LITROS_DE_LAVADO',
      422,
      'no sabemos cuántos litros consume lavar un botellón, así que no podemos cerrar el balance del agua. Hay que medirlo una vez: llenar un balde con lo que se gasta en un lavado y anotarlo',
    )
  }
}

/**
 * `caudal × minutos × 3,785 × 0,70` — RN-PRD-18 y RN-PRD-12.
 *
 * Devuelve `null` si el caudal no se midió. El sistema NO estima: una cifra de
 * procesamiento inventada descuadra el balance del agua en silencio.
 */
function calcularProcesamiento(datos: DatosDelCierre): number | null {
  if (datos.caudalGpm === undefined) return null

  const crudos = datos.caudalGpm * datos.minutosProcesando * LITROS_POR_GALON
  return Math.round(crudos * RENDIMIENTO)
}

/**
 * Los litros que salieron del tanque procesado — RN-PRD-06.
 *
 * Las equivalencias salen de `productos.litros`, que es configuración
 * (RN-PRD-01) y no una constante del código. Se leen DENTRO de la transacción:
 * leerlas afuera vería un estado que ya cambió.
 */
async function calcularConsumo(tx: Tx, datos: DatosDelCierre): Promise<number> {
  const equivalencias = await litrosPorProducto(tx)

  /*
   * Un producto que falte en el catálogo NO puede resolverse con cero: el
   * consumo saldría subestimado, el balance cerraría con un número que parece
   * correcto, y nadie lo relacionaría con el producto faltante.
   *
   * Y con `undefined` sin este chequeo, `NaN` se propagaría al balance entero
   * — que es peor, porque un NaN guardado rompe cada suma posterior.
   */
  const litros = (codigo: string): number => {
    const valor = equivalencias[codigo]
    if (valor === undefined) {
      throw new ErrorDeNegocio(
        'PRODUCTO_NO_ENCONTRADO',
        422,
        `no existe el producto ${codigo} en el catálogo, así que no podemos calcular cuánta agua consumió el día`,
      )
    }
    return valor
  }

  const envasado =
    datos.pacas600 * litros('P20U_600ML') +
    datos.pacas300 * litros('P50U_300ML') +
    datos.botellonesLlenados * litros('BOT_20L')

  const lavado = datos.botellonesLavados * (datos.litrosPorLavado ?? 0)

  return Math.round(envasado + lavado)
}

async function litrosPorProducto(tx: Tx): Promise<Record<string, number>> {
  const filas = await tx.select({ codigo: productos.codigo, litros: productos.litros }).from(productos)

  const mapa: Record<string, number> = {}
  for (const f of filas) mapa[f.codigo] = Number(f.litros)
  return mapa
}

async function moverAgua(
  tx: Tx,
  cierre: CierreProduccion,
  datos: DatosDelCierre,
  litrosProcesados: number | null,
  litrosConsumidos: number,
  registradoPor: string | null,
): Promise<void> {
  const comun = { cierreId: cierre.id, registradoPor }

  /*
   * El procesamiento mueve DOS saldos: saca del crudo y mete en el procesado.
   * El crudo que se consume es `procesados ÷ 0,70` — los 30 % que rechaza el
   * filtro también salieron del almacenamiento.
   */
  if (litrosProcesados !== null) {
    await tx.insert(movimientosAgua).values([
      {
        ...comun,
        tanque: 'crudo',
        litros: -Math.round(litrosProcesados / RENDIMIENTO),
        tipo: 'procesamiento',
      },
      { ...comun, tanque: 'procesado', litros: litrosProcesados, tipo: 'procesamiento' },
    ])
  }

  // El envasado y el lavado salen del procesado, y van separados: uno genera
  // producto y el otro no. Sumarlos perdería justamente esa distinción.
  const envasado = litrosConsumidos - datos.botellonesLavados * (datos.litrosPorLavado ?? 0)

  if (envasado > 0) {
    await tx
      .insert(movimientosAgua)
      .values({ ...comun, tanque: 'procesado', litros: -Math.round(envasado), tipo: 'envasado' })
  }

  const lavado = datos.botellonesLavados * (datos.litrosPorLavado ?? 0)
  if (lavado > 0) {
    await tx
      .insert(movimientosAgua)
      .values({ ...comun, tanque: 'procesado', litros: -Math.round(lavado), tipo: 'lavado' })
  }
}

/**
 * Cada botellón llenado consume una tapa y un sello — RN-PRD-09.
 *
 * Las pacas NO consumen insumos rastreados. Confirmado por Aquazaku el
 * 26-ago-2026: las bolsas no están en el inventario de insumos.
 *
 * **Que no alcancen CORTA el cierre.** Se elige rechazar y no dejar el saldo en
 * negativo: eso es lo que M2 y M3 se pasaron dos tasks impidiendo, y permitirlo
 * acá lo devolvería por la puerta de atrás.
 *
 * Si la planta envasó de verdad y el sistema dice que no había tapas, es que el
 * inventario estaba mal ANTES del cierre — y eso se arregla con un ajuste que
 * deja constancia, no ignorándolo.
 */
async function consumirInsumos(
  tx: Tx,
  botellones: number,
  cierreId: string,
  registradoPor: string | null,
): Promise<void> {
  if (botellones === 0) return

  for (const codigo of INSUMOS_POR_BOTELLON) {
    const [insumo] = await tx.select().from(insumos).where(eq(insumos.codigo, codigo))

    if (!insumo) {
      throw new ErrorDeNegocio(
        'INSUMO_NO_CARGADO',
        422,
        `no existe el insumo ${codigo}, y cada botellón llenado consume uno. Hay que darlo de alta antes de cerrar el día`,
      )
    }

    const resultado = await descontarInsumo(
      {
        insumoId: insumo.id,
        cantidad: botellones,
        tipo: 'produccion',
        documentoId: cierreId,
        registradoPor,
      },
      tx,
    )

    if (!resultado.ok) {
      throw new ErrorDeNegocio(
        'INSUMOS_INSUFICIENTES',
        422,
        `el cierre consume ${botellones} de ${insumo.nombre} y quedan ${resultado.disponible}. Si se envasaron igual, el inventario estaba mal antes: regístrelo con un ajuste y vuelva a cerrar`,
      )
    }
  }
}

/**
 * Un lote por producto envasado, con vencimiento a 30 días — RN-PRD-23.
 *
 * El lote nace en cero y sube por movimiento, para que el libro lo explique
 * desde la primera unidad. Es el mismo criterio de `registrarEntrada` en M2 —
 * **T3 va a reemplazar esta duplicación por esa función**, una vez abierta para
 * aceptar un ejecutor externo.
 */
async function generarLotes(
  tx: Tx,
  datos: DatosDelCierre,
  cierreId: string,
  registradoPor: string | null,
): Promise<ResultadoDelCierre['lotes']> {
  const generados: ResultadoDelCierre['lotes'] = []

  for (const [campo, codigo] of Object.entries(PRODUCTO_DE)) {
    const cantidad = datos[campo as keyof typeof PRODUCTO_DE]
    if (cantidad === 0) continue

    const [producto] = await tx.select().from(productos).where(eq(productos.codigo, codigo))
    if (!producto) {
      throw new ErrorDeNegocio('PRODUCTO_NO_ENCONTRADO', 422, `no existe el producto ${codigo}`)
    }

    // Todos los del día, incluidos los agotados: un código no se recicla.
    const delDia = await tx
      .select({ codigo: lotes.codigo })
      .from(lotes)
      .where(like(lotes.codigo, `${datos.fecha}-L%`))

    const codigoNuevo = codigoDeLote(
      datos.fecha,
      delDia.map((l) => l.codigo),
    )

    const [lote] = await tx
      .insert(lotes)
      .values({
        productoId: producto.id,
        codigo: codigoNuevo,
        fechaEmpaque: datos.fecha,
        fechaVencimiento: vencimientoDe(datos.fecha),
        cantidadInicial: cantidad,
        cantidadDisponible: cantidad,
      })
      .returning({ id: lotes.id })

    await tx.insert(movimientosStock).values({
      loteId: lote!.id,
      cantidad,
      tipo: 'produccion',
      documentoId: cierreId,
      registradoPor,
    })

    generados.push({ codigo: codigoNuevo, productoId: producto.id, cantidad })
  }

  return generados
}

/** El cierre de una fecha, si existe. */
export async function cierreDe(fecha: string): Promise<CierreProduccion | undefined> {
  const [cierre] = await db
    .select()
    .from(cierresProduccion)
    .where(and(eq(cierresProduccion.fecha, fecha)))

  return cierre
}
