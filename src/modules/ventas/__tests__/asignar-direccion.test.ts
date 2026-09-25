import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, direcciones, lotes, productos, ventas } from '@/db/schema'
import type { UserContext } from '@/modules/authz/can'
import { botellonesDe } from '@/modules/retornables/conservacion'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { corregirVenta } from '@/modules/ventas/correccion'
import { registrarVenta } from '@/modules/ventas/venta'
import { DIAS_MAXIMOS_HACIA_ATRAS } from '@/modules/ventas/venta'
import { hoyEnLaPlanta } from '@/lib/dia'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Asignarle la dirección a una venta vieja — y que NO se mueva nada más.
 *
 * ── Por qué este archivo existe ─────────────────────────────────────────────
 *
 * Las ventas anteriores a la migración 0022 no dicen a qué dirección se
 * entregaron, y Seguimientos las marca con un asterisco para poder corregirlas.
 * Pero la base **no deja** completarlas con un `UPDATE`: el trigger
 * `solo_anulacion_en_ventas` rechaza cualquier cambio que deje la venta en
 * `confirmada` (RN-VEN-02). El único camino es CORREGIRLA, que anula la vieja y
 * registra una nueva con la misma fecha.
 *
 * Y ahí está el riesgo que este archivo vigila: corregir no es un `UPDATE`
 * barato. Devuelve el producto a los lotes, vuelve a tomarlo con FEFO, y
 * revierte los movimientos de botellón de la original. Si el neto de todo eso
 * no es CERO, asignar una dirección descuadraría el stock o el saldo de
 * envases del cliente — un precio altísimo por completar un dato.
 *
 * Dos lotes con vencimientos distintos a propósito: con uno solo, «volvió al
 * mismo lote» sería cierto por no haber alternativa, y el test no probaría
 * nada.
 */

const HOY = '2026-08-26'
const MOTIVO = 'la venta no registró a qué dirección se entregó'

let productoId: string
let clienteId: string
let casa: string
let local: string
let admin: UserContext

/** El desglose por lote, no solo el total: el total puede cuadrar y el detalle no. */
const stockPorLote = async () =>
  (
    await db
      .select({ id: lotes.id, disponible: lotes.cantidadDisponible })
      .from(lotes)
      .orderBy(asc(lotes.id))
  ).map((l) => `${l.id}:${l.disponible}`)

beforeEach(async () => {
  await resetDb()

  const [producto] = await db
    .insert(productos)
    .values({
      codigo: 'BOT_20L',
      nombre: 'Recarga de botellón de 20 L',
      presentacion: 'botellon',
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })
    .returning()
  productoId = producto!.id

  /* Dos lotes, para que FEFO tenga de dónde elegir y pueda equivocarse. */
  await crearLoteConEntrada(
    { productoId, fechaEmpaque: '2026-08-01', cantidad: 10, tipo: 'produccion', registradoPor: null },
    db,
  )
  await crearLoteConEntrada(
    { productoId, fechaEmpaque: '2026-08-20', cantidad: 10, tipo: 'produccion', registradoPor: null },
    db,
  )

  const [cliente] = await db
    .insert(clientes)
    .values({ nombreLibre: 'Mario Alejandro Crespo', tipoDocumento: 'CC', numeroDocumento: '79123456' })
    .returning()
  clienteId = cliente!.id

  const sesion = await usuarioAutenticado('admin')
  admin = { id: sesion.usuario.id, roles: ['admin'] } as UserContext
})

afterAll(async () => {
  await closeDb()
})

/**
 * Una venta como las de antes de la 0022: con cliente y sin dirección.
 *
 * Se registra ANTES de crear las direcciones porque el CONSTRAINT TRIGGER
 * `ventas_direccion_cuando_el_cliente_tiene` no deja insertarla de otro modo
 * cuando el cliente ya tiene direcciones. El trigger mira la venta, no la
 * dirección, así que cargarlas después deja exactamente el estado de
 * producción.
 */
