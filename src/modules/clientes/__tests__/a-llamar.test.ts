import { and, desc, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import {
  clientes,
  direcciones,
  lineasDeVenta,
  parametros,
  productos,
  telefonos,
  ventas,
} from '@/db/schema'
import { clientesALlamar } from '@/modules/clientes/a-llamar'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'

/**
 * Los seguimientos — M15, replanteados por dirección.
 *
 * ── Qué cambió y por qué ────────────────────────────────────────────────────
 *
 * La lista contaba días por CLIENTE. Pero el agua no se entrega a un cliente:
 * se entrega a una puerta. Un cliente con casa y local tiene dos relojes, y el
 * viejo mostraba el más reciente de los dos — así que el local podía estar
 * veinte días seco detrás de una casa que pidió ayer.
 *
 * Ahora la fila ES la dirección. Un cliente con dos direcciones aparece dos
 * veces, y cada fila saca su propia cuenta.
 *
 * ── Y por qué dos canales ───────────────────────────────────────────────────
 *
 * Un botellón de 20 L se acaba; una paca de 80 bolsas de 100 ml no se consume
 * con el mismo reloj. Mezclarlos daba una sola cuenta que no servía para
 * ninguno de los dos. Cada canal cuenta SOLO sus propias ventas.
 */

const HOY = '2026-09-10'

let residencial: string
let comercial: string
let botellon: string
let paca: string
let loteBotellon: string
let lotePaca: string

/** La dirección de un cliente, creada a mano porque acá SON el sujeto. */
async function direccionNueva(clienteId: string, etiqueta: string): Promise<string> {
  const [d] = await db
    .insert(direcciones)
    .values({ clienteId, etiqueta, direccion: `Calle 5 #3-20 (${etiqueta})` })
    .returning()

  return d!.id
}

interface Compra {
  cliente: string
  haceDias: number
  /** `undefined` = la venta vieja, sin dirección registrada (antes de 0022). */
  direccionId?: string | null
  productos?: ('botellon' | 'paca')[]
  estado?: 'confirmada' | 'anulada'
  tipo?: 'producto' | 'dano_base'
}

async function comprar({
  cliente,
  haceDias,
  direccionId,
  productos: cuales = ['botellon'],
  estado,
  tipo,
}: Compra) {
  const cuando = new Date(`${HOY}T12:00:00Z`)
  cuando.setUTCDate(cuando.getUTCDate() - haceDias)

  const anulacion =
    estado === 'anulada'
      ? { anuladaEn: cuando, motivoAnulacion: 'se arrepintió en el mostrador' }
      : {}

  await db.transaction(async (tx) => {
    const [venta] = await tx
      .insert(ventas)
      .values({
        clienteId: cliente,
        direccionId: direccionId ?? null,
        medioDePago: 'efectivo',
        total: '10000.00',
        createdAt: cuando,
        ...(estado ? { estado } : {}),
        ...(tipo ? { tipo } : {}),
        ...anulacion,
      })
      .returning()

    /* Un recargo por daño no lleva líneas: no se despachó nada. */
    if (tipo === 'dano_base') return

    await tx.insert(lineasDeVenta).values(
      cuales.map((p) => ({
        ventaId: venta!.id,
        productoId: p === 'botellon' ? botellon : paca,
        loteId: p === 'botellon' ? loteBotellon : lotePaca,
        cantidad: 1,
        precioListaAplicado: '10000.00',
        precioMinimoAplicado: '8000.00',
        precioFinal: '10000.00',
      })),
    )
  })
}

beforeEach(async () => {
  await resetDb()

  const [b] = await db
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
  botellon = b!.id

  const [p] = await db
    .insert(productos)
    .values({
      codigo: 'P80U_100ML',
      nombre: 'Paca de 80 bolsas de 100ml',
      presentacion: 'paca',
      contenidoMl: 100,
      unidades: 80,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })
    .returning()
  paca = p!.id

  loteBotellon = (
    await crearLoteConEntrada(
      { productoId: botellon, fechaEmpaque: HOY, cantidad: 500, tipo: 'produccion', registradoPor: null },
      db,
    )
  ).id
  lotePaca = (
    await crearLoteConEntrada(
      { productoId: paca, fechaEmpaque: HOY, cantidad: 500, tipo: 'produccion', registradoPor: null },
      db,
    )
  ).id

  const [uno] = await db
    .insert(clientes)
    .values({ nombreLibre: 'Yeimy Padilla', tipoDocumento: 'CC', numeroDocumento: '79123456' })
    .returning()
  residencial = uno!.id

  const [dos] = await db
    .insert(clientes)
    .values({ nombreLibre: 'Tienda La Esquina', tipoDocumento: 'NIT', numeroDocumento: '900123456' })
    .returning()
  comercial = dos!.id
})

afterAll(async () => {
  await closeDb()
})

describe('la fila es la dirección, no el cliente', () => {
  it('un cliente con dos direcciones aparece dos veces, cada una con su cuenta', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    const local = await direccionNueva(residencial, 'el local')

    await comprar({ cliente: residencial, haceDias: 6, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 20, direccionId: local })

    const { botellones } = await clientesALlamar(HOY)

    expect(botellones).toHaveLength(2)
    expect(botellones.map((f) => [f.etiqueta, f.diasSinComprar])).toEqual([
      ['el local', 20],
      ['la casa', 6],
    ])
  })

  it('la dirección que pidió ayer NO esconde a la que lleva veinte días', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    const local = await direccionNueva(residencial, 'el local')

    await comprar({ cliente: residencial, haceDias: 1, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 20, direccionId: local })

    const { botellones } = await clientesALlamar(HOY)

    /*
     * El bug que motivó todo el cambio: con una fila por cliente, el local
     * llevaba veinte días seco detrás de una casa que pidió ayer. Las dos
     * direcciones aparecen, cada una con SU reloj y su franja.
     */
    expect(botellones.map((f) => [f.etiqueta, f.diasSinComprar, f.urgencia])).toEqual([
      ['el local', 20, 'urgente'],
      ['la casa', 1, 'al-dia'],
    ])
  })

  it('una dirección desactivada no se llama: no se entrega ahí', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await db.update(direcciones).set({ activa: false }).where(eq(direcciones.id, casa))

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(0)
  })

  it('un cliente desactivado no aparece', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await db.update(clientes).set({ activo: false }).where(eq(clientes.id, residencial))

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(0)
  })

  it('la dirección viaja legible y con su etiqueta: es lo que se lee en la lista', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })

    const [fila] = (await clientesALlamar(HOY)).botellones

    expect(fila).toMatchObject({
      clienteId: residencial,
      nombre: 'Yeimy Padilla',
      direccionId: casa,
      etiqueta: 'la casa',
    })
    expect(fila!.direccion).toContain('Calle 5 #3-20')
  })
})

