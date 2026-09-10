import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { clientes } from '@/db/schema'
import { crearCliente, editarCliente } from '@/modules/clientes/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * El nombre del cliente, partido — RN-CLI-17.
 *
 * ── Qué se está probando de verdad ──────────────────────────────────────────
 *
 * Que `nombre` **no lo escribe este código**. Es una columna generada: la
 * compone Postgres a partir de las partes, y por eso no puede discrepar de
 * ellas. Los tests de abajo escriben partes y leen `nombre` — nunca al revés.
 *
 * El bloque final es el que más importa: cruza el servicio contra los CHECK de
 * la base. Ya pasó una vez en este proyecto que el servicio aceptaba una
 * dirección que la base rechazaba, y el usuario veía un 500 en vez de un
 * mensaje. La base tenía razón.
 */

let app: FastifyInstance

const CEDULA = { tipoDocumento: 'CC' as const, numeroDocumento: '1042857391' }

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('el nombre lo arma la base con las partes', () => {
  it('primer nombre + segundo + apellidos', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      segundoNombre: 'Elena',
      apellidos: 'Padilla Gómez',
    })

    expect(cliente.nombre).toBe('Rosa Elena Padilla Gómez')
  })

  /** Sin el `regexp_replace` de la migración, acá quedaba «Rosa  Padilla». */
  it('sin segundo nombre no deja un hueco doble', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
    })

    expect(cliente.nombre).toBe('Rosa Padilla')
  })

  /**
   * «Panadería del Centro» no tiene nombre de pila. Pedirle apellidos sería
   * inventar un dato, así que el negocio va por el nombre libre.
   */
  it('un negocio se nombra libre, sin partes', async () => {
    const { cliente } = await crearCliente({
      tipoDocumento: 'NIT',
      numeroDocumento: '900123456',
      nombreLibre: 'Panadería del Centro',
      tipo: 'comercial',
    })

    expect(cliente.nombre).toBe('Panadería del Centro')
    expect(cliente.primerNombre).toBeNull()
  })

  /**
   * El apodo es cómo se la conoce, no cómo se llama. En una factura va el
   * nombre; en el mostrador se dice el apodo. Son dos datos, no uno.
   */
  it('el apodo se guarda y NO entra en el nombre', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
      apodo: 'Doña Rosa',
    })

    expect(cliente.apodo).toBe('Doña Rosa')
    expect(cliente.nombre).toBe('Rosa Padilla')
  })

  /**
   * Mirar solo `nombre` no alcanza: el `btrim` de la columna generada recorta
   * el resultado compuesto igual, así que el nombre sale bien aunque las partes
   * queden guardadas con los espacios. Se comprobó sacando el trim del servicio
   * — el test seguía en verde.
   *
   * Lo que importa es la PARTE guardada: es la que se muestra en el formulario
   * de edición y la que indexa la búsqueda por apellido.
   */
  it('los espacios de más no llegan a la base, tampoco a las partes', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: '  Rosa  ',
      apellidos: '  Padilla  ',
      apodo: '  Doña Rosa  ',
    })

    expect(cliente.nombre).toBe('Rosa Padilla')
    expect(cliente.primerNombre).toBe('Rosa')
    expect(cliente.apellidos).toBe('Padilla')
    expect(cliente.apodo).toBe('Doña Rosa')
  })
})

describe('editar reemplaza el nombre entero', () => {
  it('cambiar los apellidos arrastra el nombre solo', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
    })

    const { cliente: editado } = await editarCliente(cliente.id, {
      primerNombre: 'Rosa',
      apellidos: 'Padilla de Gómez',
    })

    expect(editado.nombre).toBe('Rosa Padilla de Gómez')
  })

  /**
   * El caso que `clientes_una_sola_forma_de_nombre` existe para impedir: sin
   * limpiar, la razón social vieja quedaba colgando en una columna que ya no se
   * muestra, y el próximo que lea la tabla la va a creer vigente.
   */
  it('pasar de nombre libre a partido borra el libre', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      nombreLibre: 'Rosa Padilla',
    })

    const { cliente: editado } = await editarCliente(cliente.id, {
      primerNombre: 'Rosa',
      apellidos: 'Padilla Gómez',
    })

    expect(editado.nombreLibre).toBeNull()
    expect(editado.nombre).toBe('Rosa Padilla Gómez')
  })

  /** Omitir el apodo lo borra: es lo que significa reemplazar el nombre entero. */
  it('omitir el apodo lo quita', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
      apodo: 'Doña Rosa',
    })

    const { cliente: editado } = await editarCliente(cliente.id, {
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
    })

    expect(editado.apodo).toBeNull()
  })

  it('una edición que no menciona el nombre no lo toca', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
      apodo: 'Doña Rosa',
    })

    const { cliente: editado } = await editarCliente(cliente.id, { tipo: 'comercial' })

    expect(editado.nombre).toBe('Rosa Padilla')
    expect(editado.apodo).toBe('Doña Rosa')
  })
})

