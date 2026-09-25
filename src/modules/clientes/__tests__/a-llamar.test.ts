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

    /* La casa no califica (1 día). El local sí, y por eso esto existe. */
    expect(botellones).toMatchObject([{ etiqueta: 'el local', diasSinComprar: 20 }])
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
  it('cuentan para TODAS las direcciones del cliente, y quedan marcadas', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    await direccionNueva(residencial, 'la casa')
    await direccionNueva(residencial, 'el local')

    const { botellones } = await clientesALlamar(HOY)

    expect(botellones).toHaveLength(2)
    expect(botellones.every((f) => f.diasSinComprar === 20)).toBe(true)
    expect(botellones.every((f) => f.ventaSinDireccion)).toBe(true)
  })

  it('una venta CON dirección más reciente le gana, y la marca desaparece', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { diasSinComprar: 9, ventaSinDireccion: false },
    ])
  })

  it('si la venta sin dirección es la más reciente, ella fija el reloj y marca la fila', async () => {
    await comprar({ cliente: residencial, haceDias: 9 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { diasSinComprar: 9, ventaSinDireccion: true },
    ])
  })

  it('empatadas el mismo día, gana la que SÍ registró dirección', async () => {
    await comprar({ cliente: residencial, haceDias: 9 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 9, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { diasSinComprar: 9, ventaSinDireccion: false },
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

  it('cuando la fila está marcada, apunta a la venta SIN dirección', async () => {
    await comprar({ cliente: residencial, haceDias: 9 })

    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 20, direccionId: casa })

    const [f] = (await clientesALlamar(HOY)).botellones
    const [sinDireccion] = await db
      .select({ id: ventas.id })
      .from(ventas)
      .where(and(eq(ventas.clienteId, residencial), isNull(ventas.direccionId)))

    expect(f!.ventaSinDireccion).toBe(true)
    expect(f!.ventaId).toBe(sinDireccion!.id)
  })
})

describe('un cliente sin ninguna dirección cargada', () => {
  /*
   * No puede desaparecer. Es el mismo criterio que «sin teléfono cargado igual
   * aparece»: la lista existe para mostrar trabajo, y acá el trabajo es cargarle
   * la dirección. Una fila que se va sola es trabajo que nadie ve.
   */
  it('aparece igual, con la dirección en null', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })

    expect((await clientesALlamar(HOY)).botellones).toMatchObject([
      { clienteId: residencial, direccionId: null, diasSinComprar: 20 },
    ])
  })

  it('no se duplica cuando tiene varias ventas viejas', async () => {
    await comprar({ cliente: residencial, haceDias: 20 })
    await comprar({ cliente: residencial, haceDias: 30 })

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(1)
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
     * Éste es el test que justifica el cambio. Con un reloj compartido, el
     * botellón de hace 3 días tapaba la paca de hace 20 y `otros` salía vacío.
     */
    expect(botellones).toHaveLength(0)
    expect(otros).toMatchObject([{ diasSinComprar: 20 }])
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

  it('quien compró anteayer no está: todavía tiene agua', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 2, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(0)
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

  it('subir el aviso saca de la lista a quien ya no califica', async () => {
    const casa = await direccionNueva(residencial, 'la casa')
    await comprar({ cliente: residencial, haceDias: 6, direccionId: casa })

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(1)

    await db.update(parametros).set({ valor: 7 }).where(eq(parametros.clave, 'dias_recompra_aviso'))

    expect((await clientesALlamar(HOY)).botellones).toHaveLength(0)
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