/**
 * ── El orden de estos tests NO es cosmético ─────────────────────────────────
 *
 * En todos, la venta SIN dirección se inserta ANTES de crear las direcciones.
 * No es estilo: es la única forma de llegar a ese estado.
 *
 * El CONSTRAINT TRIGGER `ventas_direccion_cuando_el_cliente_tiene` (migración
 * 0023) impide insertar una venta sin `direccion_id` para un cliente que ya
 * tiene direcciones activas. Y hace bien: ninguna venta NUEVA puede nacer así.
 *
 * Pero las viejas existen —14 en la base de desarrollo el día que se escribió
 * esto— porque el trigger mira la VENTA, no la dirección: cargar una dirección
 * después no revalida nada. Insertar la venta mientras el cliente todavía no
 * tiene direcciones deja exactamente el estado de producción, sin desactivar la
 * restricción ni tocar la base con `ALTER TABLE`.
 *
 * Si alguien reordena estas líneas «para que se lean mejor», Postgres va a
 * tirar `la venta X es de un cliente con direcciones cargadas y no dice a cuál
 * se entrega`. Ese error es este comentario.
 */
describe('las ventas viejas, sin dirección registrada', () => {
  it('dan UNA fila, no una por cada dirección del cliente', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    await direccionNueva(residencial, 'la casa')
    await direccionNueva(residencial, 'el local')

    const { botellones } = await clientesALlamar(HOY)

    /*
     * Ésta es la regla que reemplazó al reparto.
     *
     * Antes esta venta generaba DOS filas, una por dirección, cada una con el
     * mismo número al lado de una puerta distinta. Se leía como «acá se
     * entregó hace 20 días» dos veces, y eso nadie lo sabe: la venta no lo
     * dice. Dos filas idénticas reclamando dos puertas es peor que una fila
     * que admite no saber.
     */
    expect(botellones).toHaveLength(1)
    expect(botellones[0]).toMatchObject({
      clienteId: residencial,
      direccionId: null,
      etiqueta: null,
      direccion: null,
      diasSinComprar: 20,
      ventaSinDireccion: true,
    })
  })

  it('conviven con las direcciones que SÍ tienen ventas propias, como filas aparte', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    const { botellones } = await clientesALlamar(HOY)

    /*
     * Son dos hechos distintos y merecen dos filas: «en la casa se entregó hace
     * 9 días» y «hay una venta de hace 20 que no dice dónde se entregó». La
     * segunda no es una llamada: es un dato que falta, y la pantalla ofrece
     * completarlo ahí mismo.
     */
    expect(botellones).toHaveLength(2)
    /* La sin dirección va ÚLTIMA aunque su número sea mayor: no es una llamada. */
    expect(botellones.map((f) => [f.etiqueta, f.diasSinComprar, f.ventaSinDireccion])).toEqual([
      ['la casa', 9, false],
      [null, 20, true],
    ])
  })

  it('varias ventas viejas del mismo cliente son UNA fila, con la más reciente', async () => {
    await comprar({ cliente: residencial, haceDias: 30 })
    await comprar({ cliente: residencial, haceDias: 20 })

    await direccionNueva(residencial, 'la casa')

    const { botellones } = await clientesALlamar(HOY)

    expect(botellones).toHaveLength(1)
    expect(botellones[0]!.diasSinComprar).toBe(20)
  })

  it('no se infiere nada aunque el cliente tenga UNA sola dirección', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    await direccionNueva(residencial, 'la casa')

    /*
     * Con una sola dirección la deducción sería tentadora —no hay otro lugar
     * posible— pero la venta sigue sin decirlo, y la pantalla mostraría una
     * dirección que nadie registró. O tiene dirección o no la tiene.
     */
    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { direccionId: null, ventaSinDireccion: true },
    ])
  })
})