/**
 * ── El cruce: el servicio nunca acepta lo que la base rechaza ───────────────
 *
 * Cada caso se prueba DOS veces: contra el servicio, que tiene que dar un 422
 * con su mensaje, y contra la base a pelo, que tiene que rechazarlo también.
 *
 * Si el servicio aceptara alguno, el usuario vería un 500 con un error de
 * Postgres. Si la base aceptara alguno, el servicio estaría poniendo una regla
 * que el sistema no sostiene — y un `UPDATE` a mano la saltaría.
 */
describe('los nombres imposibles', () => {
  const casos = [
    ['ninguna forma de nombre', {}, 'NOMBRE_REQUERIDO'],
    ['solo apellidos', { apellidos: 'Padilla' }, 'NOMBRE_PARTIDO_INCOMPLETO'],
    ['solo primer nombre', { primerNombre: 'Rosa' }, 'NOMBRE_PARTIDO_INCOMPLETO'],
    [
      'las dos formas a la vez',
      { primerNombre: 'Rosa', apellidos: 'Padilla', nombreLibre: 'Panadería' },
      'NOMBRE_AMBIGUO',
    ],
    [
      'segundo nombre sin primero',
      { nombreLibre: 'Panadería', segundoNombre: 'Elena' },
      'SEGUNDO_NOMBRE_SIN_PRIMERO',
    ],
  ] as const

  it.each(casos)('el servicio rechaza «%s»', async (_nombre, partes, code) => {
    await expect(crearCliente({ ...CEDULA, ...partes })).rejects.toMatchObject({ code })
  })

  it.each(casos)('y la base también rechaza «%s»', async (_nombre, partes) => {
    await expect(
      db.insert(clientes).values({ ...CEDULA, ...partes }),
    ).rejects.toThrow()
  })

  /**
   * Y editar tampoco puede dejar un cliente en un estado imposible.
   *
   * Este bloque nació de una ablación: sacándole `exigirNombreCoherente` a
   * `editarCliente`, los 21 tests seguían en verde. Solo se probaba el alta —
   * y por la puerta de la edición se podía llegar al mismo estado, con un 500
   * de Postgres en la cara del usuario en vez de un mensaje.
   */
  /*
   * `{}` queda afuera a propósito: en una edición no significa «este cliente se
   * queda sin nombre», significa «no toqués el nombre». Es la diferencia entre
   * omitir una clave y mandarla vacía, y por eso `tocaElNombre` mira la
   * PRESENCIA de las claves y no sus valores.
   */
  const casosDeEdicion = casos.filter(([, partes]) => Object.keys(partes).length > 0)

  it.each(casosDeEdicion)(
    'y editar rechaza «%s» con el mismo código',
    async (_nombre, partes, code) => {
      const { cliente } = await crearCliente({
        ...CEDULA,
        primerNombre: 'Rosa',
        apellidos: 'Padilla',
      })

      await expect(editarCliente(cliente.id, { ...partes })).rejects.toMatchObject({ code })
    },
  )

  /** Vaciar el nombre a propósito SÍ se rechaza: las claves vienen, sin valor. */
  it('editar no puede dejar a un cliente sin nombre', async () => {
    const { cliente } = await crearCliente({
      ...CEDULA,
      primerNombre: 'Rosa',
      apellidos: 'Padilla',
    })

    await expect(
      editarCliente(cliente.id, {
        primerNombre: undefined,
        apellidos: undefined,
        nombreLibre: undefined,
      }),
    ).rejects.toMatchObject({ code: 'NOMBRE_REQUERIDO' })
  })
})

describe('por HTTP', () => {
  it('el alta acepta las partes y devuelve el nombre armado', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes',
      headers: { cookie },
      payload: {
        ...CEDULA,
        primerNombre: 'Rosa',
        segundoNombre: 'Elena',
        apellidos: 'Padilla Gómez',
        apodo: 'Doña Rosa',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      nombre: 'Rosa Elena Padilla Gómez',
      apodo: 'Doña Rosa',
      // Una CC se muestra pelada: el guion con dígito de verificación es del
      // NIT. Ver `documentoParaMostrar`.
      documento: '1042857391',
    })
  })

  /**
   * 422 y no 400: la forma de cada campo está bien —son strings no vacíos—, lo
   * que falla es la REGLA sobre el conjunto. Y el mensaje tiene que decir qué
   * hacer, porque lo va a leer quien está llenando el formulario.
   */
  it('un nombre incoherente vuelve con 422 y un mensaje que sirve', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes',
      headers: { cookie },
      payload: { ...CEDULA, apellidos: 'Padilla' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().mensaje).toMatch(/apellido/i)
  })
})
