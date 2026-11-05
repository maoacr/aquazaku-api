import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  clientes,
  direcciones,
  lineasDeVenta,
  productos,
  seguimientosOcultos,
  telefonos,
  ventas,
} from '@/db/schema'
import { diaEnLaPlanta } from '@/lib/dia'
import { leerParametro } from '@/modules/alertas/parametros'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'
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
  /**
   * Cómo lo conocen, cuando no es por su nombre.
   *
   * Viaja aunque la lista no lo pinte: la pantalla de Seguimientos FILTRA por
   * él. Quien se sienta a marcar busca «La Flaca», no «Yeimy Padilla» — y en
   * `clientes.nombre` ese apodo no está, porque esa columna la genera la base
   * concatenando nombres y apellidos (ADR-0006).
   */
  apodo: string | null
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
  /**
   * Desde cuándo está fuera de la lista, si alguien la sacó a mano — RN-CLI-18.
   *
   * `null` en la lista normal: las ocultas no están ahí. Tiene valor solo
   * cuando se piden las ocultas, y es lo que deja decidir si devolverla.
   */
  ocultadaEn: Date | null
  telefonos: TelefonoParaLlamar[]
}

export interface SeguimientosALlamar {
  /** Ventas que incluyeron al menos una recarga de botellón. */
  botellones: DireccionALlamar[]
  /** Ventas que incluyeron algún producto que no es una recarga de botellón. */
  otros: DireccionALlamar[]
  /**
   * Cuántas filas sacó alguien a mano de cada canal — RN-CLI-18.
   *
   * La pantalla lo necesita para decidir si ofrecer «mostrar clientes ocultos»:
   * un botón que aparece siempre, y que la mitad de los días no tiene nada que
   * mostrar, es ruido en una cabecera que se lee de reojo.
   */
  ocultas: { botellones: number; otros: number }
}

/**
 * Los dos canales, escritos.
 *
 * Era `keyof SeguimientosALlamar`, y funcionaba mientras el payload fuera
 * exactamente las dos listas. Al sumarle `ocultas` el atajo dejó de ser cierto:
 * `keyof` pasó a incluir una clave que no es un canal. Los canales son dos
 * porque el negocio tiene dos relojes, no porque el tipo tenga dos campos.
 */
type Canal = 'botellones' | 'otros'

/** Una candidata mientras se arma: la dirección con el reloj que va ganando. */
interface Candidata {
  clienteId: string
  direccionId: string | null
  dias: number
  ventaSinDireccion: boolean
  ventaId: string
  cuantasVentas: number
  /**
   * Cuándo fue la última venta de esta fila, al instante y no al día.
   *
   * Es lo que decide si un ocultamiento sigue en pie: la fila está oculta solo
   * si se ocultó DESPUÉS de su última compra. `dias` no alcanza —es un entero
   * de días— y comparar días con timestamps haría que ocultar y comprar el
   * mismo día dependa de cómo redondea cada lado.
   */
  ultimaVentaEn: Date
}

/** La clave de una fila: cliente, dirección —o su ausencia— y canal. */
export interface FilaDeSeguimiento {
  clienteId: string
  direccionId: string | null
  canal: 'botellones' | 'otros'
}

/** Una fila ocultada a mano, con la clave con la que se la encuentra. */
const claveDeFila = (clienteId: string, direccionId: string | null, canal: string) =>
  `${clienteId}|${direccionId ?? ''}|${canal}`

/**
 * Sacar una fila de la lista de seguimientos — RN-CLI-18.
 *
 * No borra al cliente ni toca un dato suyo: escribe «no me muestres esta fila
 * en esta lista». Y lo hace con una FECHA, así que una venta posterior la
 * devuelve sola (ver la migración 0029 para el argumento completo).
 *
 * `onConflictDoUpdate` y no un insert pelado: volver a ocultar mueve la fecha.
 * Sin eso, la segunda vez tiraría error de unicidad en la cara de alguien que
 * solo apretó una X.
 */
