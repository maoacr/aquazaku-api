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
  urgencia: 'aviso' | 'urgente'
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
}

export async function clientesALlamar(hoy: string): Promise<SeguimientosALlamar> {
  const [aviso, urgente] = await Promise.all([
    leerParametro('dias_recompra_aviso'),
    leerParametro('dias_recompra_urgente'),
  ])

  /*
   * La última compra VÁLIDA por cliente, dirección y presentación.
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
      presentacion: productos.presentacion,
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
    .groupBy(ventas.clienteId, ventas.direccionId, productos.presentacion)

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
      .where(and(inArray(clientes.id, ids), eq(clientes.activo, true))),

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

  const direccionesDe = new Map<string, (typeof activas)[number][]>()
  for (const d of activas) {
    direccionesDe.set(d.clienteId, [...(direccionesDe.get(d.clienteId) ?? []), d])
  }
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
   * Anota un reloj contra una dirección, quedándose con el que manda.
   *
   * Gana el más reciente. Y **a igual día gana la venta que SÍ registró
   * dirección**: si el mismo día hubo una con dirección y una sin, la primera
   * es la que sabe algo, así que la fila no se marca. Sin ese desempate el
   * resultado dependería del orden en que Postgres devolvió las filas.
   */
  const anotar = (canal: Canal, c: Candidata) => {
    const clave = `${c.clienteId}|${c.direccionId ?? ''}`
    const actual = candidatas[canal].get(clave)

    const manda =
      actual === undefined ||
      c.dias < actual.dias ||
      (c.dias === actual.dias && actual.ventaSinDireccion && !c.ventaSinDireccion)

    if (manda) candidatas[canal].set(clave, c)
  }

  for (const g of grupos) {
    const clienteId = g.clienteId!
    if (!porId.has(clienteId)) continue

    const canal: Canal = g.presentacion === 'botellon' ? 'botellones' : 'otros'
    const dias = Number(g.dias)

    if (g.direccionId !== null) {
      /*
       * Una venta a una dirección DESACTIVADA no cuenta para nada: ya no se
       * entrega ahí, y darle su reloj a las direcciones vivas del cliente
       * sería inventar una entrega que no pasó.
       */
      if (direccionPorId.has(g.direccionId)) {
        anotar(canal, {
          clienteId,
          direccionId: g.direccionId,
          dias,
          ventaSinDireccion: false,
          ventaId: g.ventaId,
        })
      }
      continue
    }

    const propias = direccionesDe.get(clienteId) ?? []

    if (propias.length === 0) {
      /*
       * Cliente con compras y sin ninguna dirección cargada. No puede
       * desaparecer: es el mismo criterio que «sin teléfono cargado igual
       * aparece». La lista existe para mostrar trabajo, y acá el trabajo es
       * cargarle la dirección. Una fila que se va sola es trabajo que nadie ve.
       */
      anotar(canal, {
        clienteId,
        direccionId: null,
        dias,
        ventaSinDireccion: true,
        ventaId: g.ventaId,
      })
      continue
    }

    for (const d of propias) {
      anotar(canal, {
        clienteId,
        direccionId: d.id,
        dias,
        ventaSinDireccion: true,
        ventaId: g.ventaId,
      })
    }
  }

  const armar = (canal: Canal): DireccionALlamar[] =>
    [...candidatas[canal].values()]
      .filter((c) => c.dias >= aviso)
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
           */
          urgencia: c.dias >= urgente ? ('urgente' as const) : ('aviso' as const),
          ventaSinDireccion: c.ventaSinDireccion,
          ventaId: c.ventaId,
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
          b.diasSinComprar - a.diasSinComprar ||
          a.nombre.localeCompare(b.nombre, 'es') ||
          (a.etiqueta ?? '').localeCompare(b.etiqueta ?? '', 'es'),
      )

  return { botellones: armar('botellones'), otros: armar('otros') }
}
