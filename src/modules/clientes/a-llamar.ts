import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { clientes, direcciones, lineasDeVenta, productos, telefonos, ventas } from '@/db/schema'
import { diaEnLaPlanta } from '@/lib/dia'
import { leerParametro } from '@/modules/alertas/parametros'
import { direccionLegible } from './direccion-legible'
import { numeroParaWhatsapp } from './whatsapp'

/**
 * Los seguimientos — M15, replanteados por dirección.
 *
 * ── El dato ya estaba; faltaba la pregunta ──────────────────────────────────
 *
 * Un botellón de 20 L de una casa dura alrededor de una semana. Pasada esa
 * semana el cliente no «está por pedir»: ya se le acabó, y o llamó a otra
 * planta o está aguantando. En los dos casos Aquazaku se enteró tarde.
 *
 * La fecha de la última venta siempre estuvo en la base. Esto no agrega
 * información: agrega la pregunta que nadie estaba haciendo.
 *
 * ── Por qué la fila es la DIRECCIÓN y no el cliente ─────────────────────────
 *
 * La primera versión contaba días por cliente. Pero el agua no se entrega a un
 * cliente: se entrega a una puerta. Un cliente con casa y local tiene dos
 * relojes, y la cuenta por cliente mostraba el más RECIENTE de los dos — así
 * que el local podía llevar veinte días seco escondido detrás de una casa que
 * pidió ayer. El error no se veía: la lista se leía perfecta y le faltaba una
 * fila.
 *
 * Ahora cada dirección activa saca su propia cuenta, y un cliente con dos
 * direcciones aparece dos veces. Está probado en `__tests__/a-llamar.test.ts`
 * con el nombre «la dirección que pidió ayer NO esconde a la que lleva veinte
 * días», que es literalmente el bug.
 *
 * ── Por qué dos canales ─────────────────────────────────────────────────────
 *
 * Un botellón se acaba; una paca de 80 bolsas de 100 ml no se consume con el
 * mismo reloj. Un solo contador mezclaba los dos y no servía para ninguno: el
 * botellón de hace tres días tapaba la paca de hace veinte.
 *
 * El corte es `productos.presentacion`. `botellon` —hoy, la recarga de 20 L—
 * va al canal principal; **todo lo demás** va al otro. Se pregunta por lo que
 * NO es botellón y no por `= 'paca'` a propósito: el día que entre una
 * presentación nueva, cae en «otros» sin que nadie se acuerde de este archivo.
 *
 * Una venta mixta cae en los DOS canales, porque el cliente se llevó de las dos
 * cosas y las dos se le van a acabar.
 *
 * ── Los umbrales ────────────────────────────────────────────────────────────
 *
 * Los dos canales comparten `dias_recompra_aviso` / `dias_recompra_urgente`.
 * Son parámetros y no constantes —supuesto del negocio, pregunta 48— y el día
 * que la operación diga que la paca tiene otra cadencia, la respuesta es un
 * segundo par de parámetros, no un número escrito acá.
 */

export interface TelefonoParaLlamar {
  numero: string
  etiqueta: string | null
  /** Listo para `wa.me`, o `null` si ese número no tiene WhatsApp. */
  whatsapp: string | null
}

