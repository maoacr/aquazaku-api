import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, lineasDeVenta, parametros, productos, telefonos, ventas } from '@/db/schema'
import { clientesALlamar } from '@/modules/clientes/a-llamar'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'

/**
 * Los clientes para llamar — M15.
 *
 * ── Qué vigila este archivo ─────────────────────────────────────────────────
 *
 * Un botellón de casa dura alrededor de una semana. Pasada esa semana el
 * cliente no «está por pedir»: ya se le acabó, y o llamó a otra planta o está
 * sin agua. El dato para verlo venir siempre estuvo —la fecha de la última
 * venta— y nadie lo miraba.
 *
 * Lo que puede salir mal acá no es que la lista salga vacía: es que salga con
 * la gente equivocada. Llamar a alguien que compró ayer quema la confianza en
 * la lista, y a la tercera vez nadie la abre.
 */

const HOY = '2026-09-10'

let residencial: string
let comercial: string
let productoId: string
let loteId: string

/**
 * Una venta con fecha, que es lo que este módulo mide.
 *
 * La venta y su línea van en UNA transacción porque la base lo exige así:
 * `ventas_producto_con_lineas` es un CONSTRAINT TRIGGER diferido que corre en
 * el COMMIT. Una venta de producto sin líneas tiene un total que no sale de
 * ningún lado, y el trigger no deja que exista ni por un instante.
 */
async function ventaDe(
  clienteId: string,
  haceDias: number,
  extra: { estado?: 'confirmada' | 'anulada' } = {},
) {
  const cuando = new Date(`${HOY}T12:00:00Z`)
  cuando.setUTCDate(cuando.getUTCDate() - haceDias)

  /*
   * Anular exige quién, cuándo y por qué — el CHECK `ventas_anulacion_completa`
   * no acepta media anulación. Una venta «anulada» sin motivo es un agujero en
   * la caja que nadie puede explicar tres meses después.
   */
  const anulacion =
    extra.estado === 'anulada'
      ? { anuladaEn: cuando, motivoAnulacion: 'se arrepintió en el mostrador' }
      : {}

  await db.transaction(async (tx) => {
    const [venta] = await tx
      .insert(ventas)
      .values({
        clienteId,
        medioDePago: 'efectivo',
        total: '10000.00',
        createdAt: cuando,
        ...extra,
        ...anulacion,
      })
      .returning()

    await tx.insert(lineasDeVenta).values({
      ventaId: venta!.id,
      productoId,
      loteId,
      cantidad: 1,
      precioListaAplicado: '10000.00',
      precioMinimoAplicado: '8000.00',
      precioFinal: '10000.00',
    })
  })
}

/** Un recargo por daño de base: no lleva líneas, y no es una compra de agua. */
async function recargoDe(clienteId: string, haceDias: number) {
  const cuando = new Date(`${HOY}T12:00:00Z`)
  cuando.setUTCDate(cuando.getUTCDate() - haceDias)

  await db.insert(ventas).values({
    clienteId,
    medioDePago: 'efectivo',
    tipo: 'dano_base',
    total: '50000.00',
    createdAt: cuando,
  })
}

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

  const lote = await crearLoteConEntrada(
    { productoId, fechaEmpaque: HOY, cantidad: 500, tipo: 'produccion', registradoPor: null },
    db,
  )
  loteId = lote.id

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

describe('quién entra en la lista', () => {
  it('quien compró anteayer no está: todavía tiene agua', async () => {
    await ventaDe(residencial, 2)

    expect(await clientesALlamar(HOY)).toHaveLength(0)
  })

  it('a los 6 días es un aviso: la llamada es una oferta', async () => {
    await ventaDe(residencial, 6)

    const lista = await clientesALlamar(HOY)

    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ clienteId: residencial, diasSinComprar: 6, urgencia: 'aviso' })
  })

  it('a los 10 días es urgente: ya compró en otro lado o está sin agua', async () => {
    await ventaDe(residencial, 10)

    expect(await clientesALlamar(HOY)).toMatchObject([{ urgencia: 'urgente', diasSinComprar: 10 }])
  })

  /*
   * El borde exacto, porque es donde una comparación mal puesta no se nota: con
   * `urgente = 8`, el día 8 YA es urgente. Si fuera `>` en vez de `>=`, este
   * cliente saldría como aviso y nadie lo vería hasta el día siguiente.
   */
  it('el día del umbral ya es urgente, no el siguiente', async () => {
    await ventaDe(residencial, 8)

    expect(await clientesALlamar(HOY)).toMatchObject([{ urgencia: 'urgente' }])
  })

  it('el día anterior al umbral todavía es aviso', async () => {
    await ventaDe(residencial, 7)

    expect(await clientesALlamar(HOY)).toMatchObject([{ urgencia: 'aviso' }])
  })
})