describe('cuál venta fijó el reloj', () => {
  /*
   * El id viaja porque es sobre esa venta que se actúa: cuando no registró
   * dirección, la pantalla ofrece corregirla para asignársela. Sin el id, la
   * fila sabría que hay algo que arreglar y no cuál.
   */
  it('es la venta MÁS RECIENTE del grupo, no la primera', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({ cliente: residencial, haceDias: 30, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    const [f] = (await clientesALlamar(HOY)).botellones
    const [reciente] = await db
      .select({ id: ventas.id })
      .from(ventas)
      .where(eq(ventas.clienteId, residencial))
      .orderBy(desc(ventas.createdAt))
      .limit(1)

    expect(f!.diasSinComprar).toBe(9)
    expect(f!.ventaId).toBe(reciente!.id)
  })

  it('la fila marcada apunta a la venta SIN dirección, que es la que hay que corregir', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    const marcada = (await clientesALlamar(HOY)).botellones.find((f) => f.ventaSinDireccion)
    const [sinDireccion] = await db
      .select({ id: ventas.id })
      .from(ventas)
      .where(and(eq(ventas.clienteId, residencial), isNull(ventas.direccionId)))

    expect(marcada!.ventaId).toBe(sinDireccion!.id)
  })
})

describe('un cliente sin NINGUNA dirección cargada', () => {
  /*
   * Con el reparto, este caso necesitaba una rama aparte: había que decidir qué
   * hacer cuando no existía ninguna dirección a la que repartir. Sin reparto
   * dejó de ser un caso especial —la venta no dice dónde fue, y punto— pero el
   * test se queda: lo que protege es que la fila NO desaparezca.
   *
   * Es el mismo criterio que «sin teléfono cargado igual aparece»: la lista
   * existe para mostrar trabajo, y acá el trabajo es cargarle la dirección. Una
   * fila que se va sola es trabajo que nadie ve.
   */
  it('aparece igual, sin dirección y marcada', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { clienteId: residencial, direccionId: null, diasSinComprar: 20, ventaSinDireccion: true },
    ])
  })
})

/**
 * ── El tacho no se llama ────────────────────────────────────────────────────
 *
 * «POS Aquazaku» no es un cliente: es el cajón donde caen las ventas a gente
 * que no quiso registrarse. Adentro conviven cientos de personas, así que no
 * hay a quién llamar.
 *
 * Y aparecía PRIMERO en las dos listas, porque es el que más ventas tiene y
 * las más viejas: el lugar que más se mira, ocupado por la única fila que no se
 * puede accionar.
 *
 * Se excluye por la columna `es_mostrador` y no por el nombre. En una sola
 * conversación con la operación ese cliente apareció escrito de tres formas
 * distintas — filtrar por texto deja el ruido a una renombrada de distancia, y
 * al volver no falla nada: simplemente reaparece.
 */
