import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { clientes, productos, ventas } from '@/db/schema'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado, direccionDe } from '@/test/fixtures'

/**
 * El orden del listado de ventas — RN-VEN-14 + RN-VEN-16.
 *
 * ── Qué se vigila acá ───────────────────────────────────────────────────────
 *
 * Dos promesas que la ficha del cliente hace por escrito —«de la más reciente a
 * la más vieja»— y que el `ORDER BY` tiene que sostener:
 *
 *   1. El orden lo manda la fecha DEL HECHO, y entre ventas del mismo día manda
 *      cuál se cargó después.
 *   2. Corregir una venta NO la mueve de lugar. Una corrección arregla un tipeo;
 *      que la venta salte al tope dejaría la lista contando el orden en que
 *      alguien arregló cosas y no el orden en que el cliente compró.
 *
 * ── Por qué hacía falta una columna ─────────────────────────────────────────
 *
 * `ocurrioEn` ancla la venta al MEDIODÍA de la planta (`exigirFechaRegistrable`).
 * Dos ventas cargadas con la misma fecha pasada quedan con el mismo instante al
 * microsegundo, y `ORDER BY created_at DESC` sobre filas empatadas no tiene
 * ningún orden definido: Postgres devuelve lo que le queda más cómodo, y eso
 * cambia cuando la tabla se escribe. Medido en `aquazaku_dev`: una venta recién
 * creada aparecía DEBAJO de dos más viejas del mismo día.
 *
 * `primer_registro_en` es el desempate, y se hereda en la corrección por la
 * promesa 2.
 */

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let productoId: string
let clienteId: string
let direccionId: string

const HOY = new Date().toISOString().slice(0, 10)

/** Un día que ya pasó, visto desde la planta. */
const AYER = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
  new Date(Date.now() - 86_400_000),
)

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

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

  await crearLoteConEntrada(
    { productoId, fechaEmpaque: HOY, cantidad: 500, tipo: 'produccion', registradoPor: null },
    db,
  )

  const [cliente] = await db
    .insert(clientes)
    .values({ nombreLibre: 'Yeimy', verificacionEstado: 'pendiente' })
    .returning()
  clienteId = cliente!.id
  direccionId = await direccionDe(clienteId)
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