describe('qué cuenta como haber comprado', () => {
  /*
   * Una venta anulada NO reinicia el reloj. Es el caso que más caro sale: el
   * cliente aparecería como atendido sin haberse llevado nada, y justamente
   * quien tuvo un problema con su pedido es a quien más hay que llamar.
   */
  it('una venta anulada no cuenta como compra', async () => {
    await ventaDe(residencial, 20)
    await ventaDe(residencial, 1, { estado: 'anulada' })

    expect(await clientesALlamar(HOY)).toMatchObject([{ diasSinComprar: 20 }])
  })

  /*
   * Un recargo por daño de base no es agua que se acaba: es una deuda. Si
   * contara, cobrarle a alguien el daño de una base lo sacaría de la lista de
   * llamadas justo cuando más razón hay para llamarlo.
   */
  it('un recargo por daño de base no cuenta como compra', async () => {
    await ventaDe(residencial, 20)
    await recargoDe(residencial, 1)

    expect(await clientesALlamar(HOY)).toMatchObject([{ diasSinComprar: 20 }])
  })

  it('manda la última compra válida, no la primera', async () => {
    await ventaDe(residencial, 30)
    await ventaDe(residencial, 9)

    expect(await clientesALlamar(HOY)).toMatchObject([{ diasSinComprar: 9 }])
  })

  /*
   * Quien nunca compró no es una recompra: es un cliente nuevo. Si entrara,
   * cada alta aparecería como urgente el mismo día de registrarse y la lista
   * se llenaría de gente a la que no hay nada que recordarle.
   */
  it('quien nunca compró no aparece', async () => {
    expect(await clientesALlamar(HOY)).toHaveLength(0)
  })

  it('un cliente desactivado no aparece', async () => {
    await ventaDe(residencial, 20)
    await db.update(clientes).set({ activo: false }).where(eq(clientes.id, residencial))

    expect(await clientesALlamar(HOY)).toHaveLength(0)
  })
})

describe('el orden', () => {
  /*
   * El que hace más que no compra, primero. La lista existe para decidir a
   * quién llamar cuando no hay tiempo de llamar a todos.
   */
  it('los más viejos arriba', async () => {
    await ventaDe(residencial, 6)
    await ventaDe(comercial, 15)

    const lista = await clientesALlamar(HOY)

    expect(lista.map((c) => c.diasSinComprar)).toEqual([15, 6])
  })
})

describe('a qué número llamar', () => {
  it('trae los teléfonos activos del cliente', async () => {
    await ventaDe(residencial, 10)
    await db
      .insert(telefonos)
      .values({ clienteId: residencial, numero: '300 123 4567', etiqueta: 'el celular' })

    const [cliente] = await clientesALlamar(HOY)

    expect(cliente!.telefonos).toMatchObject([{ numero: '300 123 4567', etiqueta: 'el celular' }])
  })

  it('un teléfono desactivado no se ofrece: nadie tiene que llamar ahí', async () => {
    await ventaDe(residencial, 10)
    await db
      .insert(telefonos)
      .values({ clienteId: residencial, numero: '300 123 4567', activo: false })

    const [cliente] = await clientesALlamar(HOY)

    expect(cliente!.telefonos).toHaveLength(0)
  })

  /*
   * El enlace viaja armado desde `api`, y en `null` cuando no hay a dónde ir.
   * `wa.me` con un fijo abre WhatsApp y contesta que ese número no existe: un
   * botón que a veces lleva a una pared obliga a comprobar cada vez.
   */
  it('el celular trae su enlace de WhatsApp y el fijo no', async () => {
    await ventaDe(residencial, 10)
    await db.insert(telefonos).values([
      { clienteId: residencial, numero: '300 123 4567', etiqueta: 'el celular' },
      { clienteId: residencial, numero: '605 878 1234', etiqueta: 'el fijo' },
    ])

    const [cliente] = await clientesALlamar(HOY)
    const porEtiqueta = Object.fromEntries(cliente!.telefonos.map((t) => [t.etiqueta, t.whatsapp]))

    expect(porEtiqueta['el celular']).toBe('573001234567')
    expect(porEtiqueta['el fijo']).toBeNull()
  })

  it('sin teléfono cargado igual aparece: hay que saber que falta el dato', async () => {
    await ventaDe(residencial, 10)

    const [cliente] = await clientesALlamar(HOY)

    expect(cliente!.telefonos).toEqual([])
  })
})

/**
 * Los umbrales salen de `parametros`, no de constantes copiadas.
 *
 * Es la regla de [[parametros-no-constantes-copiadas]] hecha test: si el número
 * viviera en el código, cambiarlo desde la pantalla de administración no
 * movería nada y nadie entendería por qué.
 */
describe('los umbrales son configurables', () => {
  it('subir el aviso saca de la lista a quien ya no califica', async () => {
    await ventaDe(residencial, 6)
    expect(await clientesALlamar(HOY)).toHaveLength(1)

    await db
      .update(parametros)
      .set({ valor: 7 })
      .where(eq(parametros.clave, 'dias_recompra_aviso'))

    expect(await clientesALlamar(HOY)).toHaveLength(0)
  })

  it('bajar el urgente cambia la franja de quien ya estaba', async () => {
    await ventaDe(residencial, 6)
    expect(await clientesALlamar(HOY)).toMatchObject([{ urgencia: 'aviso' }])

    await db
      .update(parametros)
      .set({ valor: 6 })
      .where(eq(parametros.clave, 'dias_recompra_urgente'))

    expect(await clientesALlamar(HOY)).toMatchObject([{ urgencia: 'urgente' }])
  })
})
