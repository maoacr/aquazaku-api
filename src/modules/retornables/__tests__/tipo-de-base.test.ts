import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { bases, clientes, direcciones } from '@/db/schema'
import {
  comprarBases,
  darDeAltaBase,
  descartarBase,
  disponibilidadDeBases,
  disponibilidadPorTipo,
  prestarBase,
  retornarBase,
} from '@/modules/retornables/bases'
import { resetDb } from '@/test/db'

const UN_CONTEXTO = { userId: null, rolEjercido: ['admin'], requestId: 'req-de-prueba' }

/**
 * Dos tipos de base — RN-BAS-14.
 *
 * Aquazaku compró un segundo tipo: el dispensador de agua fría y caliente.
 * Hasta el 11-oct-2026 existía uno solo, la estructura metálica.
 *
 * Lo que este archivo vigila no es que la columna exista —eso lo prueba el
 * schema— sino las tres cosas que pueden romperse en silencio: que el tipo se
 * declare donde nace la base, que los IDs sigan siendo un solo espacio, y que
 * el aviso de compra no sume los dos parques en un número.
 */

let direccionId: string

beforeEach(async () => {
  await resetDb()

  const [cliente] = await db
    .insert(clientes)
    .values({
      nombreLibre: 'Yeimy',
      tipoDocumento: 'CC',
      numeroDocumento: '79123456',
      verificacionEstado: 'verificado',
      verificadoEn: new Date(),
      verificacionMetodo: 'admin_oficial',
    })
    .returning()

  const [direccion] = await db
    .insert(direcciones)
    .values({ clienteId: cliente!.id, etiqueta: 'La casa', direccion: 'Calle 5 #3-20' })
    .returning()
  direccionId = direccion!.id
})

afterAll(async () => {
  await closeDb()
})

describe('el tipo se declara al registrar la base', () => {
  it('el registro de a una guarda el tipo que se le dijo', async () => {
    const dispensador = await darDeAltaBase('0913', 'dispensador', null)
    const estructura = await darDeAltaBase('0914', 'estructura', null)

    expect(dispensador.tipo).toBe('dispensador')
    expect(estructura.tipo).toBe('estructura')
  })

  it('la compra registra las tres del mismo tipo', async () => {
    const compradas = await comprarBases(3, 'dispensador', null)

    expect(compradas).toHaveLength(3)
    expect(compradas.map((b) => b.tipo)).toEqual(['dispensador', 'dispensador', 'dispensador'])
  })

  /*
   * ── La garantía de último recurso ─────────────────────────────────────────
   *
   * La columna es NOT NULL y SIN default, así que un INSERT que no declara el
   * tipo se cae en la base. Eso es lo que hace que un cuarto camino de alta
   * —el que alguien escriba el mes que viene sin leer RN-BAS-14— falle acá y no
   * produzca filas calladas.
   *
   * Un `DEFAULT 'estructura'` habría convertido ese olvido en una estructura
   * metálica para toda la vida de la base.
   */
  it('insertar una base sin tipo lo rechaza la base de datos', async () => {
    await expect(
      // @ts-expect-error -- es justamente lo que el tipo de TS ya no permite
      db.insert(bases).values({ idSticker: '0001' }),
    ).rejects.toThrow(/tipo/i)
  })
})

describe('un solo espacio de IDs', () => {
  /*
   * Lo pidió Aquazaku explícitamente: no dos listas arrancando en 0001. El
   * número identifica; el tipo describe.
   */
  /*
   * ── El orden importa, y por eso el DISPENSADOR va primero ─────────────────
   *
   * La primera versión de este test compraba estructuras y después
   * dispensadores, y pasaba igual con la regla rota: si el consecutivo mirara
   * solo las bases del tipo que se está comprando, las dos estructuras previas
   * seguirían siendo las únicas en la lista y el próximo daría 0003 de todos
   * modos. Lo descubrí ablacionando.
   *
   * Comprando el dispensador PRIMERO, un consecutivo por tipo arrancaría la
   * estructura en 0001 —ya tomado— y la compra se caería.
   */
  it('el consecutivo sigue de largo al cambiar de tipo', async () => {
    await comprarBases(2, 'dispensador', null)
    const estructuras = await comprarBases(2, 'estructura', null)

    expect(estructuras.map((b) => b.idSticker)).toEqual(['0003', '0004'])
  })

  it('y de vuelta: una estructura no reinicia la numeración del dispensador', async () => {
    await darDeAltaBase('0001', 'estructura', null)
    const [dispensador] = await comprarBases(1, 'dispensador', null)

    expect(dispensador!.idSticker).toBe('0002')
  })

  it('el sticker es único ENTRE TIPOS: 0001 no puede ser los dos', async () => {
    await darDeAltaBase('0001', 'estructura', null)

    await expect(darDeAltaBase('0001', 'dispensador', null)).rejects.toMatchObject({
      code: 'STICKER_DUPLICADO',
    })
  })

  /*
   * El número de una base descartada no se recicla, y el tipo no cambia eso: un
   * dispensador descartado puede tener un recargo por daño apuntándole
   * (RN-BAS-08), y darle su número a una estructura nueva volvería ambiguo ese
   * cobro.
   */
  it('el número de una descartada no se reusa, ni para el otro tipo', async () => {
    const [dispensador] = await comprarBases(1, 'dispensador', null)
    await descartarBase(
      dispensador!.id,
      'el compresor dejó de enfriar y no tiene repuesto',
      null,
      UN_CONTEXTO,
    )

    const [nueva] = await comprarBases(1, 'estructura', null)

    expect(dispensador!.idSticker).toBe('0001')
    expect(nueva!.idSticker).toBe('0002')
  })
})