export async function ocultarDeSeguimientos(
  fila: FilaDeSeguimiento,
  ocultadoPor: string | null,
  contexto: ContextoDeAuditoria,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(seguimientosOcultos)
      .values({ ...fila, ocultadoPor, ocultadoEn: new Date() })
      .onConflictDoUpdate({
        target: [
          seguimientosOcultos.clienteId,
          seguimientosOcultos.direccionId,
          seguimientosOcultos.canal,
        ],
        set: { ocultadoEn: new Date(), ocultadoPor },
      })

    /*
     * La fila de bitácora va DENTRO de la transacción, con `tx` — ADR-0007.
     *
     * Un `emit` con `db` acá, mientras la transacción de arriba tiene la fila
     * tomada, se bloquea contra sí mismo y la petición cuelga sin error.
     *
     * Y se audita porque la pregunta «¿por qué nadie llamó a este cliente?»
     * tiene que tener respuesta. La tabla dice quién y cuándo, pero se puede
     * borrar al mostrar de nuevo; `audit_log` no (ADR-0004).
     */
    await emit(
      {
        ...contexto,
        action: 'clientes:ocultar_seguimiento',
        resource: 'clientes',
        resourceId: fila.clienteId,
        result: 'ok',
        payload: { operacion: 'ocultar', ...fila },
      },
      tx,
    )
  })
}

/**
 * Devolver una fila a la lista sin esperar una venta.
 *
 * Borra el registro en vez de marcarlo: lo que importa es que la fila vuelva, y
 * el quién-y-cuándo autoritativo vive en `audit_log` (ADR-0004). Dejar filas
 * «anuladas» acá solo daría dos estados para la misma pregunta.
 */
export async function mostrarEnSeguimientos(
  fila: FilaDeSeguimiento,
  contexto: ContextoDeAuditoria,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(seguimientosOcultos)
      .where(
        and(
          eq(seguimientosOcultos.clienteId, fila.clienteId),
          /*
           * `IS NULL` y no `= null`: la fila sin dirección se identifica por la
           * ausencia, y en SQL `= null` no coincide con nada —ni con null—. Sin
           * esta rama, devolver a la lista una fila sin dirección no borraría
           * nada y la X quedaría pegada.
           */
          fila.direccionId === null
            ? isNull(seguimientosOcultos.direccionId)
            : eq(seguimientosOcultos.direccionId, fila.direccionId),
          eq(seguimientosOcultos.canal, fila.canal),
        ),
      )

    /* Misma acción que ocultar, distinta `operacion` — el patrón de
       `bases:descartar`, que comparte acción con el daño. */
    await emit(
      {
        ...contexto,
        action: 'clientes:ocultar_seguimiento',
        resource: 'clientes',
        resourceId: fila.clienteId,
        result: 'ok',
        payload: { operacion: 'mostrar', ...fila },
      },
      tx,
    )
  })
}

