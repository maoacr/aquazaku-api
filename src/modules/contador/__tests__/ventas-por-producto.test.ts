import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, lineasDeVenta, lotes, productos, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { ventasPorProducto } from '@/modules/contador/ventas-por-producto'
import { resetDb } from '@/test/db'
import { direccionDe } from '@/test/fixtures'

/**
 * Unidades vendidas por producto — el reporte que faltaba.
 *
 * ── Por qué hace falta si ya existe el extracto ─────────────────────────────
 *
 * El extracto sabe cuánta PLATA entró. No sabe cuántos botellones se
 * recargaron. Y son dos preguntas distintas: un mes que creció 14 % creció
 * porque se vendió más, o porque se subió el precio. El extracto no las puede
 * separar; este reporte sí.
 *
 * En una planta de agua las unidades son la verdad operativa.
 *
 * ── El monto sale de multiplicar, no de leer una columna ────────────────────
 *
 * `precioFinal` es el precio UNITARIO —el check de la tabla lo ata a
 * `lista − descuento`, sin cantidad adentro—. El total de la línea es
 * `precioFinal × cantidad`, que es lo que hace `totalDeLinea` en `precio.ts`.
 * Sumar la columna pelada daría el monto de vender UNA unidad de cada línea.
 */

let clienteId: string
let direccionId: string
let botellon: string
let paca: string
let loteBotellon: string
let lotePaca: string

/** Una venta confirmada con una línea. `estado` entra por parámetro para
 *  poder sembrar anuladas y corregidas, que es la mitad de lo que se prueba. */
async function ventaDe(
  productoId: string,
  loteId: string,
  {
    fecha,
    cantidad,
    precioUnitario,
    estado = 'confirmada',
  }: {
    fecha: string
    cantidad: number
    precioUnitario: string
    estado?: 'confirmada' | 'anulada' | 'corregida'
  },
) {
  return db.transaction(async (tx) => {
    const total = (Number(precioUnitario) * cantidad).toFixed(2)

    const [v] = await tx
      .insert(ventas)
      .values({
        clienteId,
        // RN-VEN-18: con cliente va dirección.
        direccionId,
        tipoClienteAlMomento: 'comercial',
        medioDePago: 'efectivo',
        tipo: 'producto',
        estado,
        total,
        createdAt: new Date(fecha),
        /*
         * El check `ventas_anulacion_completa` exige responsable y motivo para
         * CUALQUIER estado que no sea `confirmada` — corregida incluida, aunque
         * el comentario de la tabla hable solo de anulada. Media anulación no
         * se puede sembrar ni desde un test, y está bien que sea así.
         */
        ...(estado !== 'confirmada' && {
          anuladaEn: new Date(fecha),
          motivoAnulacion:
            estado === 'anulada' ? 'Error de digitación' : 'Reemplazada por corrección',
        }),
      })
      .returning()

    await tx.insert(lineasDeVenta).values({
      ventaId: v!.id,
      productoId,
      loteId,
      cantidad,
      precioListaAplicado: precioUnitario,
      descuentoMonto: '0.00',
      precioFinal: precioUnitario,
      precioMinimoAplicado: '0.00',
    })

    return v!
  })
}

async function sembrarProducto(codigo: string, nombre: string, presentacion: 'botellon' | 'paca') {
  const [p] = await db
    .insert(productos)
    .values({
      codigo,
      nombre,
      presentacion,
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '12000.00',
      precioComercial: '10000.00',
      precioMinimo: '8000.00',
    })
    .returning()

  const [l] = await db
    .insert(lotes)
    .values({
      productoId: p!.id,
      codigo: `L-${codigo}`,
      fechaEmpaque: '2026-01-01',
      fechaVencimiento: '2026-12-31',
      cantidadInicial: 9999,
      cantidadDisponible: 9999,
    })
    .returning()

  return { productoId: p!.id, loteId: l!.id }
}

/**
 * La sesión va en UTC, como producción — el mismo criterio que `dia.test.ts`.
 *
 * Sin esto el test de la venta nocturna es un FALSO POSITIVO en esta máquina:
 * la base de desarrollo corre en `America/Bogota`, así que un `::date` a secas
 * ya da el día de la planta y el test pasa igual sin `diaEnLaPlanta`. Medido —
 * la ablación no mató nada hasta que se agregó este `SET`.
 *
 * Producción (Supabase) y el CI corren en UTC. Un test que solo falla en CI
 * enseña a desconfiar del CI.
 *
 * En modo test el pool es de UNA conexión, así que el `SET` alcanza a todo el
 * archivo.
 */
beforeAll(async () => {
  await db.execute(sql`SET TIME ZONE 'UTC'`)
})

beforeEach(async () => {
  await resetDb()

  const [c] = await db
    .insert(clientes)
    .values({
      nombreLibre: 'Panadería del Centro',
      tipoDocumento: 'NIT',
      numeroDocumento: '900456789',
      tipo: 'comercial',
    })
    .returning()
  clienteId = c!.id
  direccionId = await direccionDe(clienteId)

  const b = await sembrarProducto('BOT_20L', 'Recarga de botellón', 'botellon')
  botellon = b.productoId
  loteBotellon = b.loteId

  const p = await sembrarProducto('PACA_600', 'Paca de 600 ml x 24', 'paca')
  paca = p.productoId
  lotePaca = p.loteId
})

afterAll(async () => {
  await closeDb()
})