describe('el tipo no cambia en todo el ciclo de vida', () => {
  it('prestar y retornar no lo tocan', async () => {
    const [base] = await comprarBases(1, 'dispensador', null)

    await prestarBase(base!.id, direccionId, null, UN_CONTEXTO)
    await retornarBase(base!.id, null, UN_CONTEXTO)

    const [despues] = await db.select().from(bases).where(eq(bases.id, base!.id))

    expect(despues!.tipo).toBe('dispensador')
  })
})

describe('el aviso de compra no suma los dos parques', () => {
  /*
   * ── El caso que hace falta esta regla ─────────────────────────────────────
   *
   * Veinte estructuras libres y CERO dispensadores libres. Con un solo número
   * —el que había antes de RN-BAS-14— el sistema diría «alcanza», y el día que
   * un cliente pida un dispensador no hay ninguno. El aviso callaría justo
   * cuando hace falta, que es exactamente la falla que RN-BAS-13 ataca.
   */
  it('veinte estructuras libres no tapan que no queda ningún dispensador', async () => {
    await comprarBases(20, 'estructura', null)
    const dispensadores = await comprarBases(2, 'dispensador', null)

    for (const d of dispensadores) {
      await prestarBase(d.id, direccionId, null, UN_CONTEXTO)
    }

    const estructura = await disponibilidadDeBases('estructura')
    const dispensador = await disponibilidadDeBases('dispensador')

    expect(estructura).toMatchObject({ libres: 20, alcanza: true })
    expect(dispensador).toMatchObject({ libres: 0, prestadasEnLaVentana: 2, alcanza: false })
  })

  it('el ritmo de un tipo no cuenta los préstamos del otro', async () => {
    const estructuras = await comprarBases(5, 'estructura', null)
    await comprarBases(5, 'dispensador', null)

    for (const e of estructuras.slice(0, 3)) {
      await prestarBase(e.id, direccionId, null, UN_CONTEXTO)
    }

    expect((await disponibilidadDeBases('estructura')).prestadasEnLaVentana).toBe(3)
    expect((await disponibilidadDeBases('dispensador')).prestadasEnLaVentana).toBe(0)
  })
})

describe('la disponibilidad que lee la pantalla', () => {
  it('trae una entrada por tipo, con el tipo adentro', async () => {
    await comprarBases(2, 'estructura', null)
    await comprarBases(1, 'dispensador', null)

    const todos = await disponibilidadPorTipo()

    expect(todos).toEqual([
      expect.objectContaining({ tipo: 'estructura', libres: 2 }),
      expect.objectContaining({ tipo: 'dispensador', libres: 1 }),
    ])
  })

  /*
   * ── Un tipo que no está en el parque no avisa ─────────────────────────────
   *
   * «Comprar más» presupone tener alguno. Si Aquazaku todavía no registró
   * ningún dispensador, un cartel pidiendo comprar dispensadores es un aviso
   * sobre algo que no se usa — y un aviso que no corresponde se aprende a
   * ignorar, que es como se pierde el que sí importa.
   *
   * Cero LIBRES con parque propio sí avisa: eso lo prueba el caso de arriba.
   */
  it('un tipo sin ninguna base en el parque no aparece', async () => {
    await comprarBases(3, 'estructura', null)

    expect((await disponibilidadPorTipo()).map((d) => d.tipo)).toEqual(['estructura'])
  })

  it('una base descartada no mantiene vivo a su tipo', async () => {
    const [dispensador] = await comprarBases(1, 'dispensador', null)
    await comprarBases(1, 'estructura', null)
    await descartarBase(dispensador!.id, 'se quemó la resistencia del agua caliente', null, UN_CONTEXTO)

    expect((await disponibilidadPorTipo()).map((d) => d.tipo)).toEqual(['estructura'])
  })
})
