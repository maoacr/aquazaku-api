import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { lineasDeVenta, productos, ventas } from '@/db/schema'
import { diaEnLaPlanta } from '@/lib/dia'
import { ErrorDeNegocio } from '@/lib/errors'
import { aCentavos, aMonto } from '@/modules/ventas/precio'

/**
 * Unidades vendidas por producto, en un rango — el reporte que faltaba.
 *
 * ── Por qué no alcanza con el extracto ──────────────────────────────────────
 *
 * El extracto contesta cuánta PLATA entró. No contesta cuántos botellones se
 * recargaron, y son dos preguntas distintas: un mes que creció 14 % creció
 * porque se vendió más volumen, o porque se subió el precio. Con el extracto
 * solo, las dos conclusiones se ven idénticas.
 *
 * En una planta de agua las unidades son la verdad operativa. Esto las expone.
 *
 * ── El monto se MULTIPLICA, no se lee ───────────────────────────────────────
 *
 * `precioFinal` es el precio UNITARIO: el check `lineas_precio_cuadra` lo ata a
 * `precioListaAplicado − descuentoMonto`, y ahí no entra la cantidad. El total
 * de la línea es `precioFinal × cantidad` —lo mismo que hace `totalDeLinea` en
 * `precio.ts`—. Sumar la columna pelada daría el monto de vender UNA unidad de
 * cada línea, que es un número plausible y falso.
 *
 * La multiplicación y la suma van en SQL sobre `numeric`, que es decimal exacto:
 * no hay coma flotante en el camino. El `aCentavos`/`aMonto` del final es para
 * normalizar la escala, no para arreglar un error de redondeo.
 *
 * ── Por qué NO sale del total de la venta ───────────────────────────────────
 *
 * Una venta puede tener varias líneas de productos distintos. `ventas.total` es
 * el total del comprobante y no se puede repartir entre sus líneas sin volver a
 * multiplicar — así que el recorrido natural es al revés: se parte de las
 * líneas, que son el grano del dato, y la venta solo aporta la fecha y el
 * estado.
 */

export interface ProductoVendido {
  productoId: string
  codigo: string
  nombre: string
  /** Unidades despachadas: la suma de `cantidad` de las líneas. */
  unidades: number
  /** `precioFinal × cantidad`, sumado. */
  monto: string
}

export interface RangoDeFechas {
  /** `YYYY-MM-DD`. */
  desde: string
  /** `YYYY-MM-DD`, **inclusivo**. */
  hasta: string
}

export async function ventasPorProducto({
  desde,
  hasta,
}: RangoDeFechas): Promise<ProductoVendido[]> {
  if (desde > hasta) {
    /*
     * Mismo criterio que el extracto: un rango al revés devuelve vacío en SQL,
     * y ese vacío se lee como «no se vendió nada». Plausible y falso, que es
     * peor que un error.
     */
    throw new ErrorDeNegocio(
      'RANGO_INVALIDO',
      422,
      `el rango va de ${desde} a ${hasta}, que es al revés. Un rango invertido no devuelve nada, y ese vacío se lee como «no se vendió nada»`,
    )
  }

  /*
   * Se reusa la expresión en el ORDER BY, así que vive en una constante: dos
   * copias de la misma suma es una invitación a que una cambie sin la otra.
   */
  const unidades = sql<string>`sum(${lineasDeVenta.cantidad})`
  const monto = sql<string>`sum(${lineasDeVenta.precioFinal} * ${lineasDeVenta.cantidad})`

  const filas = await db
    .select({
      productoId: productos.id,
      codigo: productos.codigo,
      nombre: productos.nombre,
      unidades,
      monto,
    })
    .from(lineasDeVenta)
    .innerJoin(ventas, eq(ventas.id, lineasDeVenta.ventaId))
    .innerJoin(productos, eq(productos.id, lineasDeVenta.productoId))
    .where(
      and(
        /*
         * El `hasta` es INCLUSIVO y el día se calcula en la zona de la PLANTA.
         * Con un `<=` sobre el timestamp se pierde el último día entero; con un
         * `::date` a secas —la base está en UTC— toda venta posterior a las
         * 19:00 cae en el día siguiente. Ver `lib/dia.ts`.
         */
        gte(diaEnLaPlanta(ventas.createdAt), desde),
        lte(diaEnLaPlanta(ventas.createdAt), hasta),

        /*
         * ── Solo `confirmada`, y la `corregida` es la que importa ───────────
         *
         * Anulada es obvia: no se vendió. La CORREGIDA es la trampa —
         * RN-VEN-16. Corregir no es un PATCH: la vieja se marca `corregida` y
         * se inserta una venta nueva con el `createdAt` del hecho original.
         * Las dos caen en el mismo rango y las dos tienen líneas, así que sin
         * este filtro una corrección de cantidad reporta las unidades viejas
         * MÁS las nuevas. Es el mismo filtro que ya aplica `GET /ventas`.
         */
        eq(ventas.estado, 'confirmada'),

        /*
         * El recargo por daño a una base (`dano_base`) no es producto
         * despachado. Hoy no escribe líneas, así que el `innerJoin` ya lo
         * dejaría afuera — pero el filtro es explícito a propósito: que hoy no
         * escriba líneas es una propiedad de la implementación, no una regla, y
         * el día que cambie este reporte no debería empezar a contar recargos
         * como unidades vendidas en silencio.
         */
        eq(ventas.tipo, 'producto'),
      ),
    )
    .groupBy(productos.id, productos.codigo, productos.nombre)
    /*
     * El que más se mueve primero: la pregunta es «qué vendo», y se contesta
     * por volumen. El desempate por `codigo` —que es único, ver
     * `productos_codigo_key`— hace que el orden sea TOTAL: sin él, dos
     * productos con las mismas unidades salían en el orden que eligiera el
     * plan, y podía cambiar entre dos corridas del mismo reporte.
     */
    .orderBy(desc(unidades), asc(productos.codigo))

  return filas.map((f) => ({
    productoId: f.productoId,
    codigo: f.codigo,
    nombre: f.nombre,
    unidades: Number(f.unidades),
    // Normaliza la escala: `sum` sobre numeric puede volver sin los dos
    // decimales, y el resto del sistema espera `'50000.00'`.
    monto: aMonto(aCentavos(f.monto)),
  }))
}