/**
 * ── La fila sin dirección cuenta VENTAS, no días ────────────────────────────
 *
 * El error que la operación reportó tres veces: corregir una venta hacía SUBIR
 * el número. 40, luego 47, luego 54. Se veía como si corregir no hubiera
 * servido — o peor, como si hubiera empeorado algo.
 *
 * No estaba roto: esa fila agrupa TODAS las ventas viejas del cliente y
 * mostraba los días de la más reciente. Al corregir esa, salía del grupo y la
 * fila pasaba a la siguiente, más vieja. El número subía porque la fila ya era
 * de otra venta.
 *
 * El dato que esa fila tiene que dar es CUÁNTAS faltan. Ese baja: 3, 2, 1, y la
 * fila se va.
 */
describe('dónde va la fila sin dirección', () => {
  it('al final, aunque su número sea el más alto', async () => {
    /* La vieja sin dirección: se inserta antes de que exista la dirección. */
    await comprar({ cliente: residencial, haceDias: 60 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    const { botellones } = await clientesALlamar(HOY)

    /*
     * Ordenadas por días, la de 60 iría primera. Pero no es una llamada: es
     * una venta que no dice dónde se entregó, y ocupaba el lugar que más se
     * mira empujando hacia abajo a las puertas que de verdad esperan agua.
     */
    expect(botellones.map((f) => [f.ventaSinDireccion, f.diasSinComprar])).toEqual([
      [false, 9],
      [true, 60],
    ])
  })
})

describe('cuántas ventas hay detrás de una fila', () => {
  it('la fila sin dirección cuenta todas las ventas viejas del cliente', async () => {
    await comprar({ cliente: residencial, haceDias: 40 })
    await comprar({ cliente: residencial, haceDias: 47 })
    await comprar({ cliente: residencial, haceDias: 54 })

    await direccionNueva(residencial, 'la casa')

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { direccionId: null, cuantasVentas: 3, diasSinComprar: 40 },
    ])
  })

  it('una venta con dos productos del mismo canal se cuenta UNA vez', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    /*
     * El `join` con las líneas multiplica la venta por cada producto. Sin
     * `count(distinct)` y sin agrupar por canal, esta fila diría «2 ventas»
     * donde hay una que llevó dos cosas.
     */
    await comprar({
      cliente: residencial,
      haceDias: 20,
      direccionId: casa,
      productos: ['botellon', 'botellon'],
    })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([{ cuantasVentas: 1 }])
  })

  it('cada canal cuenta lo suyo', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 25, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 30, direccionId: casa, productos: ['paca'] })

    const { botellones, otros } = await clientesALlamar(HOY)

    expect(botellones).toMatchObject([{ cuantasVentas: 2 }])
    expect(otros).toMatchObject([{ cuantasVentas: 1 }])
  })

  it('corregir una BAJA el conteo en vez de subir los días', async () => {
    await comprar({ cliente: residencial, haceDias: 40 })
    await comprar({ cliente: residencial, haceDias: 47 })

    const casa = await direccionNueva(residencial, 'la casa')

    expect((await clientesALlamar(HOY)).botellones[0]).toMatchObject({ cuantasVentas: 2 })

    /* Se corrige la más reciente: pasa a la dirección y sale del grupo. */
    const [reciente] = await db
      .select({ id: ventas.id })
      .from(ventas)
      .where(and(eq(ventas.clienteId, residencial), isNull(ventas.direccionId)))
      .orderBy(desc(ventas.createdAt))
      .limit(1)

    await db
      .update(ventas)
      .set({ estado: 'corregida', anuladaEn: new Date(), motivoAnulacion: 'se le asignó dirección' })
      .where(eq(ventas.id, reciente!.id))
    await comprar({ cliente: residencial, haceDias: 40, direccionId: casa })

    const sinDireccion = (await clientesALlamar(HOY)).botellones.find((f) => f.ventaSinDireccion)

    expect(sinDireccion).toMatchObject({ cuantasVentas: 1 })
  })
})