export interface DireccionALlamar {
  clienteId: string
  nombre: string
  /** `null` cuando el cliente se registró sin documento — RN-CLI-20. */
  documento: string | null
  /** `null` cuando el cliente no tiene ninguna dirección activa cargada. */
  direccionId: string | null
  /** Cómo la llama la operación: «la casa», «el local». */
  etiqueta: string | null
  /** Ya legible, armada por `direccionLegible` — acá no se formatea nada. */
  direccion: string | null
  diasSinComprar: number
  /**
   * En qué franja cae esta dirección — RN-CLI-18.
   *
   * `al-dia` existe porque la lista dejó de ser solo «a quién llamar» y pasó a
   * ser el padrón completo: quien compró hace dos días también aparece, en
   * verde. Sin ese estado, la única forma de ver a un cliente era que estuviera
   * atrasado, y para consultarlo había que esperar a que se atrasara.
   */
  urgencia: 'al-dia' | 'aviso' | 'urgente'
  /**
   * La venta que fijó ESTE reloj no registró a qué dirección se entregó.
   *
   * Pasa con todo lo anterior a la migración 0022, cuando la columna no
   * existía. Esas ventas cuentan para todas las direcciones del cliente —no
   * desaparecer importa más que ser exacto— y la marca viaja para que la
   * operación las pueda encontrar y corregir a mano. Se apaga sola: cada venta
   * nueva registra su dirección.
   */
  ventaSinDireccion: boolean
  /**
   * La venta que fijó este reloj.
   *
   * Es sobre la que se actúa cuando `ventaSinDireccion` es `true`: la pantalla
   * ofrece asignarle una de las direcciones del cliente sin tener que ir a
   * buscarla al listado de ventas.
   */
  ventaId: string
  /**
   * Cuántas ventas hay detrás de esta fila.
   *
   * Solo importa cuando `ventaSinDireccion` es `true`: ahí la fila no es una
   * puerta esperando agua, sino un montón de ventas que no dicen dónde se
   * entregaron, y lo que hay que ver es cuántas faltan por corregir — un número
   * que BAJA mientras se trabaja.
   */
  cuantasVentas: number
  telefonos: TelefonoParaLlamar[]
}

export interface SeguimientosALlamar {
  /** Ventas que incluyeron al menos una recarga de botellón. */
  botellones: DireccionALlamar[]
  /** Ventas que incluyeron algún producto que no es una recarga de botellón. */
  otros: DireccionALlamar[]
}

type Canal = keyof SeguimientosALlamar

/** Una candidata mientras se arma: la dirección con el reloj que va ganando. */
interface Candidata {
  clienteId: string
  direccionId: string | null
  dias: number
  ventaSinDireccion: boolean
  ventaId: string
  cuantasVentas: number
}