describe('suma unidades y plata por producto', () => {
  it('acumula varias ventas del mismo producto en una sola fila', async () => {
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-10T10:00:00-05:00',
      cantidad: 3,
      precioUnitario: '10000.00',
    })
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-12T10:00:00-05:00',
      cantidad: 2,
      precioUnitario: '10000.00',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas).toHaveLength(1)
    expect(filas[0]!.codigo).toBe('BOT_20L')
    expect(filas[0]!.nombre).toBe('Recarga de botellón')
    expect(filas[0]!.unidades).toBe(5)
    expect(filas[0]!.monto).toBe('50000.00')
  })

  /*
   * El que más se mueve va primero: la pregunta del tablero es «qué vendo»,
   * y se contesta por volumen, no en orden alfabético.
   */
  it('separa productos distintos y pone primero el de más unidades', async () => {
    await ventaDe(paca, lotePaca, {
      fecha: '2026-06-10T10:00:00-05:00',
      cantidad: 2,
      precioUnitario: '30000.00',
    })
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-11T10:00:00-05:00',
      cantidad: 9,
      precioUnitario: '10000.00',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas.map((f) => f.codigo)).toEqual(['BOT_20L', 'PACA_600'])
    expect(filas[0]!.unidades).toBe(9)
    expect(filas[1]!.unidades).toBe(2)
    // 2 × 30 000: el monto multiplica por la cantidad, no lee el unitario.
    expect(filas[1]!.monto).toBe('60000.00')
  })

  /*
   * ── Un producto sin ventas NO aparece ─────────────────────────────────────
   *
   * Al revés que el resumen mensual, que completa los meses vacíos en cero. Un
   * mes ausente se leería como «no lo consulté»; acá no hay secuencia que
   * completar, y un catálogo de veinte productos con dos vendidos enterraría
   * los dos que importan debajo de dieciocho ceros.
   */
  it('deja afuera al producto que no se vendió en el rango', async () => {
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-10T10:00:00-05:00',
      cantidad: 1,
      precioUnitario: '10000.00',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas.map((f) => f.codigo)).toEqual(['BOT_20L'])
  })
})

describe('los bordes del rango', () => {
  /*
   * El `hasta` es INCLUSIVO, igual que en el extracto. Con un `<=` sobre el
   * timestamp, todo lo del último día después de medianoche queda afuera: un
   * día entero de operación que nadie extraña hasta que concilia.
   */
  it('cuenta la venta del último día del rango', async () => {
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-30T16:00:00-05:00',
      cantidad: 4,
      precioUnitario: '10000.00',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas[0]!.unidades).toBe(4)
  })

  /*
   * ── El día se calcula en la zona de la PLANTA ─────────────────────────────
   *
   * Con la base en UTC, una venta de las 23:30 del 30 de junio en Colombia es
   * el 1 de julio a las 04:30 UTC. Un `::date` a secas la mandaría a julio y
   * el reporte de junio perdería la última venta del mes.
   */
  it('una venta de la noche no se va al día siguiente', async () => {
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-30T23:30:00-05:00',
      cantidad: 7,
      precioUnitario: '10000.00',
    })

    const junio = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })
    const julio = await ventasPorProducto({ desde: '2026-07-01', hasta: '2026-07-31' })

    expect(junio[0]?.unidades).toBe(7)
    expect(julio).toEqual([])
  })

  it('deja afuera lo que cae antes del desde', async () => {
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-05-31T10:00:00-05:00',
      cantidad: 5,
      precioUnitario: '10000.00',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas).toEqual([])
  })

  /*
   * Un rango al revés devuelve vacío en SQL, y ese vacío se lee como «no se
   * vendió nada» — que es plausible y falso. Mismo criterio que el extracto.
   */
  it('un rango invertido falla en vez de devolver vacío', async () => {
    await expect(
      ventasPorProducto({ desde: '2026-06-30', hasta: '2026-06-01' }),
    ).rejects.toThrow(ErrorDeNegocio)

    await expect(
      ventasPorProducto({ desde: '2026-06-30', hasta: '2026-06-01' }),
    ).rejects.toMatchObject({ code: 'RANGO_INVALIDO', status: 422 })
  })
})

describe('qué ventas cuentan', () => {
  it('no cuenta las anuladas', async () => {
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-10T10:00:00-05:00',
      cantidad: 3,
      precioUnitario: '10000.00',
    })
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-11T10:00:00-05:00',
      cantidad: 8,
      precioUnitario: '10000.00',
      estado: 'anulada',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas[0]!.unidades).toBe(3)
    expect(filas[0]!.monto).toBe('30000.00')
  })

  /*
   * ── La corregida es el doble conteo esperando a pasar — RN-VEN-16 ─────────
   *
   * Corregir no es un PATCH: la vieja se marca `corregida` y se inserta una
   * venta NUEVA que la reemplaza, con el `createdAt` del hecho original. Las
   * dos quedan en el rango y las dos tienen líneas. Sin este filtro, una
   * corrección de cantidad reporta las unidades viejas MÁS las nuevas.
   */
  it('no cuenta las corregidas, que si no se contarían dos veces', async () => {
    // El hecho original: se registraron 10 y eran 4.
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-10T10:00:00-05:00',
      cantidad: 10,
      precioUnitario: '10000.00',
      estado: 'corregida',
    })
    // La que la reemplaza, en la posición temporal del hecho.
    await ventaDe(botellon, loteBotellon, {
      fecha: '2026-06-10T10:00:00-05:00',
      cantidad: 4,
      precioUnitario: '10000.00',
    })

    const filas = await ventasPorProducto({ desde: '2026-06-01', hasta: '2026-06-30' })

    expect(filas).toHaveLength(1)
    expect(filas[0]!.unidades).toBe(4)
    expect(filas[0]!.monto).toBe('40000.00')
  })
})