async function ventaVieja(botellones = { entregados: 0, recibidos: 0 }) {
  const { venta } = await registrarVenta(
    {
      medioDePago: 'efectivo',
      clienteId,
      items: [{ productoId, cantidad: 3 }],
      botellonesEntregados: botellones.entregados,
      botellonesRecibidos: botellones.recibidos,
      hoy: HOY,
    },
    admin.id,
  )

  const [unaCasa] = await db
    .insert(direcciones)
    .values({ clienteId, etiqueta: 'la casa', direccion: 'Calle 5 # 3 - 20' })
    .returning()
  const [unLocal] = await db
    .insert(direcciones)
    .values({ clienteId, etiqueta: 'el local', direccion: 'Carrera 12 # 8 - 04' })
    .returning()

  casa = unaCasa!.id
  local = unLocal!.id

  return venta
}

/** La corrección que SOLO agrega la dirección: todo lo demás va igual. */
const asignarDireccion = (ventaId: string, direccionId: string, extra = {}) =>
  corregirVenta(
    ventaId,
    {
      medioDePago: 'efectivo',
      clienteId,
      direccionId,
      items: [{ productoId, cantidad: 3 }],
      motivo: MOTIVO,
      hoy: HOY,
      ...extra,
    },
    admin,
  )

describe('asignar la dirección no mueve el stock', () => {
  it('el desglose POR LOTE queda idéntico, no solo el total', async () => {
    const vieja = await ventaVieja()
    const antes = await stockPorLote()

    await asignarDireccion(vieja.id, casa)

    /*
     * Éste es el test que justifica el archivo. El total puede cuadrar mientras
     * FEFO devuelve las unidades a un lote y las saca de otro: el inventario
     * diría la verdad y el lote diría una mentira, y eso recién se ve cuando
     * alguien va a buscar físicamente un lote que ya no está.
     */
    expect(await stockPorLote()).toEqual(antes)
  })
})

describe('asignar la dirección no mueve los botellones', () => {
  it('el saldo de envases del cliente queda idéntico', async () => {
    const vieja = await ventaVieja({ entregados: 3, recibidos: 2 })
    const antes = await botellonesDe(clienteId)

    await asignarDireccion(vieja.id, casa, {
      botellonesEntregados: 3,
      botellonesRecibidos: 2,
    })

    expect(await botellonesDe(clienteId)).toBe(antes)
  })
})

describe('qué queda después', () => {
  it('la venta nueva conserva la fecha de la vieja: el reloj no se reinicia', async () => {
    const vieja = await ventaVieja()

    const { venta: nueva } = await asignarDireccion(vieja.id, casa)

    /*
     * Si la corrección le pusiera la fecha de hoy, la dirección quedaría
     * asignada Y el cliente saldría de la lista de seguimientos como si
     * hubiera comprado recién. Se arreglaría un dato rompiendo el otro.
     */
    expect(nueva.createdAt.toISOString()).toBe(vieja.createdAt.toISOString())
    expect(nueva.direccionId).toBe(casa)
  })

  it('la vieja sale de circulación y queda enlazada a la nueva', async () => {
    const vieja = await ventaVieja()

    const { venta: nueva } = await asignarDireccion(vieja.id, local)

    const [anterior] = await db.select().from(ventas).where(eq(ventas.id, vieja.id))

    expect(anterior!.estado).toBe('corregida')
    expect(anterior!.corregidaPorId).toBe(nueva.id)
  })

  it('el total no cambia: se completó un dato, no se editó una venta', async () => {
    const vieja = await ventaVieja()

    const { venta: nueva } = await asignarDireccion(vieja.id, casa)

    expect(nueva.total).toBe(vieja.total)
  })
})