describe('el cliente de mostrador', () => {
  it('no aparece en ninguno de los dos canales', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa, productos: ['paca'] })

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(1)
    expect((await clientesALlamar(HOY)).otros).toHaveLength(1)

    await db.update(clientes).set({ esMostrador: true }).where(eq(clientes.id, residencial))

    const { botellones, otros } = await clientesALlamar(HOY)

    expect(botellones).toHaveLength(0)
    expect(otros).toHaveLength(0)
  })

  it('tampoco cuando su venta no registró dirección', async () => {
    await comprar({ cliente: residencial, haceDias: 40 })
    await db.update(clientes).set({ esMostrador: true }).where(eq(clientes.id, residencial))

    /*
     * La fila «Asignar una dirección» es la que más arriba sale. Si el filtro
     * viviera solo del lado de las direcciones cargadas, el tacho seguiría
     * primero — que es exactamente el síntoma que esto viene a sacar.
     */
    expect((await clientesALlamar(HOY)).botellones).toHaveLength(0)
  })

  it('marcar uno no esconde a los demás', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    const tienda = await direccionNueva(comercial, 'la tienda')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await comprar({ cliente: comercial, haceDias: 15, direccionId: tienda })

    await db.update(clientes).set({ esMostrador: true }).where(eq(clientes.id, residencial))

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { clienteId: comercial, diasSinComprar: 15 },
    ])
  })
})

describe('los dos canales', () => {
  it('el botellón va a `botellones` y la paca a `otros`', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    const tienda = await direccionNueva(comercial, 'la tienda')

    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await comprar({ cliente: comercial, haceDias: 20, direccionId: tienda, productos: ['paca'] })

    const { botellones, otros } = await clientesALlamar(HOY)

    expect(botellones.map((f) => f.clienteId)).toEqual([residencial])
    expect(otros.map((f) => f.clienteId)).toEqual([comercial])
  })

  it('una venta mixta cae en los DOS canales: llevó de las dos cosas', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({
      cliente: residencial,
      haceDias: 20,
      direccionId: casa,
      productos: ['botellon', 'paca'],
    })

    const { botellones, otros } = await clientesALlamar(HOY)

    expect(botellones).toHaveLength(1)
    expect(otros).toHaveLength(1)
  })

  it('cada canal cuenta SOLO sus ventas: es su propio reloj', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({ cliente: residencial, haceDias: 3, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa, productos: ['paca'] })

    const { botellones, otros } = await clientesALlamar(HOY)

    /*
     * Éste es el test que justifica el corte por canal. Con un reloj
     * compartido, la paca de hace 20 días mostraba 3 —el del botellón— y salía
     * en verde: el atraso quedaba invisible.
     */
    expect(botellones).toMatchObject([{ diasSinComprar: 3, urgencia: 'al-dia' }])
    expect(otros).toMatchObject([{ diasSinComprar: 20, urgencia: 'urgente' }])
  })

  it('tres botellones en la misma venta no son tres filas', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({
      cliente: residencial,
      haceDias: 20,
      direccionId: casa,
      productos: ['botellon', 'botellon', 'botellon'],
    })

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(1)
  })
})

describe('qué cuenta como haber comprado', () => {
  it('una venta anulada no reinicia el reloj', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 1, direccionId: casa, estado: 'anulada' })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([{ diasSinComprar: 20 }])
  })

  it('un recargo por daño de base no cuenta como compra', async () => {
    const casa = await direccionNueva(residencial, 'la casa')

    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })
    await comprar({ cliente: residencial, haceDias: 1, tipo: 'dano_base' })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([{ diasSinComprar: 20 }])
  })

  it('quien compró anteayer SÍ está, en verde: la lista es el padrón completo', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 2, direccionId: casa })

    /*
     * Antes esta dirección no existía para nadie hasta ponerse urgente, así que
     * consultar «¿cuándo compró éste?» exigía esperar a que se atrasara. Ahora
     * entra todo el que alguna vez compró y el umbral solo decide el color.
     */
    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { diasSinComprar: 2, urgencia: 'al-dia' },
    ])
  })

  it('quien nunca compró no aparece', async () => {
    await direccionNueva(residencial, 'la casa')

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(0)
  })
})

describe('las dos franjas', () => {
  it('a los 6 días es un aviso; a los 8, urgente', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    const tienda = await direccionNueva(comercial, 'la tienda')

    await comprar({ cliente: residencial, haceDias: 6, direccionId: casa })
    await comprar({ cliente: comercial, haceDias: 8, direccionId: tienda })

    const { botellones } = await clientesALlamar(HOY)

    expect(botellones.map((f) => f.urgencia)).toEqual(['urgente', 'aviso'])
  })

  it('el día anterior al umbral todavía es aviso', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 7, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([{ urgencia: 'aviso' }])
  })

  it('subir el aviso cambia el COLOR, ya no saca de la lista a nadie', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 6, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([{ urgencia: 'aviso' }])

    await db.update(parametros).set({ valor: 7 }).where(eq(parametros.clave, 'dias_recompra_aviso'))

    /*
     * La fila SIGUE ahí. `aviso` dejó de decidir quién entra y quedó solo como
     * el corte entre verde y amarillo — que es lo que siempre debió ser: un
     * umbral de atención, no un filtro de existencia.
     */
    expect((await clientesALlamar(HOY)).botellones).toMatchObject([{ urgencia: 'al-dia' }])
  })
})

