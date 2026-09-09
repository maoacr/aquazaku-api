import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { clientes } from '@/db/schema'
import { MAXIMO_COINCIDENCIAS, buscarPorDocumento } from '@/modules/clientes/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Buscar un cliente por documento.
 *
 * ── Por qué reemplaza al desplegable ────────────────────────────────────────
 *
 * Ventas y retornables cargaban `/clientes` entero en un `<select>`. Con
 * quinientos, ese control deja de servir aunque el sistema funcione perfecto:
 * nadie encuentra a alguien en una lista de quinientos, y en un mostrador con
 * gente esperando, menos.
 *
 * En el mostrador el cliente **dice su cédula**, no deletrea su apellido. Y dos
 * «María González» son dos personas; dos cédulas iguales, una sola.
 */

let app: FastifyInstance

const crear = (numeroDocumento: string, nombre = 'Cliente', activo = true) =>
  db.insert(clientes).values({ nombre, tipoDocumento: 'CC', numeroDocumento, activo })

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('cómo encuentra', () => {
  it('por el documento completo', async () => {
    await crear('1042857391', 'Panadería del Centro')

    const [c] = await buscarPorDocumento('1042857391')

    expect(c!.nombre).toBe('Panadería del Centro')
  })

  /*
   * Una cédula se dicta de izquierda a derecha, y quien la tipea ve el
   * resultado antes de terminar. Eso es lo que hace que sirva en un mostrador.
   */
  it('por el principio, sin terminar de escribir', async () => {
    await crear('1042857391', 'Panadería')
    await crear('1042999999', 'Tienda')

    expect(await buscarPorDocumento('10428')).toHaveLength(1)
    expect(await buscarPorDocumento('1042')).toHaveLength(2)
  })

  /*
   * Buscar «contiene» traería coincidencias por el medio del número —que no son
   * las que alguien tipeando espera— y además impide usar un índice.
   */
  it('NO busca por el medio del número', async () => {
    await crear('1042857391')

    expect(await buscarPorDocumento('857')).toHaveLength(0)
  })

  it('los puntos y guiones que la gente escribe no estorban', async () => {
    await crear('1042857391')

    expect(await buscarPorDocumento('1.042.857')).toHaveLength(1)
  })
})

describe('lo que NO devuelve', () => {
  /*
   * Con uno o dos caracteres la respuesta serían casi todos los clientes: ruido
   * que además cuesta una consulta a la base en cada tecla.
   */
  it('menos de tres caracteres no busca', async () => {
    await crear('1042857391')

    expect(await buscarPorDocumento('10')).toHaveLength(0)
    expect(await buscarPorDocumento('')).toHaveLength(0)
  })

  it('los clientes dados de baja quedan afuera', async () => {
    await crear('1042857391', 'Antiguo', false)

    expect(await buscarPorDocumento('1042857391')).toHaveLength(0)
  })

  /*
   * Si un prefijo trae muchos, la respuesta correcta no es una lista larga: es
   * «seguí escribiendo». Ocho alcanzan para elegir; más es una lista donde hay
   * que buscar otra vez.
   */
  it('corta en el máximo en vez de devolver una lista para buscar de nuevo', async () => {
    for (let i = 0; i < MAXIMO_COINCIDENCIAS + 5; i++) {
      await crear(`10428${String(i).padStart(5, '0')}`)
    }

    expect(await buscarPorDocumento('10428')).toHaveLength(MAXIMO_COINCIDENCIAS)
  })
})

describe('por la ruta', () => {
  const como = async (rol: 'admin' | 'pos', pedido: Omit<InjectOptions, 'headers'>) => {
    const u = await usuarioAutenticado(rol)
    return app.inject({ ...pedido, headers: { cookie: u.cookie } })
  }

  it('el `pos` la usa: es quien está en el mostrador', async () => {
    await crear('1042857391', 'Panadería del Centro')

    const res = await como('pos', { method: 'GET', url: '/clientes?documento=1042857391' })

    expect(res.statusCode).toBe(200)
    expect(res.json()[0].nombre).toBe('Panadería del Centro')
  })

  /*
   * Es la MISMA ruta que lista: quien pide clientes pide clientes, y el permiso
   * es el mismo. Un endpoint aparte sería otra puerta que asegurar por la misma
   * razón.
   */
  it('sin el parámetro sigue listando, como antes', async () => {
    await crear('1042857391')
    await crear('9004567890')

    expect((await como('admin', { method: 'GET', url: '/clientes' })).json()).toHaveLength(2)
  })

  it('sin sesión no busca nadie', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/clientes?documento=1042857391' })).statusCode,
    ).toBe(401)
  })

  it('sin coincidencias devuelve una lista vacía, no un 404', async () => {
    const res = await como('pos', { method: 'GET', url: '/clientes?documento=999999999' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})