export async function clientesALlamar(hoy: string): Promise<SeguimientosALlamar> {
  const [aviso, urgente] = await Promise.all([
    leerParametro('dias_recompra_aviso'),
    leerParametro('dias_recompra_urgente'),
  ])

  /*
   * El corte entre canales, escrito UNA vez y usado en el select y en el
   * `GROUP BY`. Se pregunta por lo que NO es botellón —y no por `= 'paca'`—
   * para que una presentación nueva caiga en «otros» sin tocar este archivo.
   */
  const esBotellon = sql<boolean>`${productos.presentacion} = 'botellon'`

  /*
   * La última compra VÁLIDA por cliente, dirección y canal.
   *
   * Las tres condiciones del `where` son las mismas del índice parcial de la
   * migración 0017, y tienen que seguir siéndolo: si divergen, el índice deja
   * de usarse y la consulta vuelve a ser un scan sin que nada falle.
   *
   *   · `estado = 'confirmada'` — una anulada NO reinicia el reloj. Es el caso
   *     más caro: el cliente figuraría como atendido sin haberse llevado nada,
   *     y justamente quien tuvo un problema es a quien más hay que llamar.
   *   · `tipo = 'producto'` — un recargo por daño no es agua que se acaba.
   *   · `cliente_id IS NOT NULL` — la venta de mostrador no tiene a quién
   *     llamar.
   *
   * El `GROUP BY` hace dos trabajos: se queda con la compra más reciente de
   * cada combinación, y de paso colapsa las líneas repetidas. Tres botellones
   * en la misma venta son una fila, no tres — sin necesidad de un `DISTINCT`
   * aparte.
   *
   * El día se calcula «visto desde la planta» y no en UTC: con la base en UTC,
   * una venta de la tarde envejecería un día de más (ver `lib/dia.ts`).
   */
  const grupos = await db
    .select({
      clienteId: ventas.clienteId,
      direccionId: ventas.direccionId,
      /*
       * El canal, como CONDICIÓN de agrupado y no como la presentación cruda.
       *
       * Antes se agrupaba por `presentacion` y el canal se derivaba después en
       * TypeScript. Daba lo mismo mientras hubiera una sola presentación que no
       * es botellón — pero `cuantasVentas` sí lo notaría: contaría las ventas
       * de cada presentación por separado y la fila diría «2 ventas» donde hay
       * una que llevó dos cosas distintas.
       *
       * Agrupando por el canal, `count(distinct)` cuenta lo que la fila
       * representa.
       */
      esBotellon: esBotellon,
      dias: sql<string>`min(${hoy}::date - ${diaEnLaPlanta(ventas.createdAt)})`,
      /*
       * La venta que FIJA el reloj de este grupo — la más reciente.
       *
       * Viaja hasta la pantalla porque es sobre la que se actúa: cuando no
       * registró dirección, el lápiz de la fila la abre para asignársela. Sin
       * el id, la fila sabría que hay algo que arreglar y no cuál.
       *
       * `array_agg(... ORDER BY ...)` y no una subconsulta correlacionada: la
       * fila más reciente del grupo sale del mismo barrido que el `min`.
       */
      ventaId: sql<string>`(array_agg(${ventas.id} ORDER BY ${ventas.createdAt} DESC))[1]`,
      /*
       * Cuántas ventas hay en el grupo.
       *
       * En las filas con dirección no se usa: ahí lo que importa es cuándo fue
       * la última. En la fila SIN dirección es el dato principal, y la razón es
       * un error que reportó la operación tres veces.
       *
       * Esa fila agrupa todas las ventas viejas del cliente y mostraba los días
       * de la más reciente. Al corregir una, esa salía del grupo y la fila
       * pasaba a la siguiente —más vieja—, así que el número SUBÍA: 40, 47, 54.
       * Se veía como si corregir no hubiera servido de nada, o peor, como si
       * hubiera empeorado algo.
       *
       * Contando ventas, el número baja: 3, 2, 1, y la fila se va. El trabajo
       * hecho se ve.
       *
       * `count(DISTINCT)` porque el `join` con las líneas multiplica una venta
       * por cada producto que llevó.
       */
      cuantasVentas: sql<string>`count(distinct ${ventas.id})`,
    })
    .from(ventas)
    .innerJoin(lineasDeVenta, eq(lineasDeVenta.ventaId, ventas.id))
    .innerJoin(productos, eq(productos.id, lineasDeVenta.productoId))
    .where(
      and(
        eq(ventas.estado, 'confirmada'),
        eq(ventas.tipo, 'producto'),
        isNotNull(ventas.clienteId),
      ),
    )
    .groupBy(ventas.clienteId, ventas.direccionId, esBotellon)

  /*
   * Quien nunca compró no aparece, y sale gratis: sin venta no hay fila en este
   * agrupado. No es una recompra, es un cliente nuevo — si entrara, cada alta
   * figuraría como urgente el mismo día de registrarse.
   */
  if (grupos.length === 0) return { botellones: [], otros: [] }

  const ids = [...new Set(grupos.map((g) => g.clienteId!))]

  const [fichas, activas, numeros] = await Promise.all([
    db
      .select({ id: clientes.id, nombre: clientes.nombre, documento: clientes.numeroDocumento })
      .from(clientes)
      .where(
        and(
          inArray(clientes.id, ids),
          eq(clientes.activo, true),
          /*
           * El tacho queda afuera — RN-CLI-21.
           *
           * «POS Aquazaku» no es un cliente: es donde caen las ventas a gente
           * que no quiso registrarse. Adentro conviven cientos de personas, así
           * que NO HAY A QUIÉN LLAMAR — y como es el que más ventas tiene y las
           * más viejas, salía PRIMERO en los dos canales. El lugar que más se
           * mira, ocupado por la única fila que no se puede accionar.
           *
           * Se excluye por la columna y no por el nombre: en una sola
           * conversación con la operación ese cliente apareció escrito de tres
           * formas distintas. Filtrar por texto deja el ruido a una renombrada
           * de distancia, y al volver no falla nada — simplemente reaparece.
           *
           * Va acá, sobre las FICHAS, y no sobre los grupos de ventas: más
           * abajo se descarta todo grupo cuyo cliente no esté en `porId`, así
           * que el filtro alcanza también a las filas sin dirección, que son
           * justo las que el tacho ponía arriba de todo.
           */
          eq(clientes.esMostrador, false),
        ),
      ),

    /*
     * Las direcciones activas de todos en UN viaje. Son el sujeto de la lista:
     * las que existen definen qué filas hay, y las de un cliente son a dónde
     * van sus ventas viejas sin dirección.
     */
    db.select().from(direcciones).where(
      and(inArray(direcciones.clienteId, ids), eq(direcciones.activa, true)),
    ),

    /*
     * Los teléfonos de todos en UN viaje, no uno por cliente. Con cuarenta
     * filas en la lista, lo segundo son cuarenta consultas para pintar una
     * pantalla que se abre todo el día.
     */
    db
      .select({
        clienteId: telefonos.clienteId,
        numero: telefonos.numero,
        etiqueta: telefonos.etiqueta,
      })
      .from(telefonos)
      .where(and(inArray(telefonos.clienteId, ids), eq(telefonos.activo, true)))
      .orderBy(desc(telefonos.createdAt)),
  ])

  const porId = new Map(fichas.map((f) => [f.id, f]))

  const direccionPorId = new Map(activas.map((d) => [d.id, d]))

  const porCliente = new Map<string, TelefonoParaLlamar[]>()
  for (const t of numeros) {
    porCliente.set(t.clienteId, [
      ...(porCliente.get(t.clienteId) ?? []),
      { numero: t.numero, etiqueta: t.etiqueta, whatsapp: numeroParaWhatsapp(t.numero) },
    ])
  }

  const candidatas: Record<Canal, Map<string, Candidata>> = {
    botellones: new Map(),
    otros: new Map(),
  }

  /**
   * Anota el reloj de un grupo, quedándose con el más reciente.
   *
   * La clave incluye la dirección —o su ausencia— porque son filas distintas:
   * «lo que se entregó en la casa» y «lo que no dice dónde se entregó» son dos
   * hechos separados, y mezclarlos taparía uno de los dos.
   */
  const anotar = (canal: Canal, c: Candidata) => {
    const clave = `${c.clienteId}|${c.direccionId ?? ''}`
    const actual = candidatas[canal].get(clave)

    if (actual === undefined || c.dias < actual.dias) candidatas[canal].set(clave, c)
  }

  /*
   * ── La fila es la venta COMO QUEDÓ REGISTRADA ────────────────────────────
   *
   * Hubo una versión que repartía las ventas sin dirección entre TODAS las
   * direcciones activas del cliente, para no perder su reloj. La idea era no
   * esconder trabajo, pero el resultado mentía de dos formas a la vez:
   *
   *   1. Cada fila mostraba una dirección concreta al lado de un conteo que no
   *      era de esa puerta. Se leía como «acá se entregó hace 43 días», y eso
   *      nadie lo sabe.
   *   2. Un cliente con dos direcciones y solo ventas viejas aparecía DOS
   *      veces, con el mismo número, reclamando dos puertas distintas.
   *
   * Ahora no se infiere nada: si la venta dice a qué dirección fue, la fila es
   * esa dirección; si no lo dice, la fila es «sin dirección asignada» y la
   * pantalla ofrece asignársela. O tiene dirección o no la tiene.
   */
  for (const g of grupos) {
    const clienteId = g.clienteId!
    if (!porId.has(clienteId)) continue

    const canal: Canal = g.esBotellon ? 'botellones' : 'otros'
    const dias = Number(g.dias)

    /*
     * Una venta a una dirección DESACTIVADA no genera fila: ya no se entrega
     * ahí, y llamar a una puerta dada de baja es trabajo inventado.
     */
    if (g.direccionId !== null && !direccionPorId.has(g.direccionId)) continue

    anotar(canal, {
      clienteId,
      direccionId: g.direccionId,
      dias,
      ventaSinDireccion: g.direccionId === null,
      ventaId: g.ventaId,
      cuantasVentas: Number(g.cuantasVentas),
    })
  }

  /**
   * Los dos umbrales, ahora como tres franjas.
   *
   * Antes `aviso` decidía quién ENTRABA a la lista: por debajo, la dirección no
   * existía para nadie. Eso convertía una consulta —«¿cuándo compró éste?»— en
   * algo que había que esperar a que se pusiera urgente.
   *
   * Ahora entran todos los que alguna vez compraron y el umbral solo pinta.
   */
  const franja = (dias: number): DireccionALlamar['urgencia'] => {
    if (dias >= urgente) return 'urgente'
    if (dias >= aviso) return 'aviso'

    return 'al-dia'
  }

  const armar = (canal: Canal): DireccionALlamar[] =>
    [...candidatas[canal].values()]
      .map((c) => {
        const ficha = porId.get(c.clienteId)!
        const d = c.direccionId === null ? undefined : direccionPorId.get(c.direccionId)

        return {
          clienteId: c.clienteId,
          nombre: ficha.nombre,
          documento: ficha.documento,
          direccionId: c.direccionId,
          etiqueta: d?.etiqueta ?? null,
          direccion: d === undefined ? null : direccionLegible(d),
          diasSinComprar: c.dias,
          /*
           * `>=` y no `>`: con el umbral en 8, el día 8 YA es urgente. Con `>`
           * esa dirección saldría como aviso y nadie la vería hasta el día
           * siguiente — un día entero de retraso escondido en un símbolo.
           *
           * `aviso` dejó de FILTRAR y quedó solo como el corte entre verde y
           * amarillo. La lista muestra todo el que alguna vez compró, y el
           * umbral decide el color, no quién entra.
           */
          urgencia: franja(c.dias),
          ventaSinDireccion: c.ventaSinDireccion,
          ventaId: c.ventaId,
          cuantasVentas: c.cuantasVentas,
          telefonos: porCliente.get(c.clienteId) ?? [],
        }
      })
      /*
       * La que hace más que no compra, primero: es a donde hay que llamar
       * antes. El nombre y la etiqueta desempatan para que la lista no BAILE
       * entre dos recargas de la misma pantalla — un orden inestable en una
       * lista que se recorre con el dedo hace perder el lugar.
       */
      .sort(
        (a, b) =>
          /*
           * Las filas SIN dirección van al final, siempre.
           *
           * No son una llamada: son ventas que no dicen dónde se entregaron. Y
           * como agrupan lo más viejo del cliente, tenían el número más alto y
           * se quedaban con el primer lugar — el que más se mira— empujando
           * hacia abajo a las puertas que de verdad esperan agua.
           *
           * Ordenarlas por días era además comparar dos cosas distintas en el
           * mismo eje: «hace cuánto que esta puerta no recibe» contra «hace
           * cuánto fue la más reciente de varias ventas sin ubicar».
           */
          Number(a.ventaSinDireccion) - Number(b.ventaSinDireccion) ||
          b.diasSinComprar - a.diasSinComprar ||
          a.nombre.localeCompare(b.nombre, 'es') ||
          (a.etiqueta ?? '').localeCompare(b.etiqueta ?? '', 'es'),
      )

  return { botellones: armar('botellones'), otros: armar('otros') }
}