describe('a qué número llamar', () => {
  it('cada fila trae los teléfonos activos del cliente, con su WhatsApp', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 10, direccionId: casa })
    await db.insert(telefonos).values([
      { clienteId: residencial, numero: '300 123 4567', etiqueta: 'el celular' },
      { clienteId: residencial, numero: '605 878 1234', etiqueta: 'el fijo' },
      { clienteId: residencial, numero: '300 999 8888', activo: false },
    ])

    const [fila] = (await clientesALlamar(HOY)).botellones
    const porEtiqueta = Object.fromEntries(fila!.telefonos.map((t) => [t.etiqueta, t.whatsapp]))

    expect(fila!.telefonos).toHaveLength(2)
    expect(porEtiqueta['el celular']).toBe('573001234567')
    expect(porEtiqueta['el fijo']).toBeNull()
  })

  it('sin teléfono cargado igual aparece: hay que saber que falta el dato', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 10, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones[0]!.telefonos).toEqual([])
  })
})

describe('el orden', () => {
  it('los más viejos arriba, y a igual día por nombre para que no baile', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    const tienda = await direccionNueva(comercial, 'la tienda')

    await comprar({ cliente: comercial, haceDias: 9, direccionId: tienda })
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    const { botellones } = await clientesALlamar(HOY)

    expect(botellones.map((f) => f.nombre)).toEqual(['Tienda La Esquina', 'Yeimy Padilla'])
  })
})

/**
 * ── Corregir la vieja la funde con la nueva ─────────────────────────────────
 *
 * El caso que reportó la operación, y que la lista tiene que resolver sola:
 *
 *   1. Una venta de hace 40 días sin dirección → fila «Asignar una dirección»,
 *      arriba de todo con 40 días.
 *   2. El cliente compra HOY, y esa venta sí registra su dirección → segunda
 *      fila, abajo, con 0 días.
 *   3. Alguien usa el lápiz y le asigna a la vieja la única dirección del
 *      cliente.
 *
 * A partir de ahí las dos ventas son de la misma puerta, así que son UNA fila,
 * y manda la más reciente: 0 días. La fila de 40 tiene que DESAPARECER — ya no
 * hay nada que hacer ahí, el cliente acaba de comprar.
 *
 * Si no desapareciera, la lista mandaría a llamar a alguien que compró hoy, y
 * el primer lugar de la lista —el que más se mira— estaría ocupado por trabajo
 * que no existe.
 */
describe('cuando la venta vieja recibe su dirección', () => {
  it('la fila vieja desaparece y queda la del día de la compra nueva', async () => {
    /* La vieja, sin dirección: se inserta antes de que exista la dirección. */
    await comprar({ cliente: residencial, haceDias: 40 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 0, direccionId: casa })

    /* Antes de corregir: dos filas, la vieja arriba. */
    const antes = await clientesALlamar(HOY)
    expect(antes.botellones.map((f) => [f.direccionId, f.diasSinComprar])).toEqual([
      [casa, 0],
      [null, 40],
    ])

    /*
     * La corrección de verdad la hace `corregirVenta`, que anula la vieja y
     * registra una nueva con SU MISMA fecha y la dirección puesta. Acá se
     * reproduce ese estado final, que es lo que la lista tiene que leer.
     */
    const [vieja] = await db
      .select({ id: ventas.id })
      .from(ventas)
      .where(and(eq(ventas.clienteId, residencial), isNull(ventas.direccionId)))

    await db
      .update(ventas)
      .set({ estado: 'corregida', anuladaEn: new Date(), motivoAnulacion: 'se le asignó dirección' })
      .where(eq(ventas.id, vieja!.id))
    await comprar({ cliente: residencial, haceDias: 40, direccionId: casa })

    const despues = await clientesALlamar(HOY)

    expect(despues.botellones).toHaveLength(1)
    expect(despues.botellones[0]).toMatchObject({
      direccionId: casa,
      diasSinComprar: 0,
      ventaSinDireccion: false,
      urgencia: 'al-dia',
    })
  })
})
