import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes } from '@/db/schema'
import { buscarClientes, clientesRecientes } from '@/modules/clientes/service'
import { resetDb } from '@/test/db'

/**
 * Buscar un cliente por cómo se lo conoce — M16.
 *
 * ── El bug que esto viene a matar ───────────────────────────────────────────
 *
 * El filtro vivía en el navegador y hacía `toLowerCase()` sin tocar las tildes.
 * Medido sobre datos reales: buscar «gomez» NO encontraba a «Rosa Elena Padilla
 * Gómez», y «panaderia» NO encontraba a «Panadería del Centro».
 *
 * En Colombia eso es la mitad de los apellidos —Gómez, Pérez, Martínez,
 * Rodríguez— y nadie los teclea con tilde. El buscador parecía roto porque lo
 * estaba.
 *
 * ── Y por qué se muda al servidor ───────────────────────────────────────────
 *
 * Filtrar en el navegador obliga a traer TODOS los clientes en cada carga. Con
 * cinco mil, son cinco mil filas viajando para mostrar veinte.
 */

async function crear(nombre: string, documento: string, apodo?: string) {
  const partes = nombre.split(' ')

  await db.insert(clientes).values({
    primerNombre: partes[0]!,
    apellidos: partes.slice(1).join(' ') || null,
    apodo: apodo ?? null,
    tipoDocumento: 'CC',
    numeroDocumento: documento,
  })
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

describe('las tildes no esconden a nadie', () => {
  beforeEach(async () => {
    await crear('Rosa Padilla Gómez', '79000001')
    await crear('Luis Pérez Martínez', '79000002')
  })

  it.each([
    ['sin tilde encuentra con tilde', 'gomez', 'Rosa'],
    ['con tilde también', 'gómez', 'Rosa'],
    ['en mayúscula', 'GOMEZ', 'Rosa'],
    ['otro apellido sin tilde', 'perez', 'Luis'],
    ['con tilde en el medio', 'martinez', 'Luis'],
  ])('%s', async (_, termino, esperado) => {
    const encontrados = await buscarClientes(termino)

    expect(encontrados).toHaveLength(1)
    expect(encontrados[0]!.primerNombre).toBe(esperado)
  })
})

describe('por dónde se puede buscar', () => {
  beforeEach(async () => {
    await crear('Rosa Padilla Gómez', '79000001', 'Doña Rosa')
    await crear('Panadería del Centro', '90000002')
  })

  it('por el primer nombre', async () => {
    expect(await buscarClientes('rosa')).toHaveLength(1)
  })

  it('por el apellido solo', async () => {
    expect(await buscarClientes('padilla')).toHaveLength(1)
  })

  /*
   * El apodo es como se la conoce en el pueblo, y muchas veces es lo único que
   * quien atiende tiene a mano — RN-CLI-17. Y también lleva tilde: «Doña».
   */
  it('por el apodo, con tilde y sin ella', async () => {
    expect(await buscarClientes('doña')).toHaveLength(1)
    expect(await buscarClientes('dona')).toHaveLength(1)
  })

  it('por el nombre de un negocio', async () => {
    expect(await buscarClientes('panaderia')).toHaveLength(1)
  })

  it('por el número de documento', async () => {
    expect(await buscarClientes('79000001')).toHaveLength(1)
  })

  /*
   * Se busca CONTIENE y no empieza-con, al revés que el documento. Un apellido
   * se recuerda suelto —«el Gómez ese»— y quien busca no sabe si va primero o
   * segundo. Una cédula, en cambio, se dicta de izquierda a derecha.
   */
  it('encuentra el apellido aunque no sea la primera palabra', async () => {
    expect(await buscarClientes('centro')).toHaveLength(1)
  })
})

describe('lo que NO devuelve', () => {
  beforeEach(async () => {
    await crear('Rosa Padilla Gómez', '79000001')
  })

  /*
   * Mismo criterio que la búsqueda por documento: con uno o dos caracteres la
   * respuesta serían casi todos, que es ruido y además una consulta por tecla.
   */
  it('con menos de tres caracteres no busca', async () => {
    expect(await buscarClientes('ro')).toHaveLength(0)
    expect(await buscarClientes('r')).toHaveLength(0)
    expect(await buscarClientes('')).toHaveLength(0)
  })

  it('a quien no coincide', async () => {
    expect(await buscarClientes('martinez')).toHaveLength(0)
  })

  it('a un cliente desactivado, salvo que se lo pidan', async () => {
    await db.update(clientes).set({ activo: false })

    expect(await buscarClientes('padilla')).toHaveLength(0)
    expect(await buscarClientes('padilla', false)).toHaveLength(1)
  })
})

/**
 * El tope existe por la misma razón que en la búsqueda por documento: si un
 * término corto trae muchos, la respuesta correcta no es una lista larga — es
 * «seguí escribiendo».
 */
describe('el tope', () => {
  it('no devuelve más de lo que se puede elegir de un vistazo', async () => {
    for (let i = 0; i < 30; i++) {
      await crear(`Rosa Padilla Gómez`, `7900${String(i).padStart(4, '0')}`)
    }

    const encontrados = await buscarClientes('padilla')

    expect(encontrados.length).toBeLessThanOrEqual(12)
    expect(encontrados.length).toBeGreaterThan(0)
  })
})

/**
 * Los últimos registrados — M16.
 *
 * ── Por qué la pantalla no arranca vacía ────────────────────────────────────
 *
 * Una pantalla en blanco se siente rota, y además esconde el caso más común
 * después de registrar a alguien: volver a mirarlo para corregir un dedazo.
 *
 * Pero tampoco puede traerlos a todos: con cinco mil clientes son cinco mil
 * filas viajando para mostrar veinte. Los últimos diez son la respuesta a «qué
 * pasó recién», que es lo único que se puede contestar sin que alguien busque.
 */
describe('los últimos registrados', () => {
  it('devuelve los más nuevos primero, no por nombre', async () => {
    await crear('Ana Primera', '79000001')
    await crear('Beto Segundo', '79000002')
    await crear('Carlos Tercero', '79000003')

    const recientes = await clientesRecientes(2)

    expect(recientes.map((c) => c.primerNombre)).toEqual(['Carlos', 'Beto'])
  })

  it('respeta el tope que se le pide', async () => {
    for (let i = 0; i < 20; i++) await crear(`Cliente ${i}`, `7900${String(i).padStart(4, '0')}`)

    expect(await clientesRecientes(5)).toHaveLength(5)
  })

  it('no trae desactivados, salvo que se lo pidan', async () => {
    await crear('Ana Primera', '79000001')
    await db.update(clientes).set({ activo: false })

    expect(await clientesRecientes(10)).toHaveLength(0)
    expect(await clientesRecientes(10, false)).toHaveLength(1)
  })
})
