import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { clientes, telefonos, ventas } from '@/db/schema'
import { diaEnLaPlanta } from '@/lib/dia'
import { leerParametro } from '@/modules/alertas/parametros'
import { numeroParaWhatsapp } from './whatsapp'

/**
 * Los clientes para llamar — M15.
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
 * ── Dos franjas, porque son dos conversaciones ──────────────────────────────
 *
 * A los cinco días la llamada es una oferta —«¿le mandamos uno?»—. A los ocho
 * es una recuperación. Quien atiende el teléfono no las hace igual, y una lista
 * sola no deja priorizar cuando no hay tiempo de llamar a todos.
 *
 * Los dos números son parámetros y no constantes: son un supuesto del negocio
 * —pregunta 48— y el día que la operación diga otros, se cambian desde la
 * pantalla sin tocar código.
 */

export interface TelefonoParaLlamar {
  numero: string
  etiqueta: string | null
  /** Listo para `wa.me`, o `null` si ese número no tiene WhatsApp. */
  whatsapp: string | null
}

export interface ClienteALlamar {
  clienteId: string
  nombre: string
  documento: string
  diasSinComprar: number
  urgencia: 'aviso' | 'urgente'
  telefonos: TelefonoParaLlamar[]
}

export async function clientesALlamar(hoy: string): Promise<ClienteALlamar[]> {
  const [aviso, urgente] = await Promise.all([
    leerParametro('dias_recompra_aviso'),
    leerParametro('dias_recompra_urgente'),
  ])

  /*
   * La última compra VÁLIDA de cada cliente.
   *
   * Las tres condiciones del `where` son las mismas del índice parcial de la
   * migración 0017, y tienen que seguir siéndolo: si divergen, el índice deja
   * de usarse y la consulta vuelve a ser un scan sin que nada falle.
   *
   *   · `estado = 'confirmada'` — una anulada NO reinicia el reloj. Es el caso
   *     más caro: el cliente figuraría como atendido sin haberse llevado nada,
   *     y justamente quien tuvo un problema es a quien más hay que llamar.
   *   · `tipo = 'producto'` — un servicio no es agua que se acaba.
   *   · `cliente_id IS NOT NULL` — la venta de mostrador no tiene a quién
   *     llamar.
   *
   * El día se calcula «visto desde la planta» y no en UTC: con la base en UTC,
   * una venta de la tarde envejecería un día de más (ver `lib/dia.ts`).
   */
  const ultimas = await db
    .select({
      clienteId: ventas.clienteId,
      dias: sql<string>`min(${hoy}::date - ${diaEnLaPlanta(ventas.createdAt)})`,
    })
    .from(ventas)
    .where(and(eq(ventas.estado, 'confirmada'), eq(ventas.tipo, 'producto')))
    .groupBy(ventas.clienteId)
    .having(sql`min(${hoy}::date - ${diaEnLaPlanta(ventas.createdAt)}) >= ${aviso}`)

  /*
   * Quien nunca compró no aparece, y sale gratis: sin venta no hay fila en este
   * agrupado. No es una recompra, es un cliente nuevo — si entrara, cada alta
   * figuraría como urgente el mismo día de registrarse.
   */
  const candidatos = ultimas.filter((u) => u.clienteId !== null)
  if (candidatos.length === 0) return []

  const ids = candidatos.map((u) => u.clienteId!)

  const fichas = await db
    .select({
      id: clientes.id,
      nombre: clientes.nombre,
      documento: clientes.numeroDocumento,
    })
    .from(clientes)
    .where(and(inArray(clientes.id, ids), eq(clientes.activo, true)))

  /*
   * Los teléfonos de todos en UN viaje, no uno por cliente. Con cuarenta
   * clientes en la lista, lo segundo son cuarenta consultas para pintar una
   * pantalla que se abre todo el día.
   */
  const numeros = await db
    .select({
      clienteId: telefonos.clienteId,
      numero: telefonos.numero,
      etiqueta: telefonos.etiqueta,
    })
    .from(telefonos)
    .where(and(inArray(telefonos.clienteId, ids), eq(telefonos.activo, true)))
    .orderBy(desc(telefonos.createdAt))

  const porCliente = new Map<string, TelefonoParaLlamar[]>()
  for (const t of numeros) {
    const lista = porCliente.get(t.clienteId) ?? []
    lista.push({ numero: t.numero, etiqueta: t.etiqueta, whatsapp: numeroParaWhatsapp(t.numero) })
    porCliente.set(t.clienteId, lista)
  }

  const dias = new Map(candidatos.map((u) => [u.clienteId!, Number(u.dias)]))

  return fichas
    .map((f) => {
      const sinComprar = dias.get(f.id)!

      return {
        clienteId: f.id,
        nombre: f.nombre,
        documento: f.documento,
        diasSinComprar: sinComprar,
        /*
         * `>=` y no `>`: con el umbral en 8, el día 8 YA es urgente. Con `>`
         * ese cliente saldría como aviso y nadie lo vería hasta el día
         * siguiente — un día entero de retraso escondido en un símbolo.
         */
        urgencia: sinComprar >= urgente ? ('urgente' as const) : ('aviso' as const),
        telefonos: porCliente.get(f.id) ?? [],
      }
    })
    /* El que hace más que no compra, primero: es a quien hay que llamar antes. */
    .sort((a, b) => b.diasSinComprar - a.diasSinComprar)
}