export async function clientesALlamar(
  hoy: string,
  opciones: {
    /**
     * Devolver SOLO las filas ocultas, en vez de solo las visibles.
     *
     * Es el modo que alimenta «mostrar clientes ocultos». Va como opción y no
     * como un endpoint aparte porque la lista es la misma —mismos relojes,
     * mismos teléfonos, mismo orden—: lo único que cambia es de qué lado del
     * ocultamiento se mira.
     */
    soloOcultas?: boolean
  } = {},
): Promise<SeguimientosALlamar> {
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
       *
       * Y ordena por DOS columnas: entre dos ventas del mismo día pasado
       * —empatadas al mediodía por `ocurrioEn`— «la más reciente» no estaba
       * definida, y el lápiz de la fila podía abrir cualquiera de las dos. Ver
       * `primerRegistroEn` en el esquema.
       */
      ventaId: sql<string>`(array_agg(${ventas.id} ORDER BY ${ventas.createdAt} DESC, ${ventas.primerRegistroEn} DESC))[1]`,
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
      /*
       * El instante de la última venta del grupo.
       *
       * `dias` ya dice hace cuánto fue, pero en días enteros y «visto desde la
       * planta». Para decidir si un ocultamiento sigue en pie hace falta el
       * instante: ocultar a las 10 y vender a las 15 del mismo día tiene que
       * devolver la fila, y con días los dos valores serían 0.
       */
      ultimaVentaEn: sql<Date>`max(${ventas.createdAt})`,
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
  /* Sin ventas no hay filas, y sin filas no hay nada oculto: los ceros son
     reales, no un «no sé». */
  if (grupos.length === 0) {
    return { botellones: [], otros: [], ocultas: { botellones: 0, otros: 0 } }
  }

  const ids = [...new Set(grupos.map((g) => g.clienteId!))]

  const [fichas, activas, numeros, ocultos] = await Promise.all([
    db
      .select({
        id: clientes.id,
        nombre: clientes.nombre,
        apodo: clientes.apodo,
        documento: clientes.numeroDocumento,
      })
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

    /*
     * Las filas ocultadas a mano — RN-CLI-18.
     *
     * Viene la tabla entera de los clientes de esta lista, sin comparar fechas
     * todavía: si el ocultamiento sigue en pie se decide por fila, contra la
     * última venta de ESE grupo, y eso recién se sabe más abajo.
     */
    db
      .select()
      .from(seguimientosOcultos)
      .where(inArray(seguimientosOcultos.clienteId, ids)),
  ])

  const porId = new Map(fichas.map((f) => [f.id, f]))

  const ocultoPorClave = new Map(
    ocultos.map((o) => [claveDeFila(o.clienteId, o.direccionId, o.canal), o.ocultadoEn]),
  )

  /**
   * Desde cuándo está oculta esta fila — o `null` si no lo está.
   *
   * ── El corazón del diseño ─────────────────────────────────────────────────
   *
   * El registro de ocultamiento NO se borra cuando el cliente vuelve a comprar.
   * Lo que lo deja sin efecto es la comparación: si la última venta de la fila
   * es POSTERIOR al ocultamiento, la fila vuelve a la lista.
   *
   * Eso cumple «si registra una venta nueva, reaparece» sin un trigger en
   * `ventas` y sin una tarea que barra la tabla. Las dos alternativas pueden
   * fallar en silencio, y lo que dejan cuando fallan es un cliente invisible —
   * que acá significa un cliente al que nadie va a llamar nunca.
   */
  const ocultaDesde = (c: Candidata, canal: Canal): Date | null => {
    const ocultadoEn = ocultoPorClave.get(claveDeFila(c.clienteId, c.direccionId, canal))
    if (ocultadoEn === undefined) return null

    return ocultadoEn > c.ultimaVentaEn ? ocultadoEn : null
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
      ultimaVentaEn: new Date(g.ultimaVentaEn),
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
      /*
       * El filtro va ANTES del map, y no después.
       *
       * Después también funcionaría, pero este `map` arma la dirección legible
       * y los teléfonos de cada fila: filtrar primero evita construir lo que no
       * se va a devolver.
       */
      .filter((c) => (ocultaDesde(c, canal) !== null) === (opciones.soloOcultas === true))
      .map((c) => {
        const ficha = porId.get(c.clienteId)!
        const d = c.direccionId === null ? undefined : direccionPorId.get(c.direccionId)

        return {
          clienteId: c.clienteId,
          nombre: ficha.nombre,
          apodo: ficha.apodo,
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
          /*
           * Solo tiene sentido en el modo `soloOcultas`: en la lista normal es
           * `null` por definición —las ocultas no están ahí— y en la vista de
           * ocultas dice desde cuándo, que es lo que alguien necesita para
           * decidir si la devuelve.
           */
          ocultadaEn: ocultaDesde(c, canal),
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

  /**
   * Cuántas hay ocultas en cada canal.
   *
   * Viaja siempre, incluso en cero, porque la pantalla decide con esto si
   * ofrecer «mostrar clientes ocultos». Un `undefined` la obligaría a tratar
   * «no sé» y «ninguna» como lo mismo.
   *
   * Cuenta las que están ocultas DE VERDAD —las que pasaron la comparación con
   * su última venta— y no las filas de la tabla: un registro cuyo cliente ya
   * volvió a comprar no es una fila oculta, es historia.
   */
  const cuantasOcultas = (canal: Canal): number =>
    [...candidatas[canal].values()].filter((c) => ocultaDesde(c, canal) !== null).length

  return {
    botellones: armar('botellones'),
    otros: armar('otros'),
    ocultas: { botellones: cuantasOcultas('botellones'), otros: cuantasOcultas('otros') },
  }
}