/**
 * ── El lote vencido: el caso REAL, no el de laboratorio ─────────────────────
 *
 * Los lotes viven 30 días (`DIAS_DE_VENCIMIENTO`). Las ventas que hay que
 * corregir son las anteriores a la migración 0022 — en Seguimientos aparecen
 * con 20, 28, 43 días sin recibir. O sea que su lote **ya venció**.
 *
 * Y `asignarFifo` filtra `fechaVencimiento >= hoy`: no reparte lo vencido, y
 * hace bien. El problema es contra qué «hoy» compara. En `registrarVentaEn`:
 *
 *     const fechaDeEvaluacion = datos.ocurrioEn ?? datos.hoy
 *
 * Así que una corrección sin `ocurrioEn` hereda la fecha vieja para la VENTA
 * pero evalúa los lotes contra HOY. Devuelve tres unidades a un lote vencido y
 * después pide tres a un stock donde ese lote ya no existe.
 */
describe('una venta vieja, sobre un lote que ya venció', () => {
  const DENTRO_DE_UN_MES = '2026-09-25'

  it('sin `ocurrioEn`, la corrección rebota: FEFO mira HOY y el lote ya venció', async () => {
    const vieja = await ventaVieja()

    await expect(
      asignarDireccion(vieja.id, casa, { hoy: DENTRO_DE_UN_MES }),
    ).rejects.toThrow(/STOCK_INSUFICIENTE|quedan/)
  })

  it('con `ocurrioEn` en la fecha de la venta, FEFO vuelve a ver su lote', async () => {
    const vieja = await ventaVieja()
    const antes = await stockPorLote()

    const { venta: nueva } = await asignarDireccion(vieja.id, casa, {
      hoy: DENTRO_DE_UN_MES,
      ocurrioEn: HOY,
    })

    /*
     * Ésta es la forma correcta de asignar la dirección: se le dice a la
     * corrección CUÁNDO ocurrió, y entonces evalúa los lotes como se evaluaban
     * ese día. El stock por lote queda idéntico y la venta conserva su fecha.
     */
    expect(await stockPorLote()).toEqual(antes)
    expect(nueva.createdAt.toISOString().slice(0, 10)).toBe(HOY)
    expect(nueva.direccionId).toBe(casa)
  })
})

/**
 * ── El tope de 90 días: el límite duro del lápiz ────────────────────────────
 *
 * `ocurrioEn` es obligatorio para que FEFO evalúe los lotes en su momento (ver
 * arriba), pero pasa por `exigirFechaRegistrable`, que aplica el tope de
 * RN-VEN-14: `DIAS_MAXIMOS_HACIA_ATRAS = 90`.
 *
 * O sea que el lápiz tiene un alcance: **una venta de más de 90 días no se
 * puede corregir**. Y eso no es un bug a sortear — es la regla que evita que
 * alguien reescriba un trimestre ya cerrado. La pantalla tiene que DECIRLO en
 * vez de ofrecer un botón que rebota.
 */
describe('el alcance del lápiz', () => {
  /*
   * La fecha se calcula desde `hoyEnLaPlanta()` y NO se escribe fija.
   *
   * `exigirFechaRegistrable` llama al reloj adentro en vez de recibir el `hoy`
   * que le inyecta el resto del módulo, así que el tope se mide contra el
   * calendario REAL. Un `ocurrioEn: '2026-05-01'` escrito a mano pasaría hoy y
   * fallaría en marzo — la clase de test que se rompe sin que nadie toque el
   * código.
   */
  const haceDias = (dias: number) => {
    const d = new Date(`${hoyEnLaPlanta()}T12:00:00-05:00`)
    d.setDate(d.getDate() - dias)

    return d.toISOString().slice(0, 10)
  }

  it('una venta de más de 90 días no se puede corregir, y el motivo es explícito', async () => {
    const vieja = await ventaVieja()

    await expect(
      asignarDireccion(vieja.id, casa, { ocurrioEn: haceDias(DIAS_MAXIMOS_HACIA_ATRAS + 30) }),
    ).rejects.toThrow(/más de 90 días/)
  })

  it('justo dentro del tope sí se puede', async () => {
    const vieja = await ventaVieja()

    await expect(
      asignarDireccion(vieja.id, casa, { ocurrioEn: haceDias(DIAS_MAXIMOS_HACIA_ATRAS) }),
    ).resolves.toBeTruthy()
  })
})