/** Una venta de este cliente, por `cantidad` botellones. */
const vender = async (cantidad: number, extra: Record<string, unknown> = {}) => {
  const res = await comoAdmin({
    method: 'POST',
    url: '/ventas',
    payload: {
      medioDePago: 'efectivo',
      clienteId,
      direccionId,
      items: [{ productoId, cantidad }],
      ...extra,
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json().venta as { id: string; createdAt: string }
}

/** La lista como la ve la ficha del cliente: ids, de arriba para abajo. */
const listado = async () => {
  const res = await comoAdmin({ method: 'GET', url: `/ventas?clienteId=${clienteId}` })
  expect(res.statusCode).toBe(200)
  return (res.json() as { id: string }[]).map((v) => v.id)
}

describe('GET /ventas ordena por la fecha del hecho', () => {
  /*
   * Las tres van con `ocurrioEn` el MISMO día: es el caso que empata el
   * `created_at` al mediodía y el único donde el desempate se ve.
   */
  it('entre ventas del mismo día, la cargada después va primero', async () => {
    const primera = await vender(1, { ocurrioEn: AYER })
    const segunda = await vender(2, { ocurrioEn: AYER })
    const tercera = await vender(3, { ocurrioEn: AYER })

    expect(await listado()).toEqual([tercera.id, segunda.id, primera.id])
  })

  /*
   * El día manda sobre el momento de carga: una venta de ayer cargada recién
   * NO le gana a una de hoy cargada antes. Es lo que separa «cuándo compró» de
   * «cuándo lo tipearon», y es la razón de ser de `ocurrioEn` (RN-VEN-14).
   */
  it('una venta vieja cargada recién no se trepa al tope', async () => {
    const deHoy = await vender(1)
    const deAyer = await vender(2, { ocurrioEn: AYER })

    expect(await listado()).toEqual([deHoy.id, deAyer.id])
  })

  it('corregir una venta no la mueve de lugar', async () => {
    const primera = await vender(1, { ocurrioEn: AYER })
    const segunda = await vender(2, { ocurrioEn: AYER })
    const tercera = await vender(3, { ocurrioEn: AYER })

    expect(await listado()).toEqual([tercera.id, segunda.id, primera.id])

    /*
     * Se corrige la del MEDIO: es la única posición donde un salto se ve en los
     * dos sentidos. Corregir la primera o la última podría quedar en su lugar
     * por casualidad.
     */
    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${segunda.id}/correccion`,
      payload: {
        medioDePago: 'efectivo',
        clienteId,
        direccionId,
        items: [{ productoId, cantidad: 5 }],
        motivo: 'se tipearon 2 botellones y fueron 5',
      },
    })
    expect(res.statusCode).toBe(201)
    const corregida = res.json().venta as { id: string }

    /*
     * La vieja sale del listado (`estado='corregida'`) y la nueva ocupa su
     * lugar EXACTO — no el tope.
     */
    expect(await listado()).toEqual([tercera.id, corregida.id, primera.id])
  })
})

/**
 * El mecanismo, aparte del orden que produce.
 *
 * ── Por qué estos dos tests existen ─────────────────────────────────────────
 *
 * Los tres de arriba miran la lista, que es la promesa. Pero dos de ellos pasan
 * incluso SIN el desempate: medido con ablación, quitando
 * `desc(ventas.primerRegistroEn)` del `ORDER BY` siguen verdes. No porque el
 * orden esté bien, sino porque en una tabla recién truncada el plan devuelve el
 * orden de inserción por casualidad.
 *
 * Un test que no puede morir no prueba nada. Estos dos miran la columna y no la
 * lista: son independientes del plan, y mueren en el acto si la columna deja de
 * guardar lo que tiene que guardar.
 */
describe('primer_registro_en', () => {
  const columnaDe = async (ventaId: string) => {
    const [fila] = await db
      .select({ createdAt: ventas.createdAt, primerRegistroEn: ventas.primerRegistroEn })
      .from(ventas)
      .where(eq(ventas.id, ventaId))
    return fila!
  }

  /*
   * Es la razón de ser de la columna: `ocurrioEn` manda sobre `createdAt` y NO
   * sobre esta. Si las dos quedaran al mediodía, no habría con qué desempatar.
   */
  it('guarda el instante real aunque `ocurrioEn` ancle `createdAt` al mediodía', async () => {
    const venta = await vender(1, { ocurrioEn: AYER })
    const { createdAt, primerRegistroEn } = await columnaDe(venta.id)

    // `createdAt` al mediodía de la planta: 12:00 en Bogotá es 17:00 UTC.
    expect(createdAt.toISOString()).toMatch(/T17:00:00/)

    // La otra lleva la hora de VERDAD, que es ahora y no el mediodía de ayer.
    expect(primerRegistroEn.getTime()).toBeGreaterThan(createdAt.getTime())
    expect(Date.now() - primerRegistroEn.getTime()).toBeLessThan(60_000)
  })

  it('la corrección lo hereda exacto, al microsegundo', async () => {
    const venta = await vender(1, { ocurrioEn: AYER })
    const antes = await columnaDe(venta.id)

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${venta.id}/correccion`,
      payload: {
        medioDePago: 'efectivo',
        clienteId,
        direccionId,
        items: [{ productoId, cantidad: 4 }],
        motivo: 'se tipeó 1 botellón y fueron 4',
      },
    })
    expect(res.statusCode).toBe(201)

    const despues = await columnaDe(res.json().venta.id)

    /*
     * `toEqual` sobre el `Date` y no `getTime()`: la igualdad tiene que ser
     * exacta. Un desempate «parecido» no desempata — si la nueva queda un
     * microsegundo arriba, salta de lugar igual.
     */
    expect(despues.primerRegistroEn).toEqual(antes.primerRegistroEn)
  })
})
