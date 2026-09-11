import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb } from '@/db/client'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * `GET /clientes/a-llamar` — M15.
 *
 * ── Lo que este archivo vigila, y por qué no es obvio ───────────────────────
 *
 * `a-llamar` convive con `/clientes/:id`. La documentación de find-my-way dice
 * que el segmento estático gana sobre el paramétrico, y es cierto — pero es
 * exactamente la clase de cosa que se afirma de memoria en un comentario y
 * después nadie comprueba.
 *
 * Si el router se equivocara, `a-llamar` llegaría como un id y la respuesta
 * sería un 404 de «ese cliente no existe»: un error que apunta al lugar
 * equivocado y que se persigue en el servicio de clientes durante una hora.
 *
 * Y el permiso: `clientes:ver`. El `seller` no lo tiene, y esta lista dice
 * quién compró qué y cuándo.
 */

let app: FastifyInstance

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await closeDb()
})

describe('el ruteo', () => {
  it('`a-llamar` no se lee como un id de cliente', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({
      method: 'GET',
      url: '/clientes/a-llamar',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  /*
   * El contraste que le da sentido al test de arriba: un id inventado SÍ cae en
   * `/clientes/:id` y contesta 404. Sin esta mitad, un 200 en la de arriba
   * podría venir de que las dos rutas hacen lo mismo.
   */
  it('un id cualquiera sí cae en la ficha, y no existe', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({
      method: 'GET',
      url: '/clientes/3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })
})

/**
 * ── No hay test de 403, y es a propósito ────────────────────────────────────
 *
 * Los cuatro roles que existen —`admin`, `seller`, `pos`, `contador`— tienen
 * `clientes:ver`. Así que hoy NINGUNO recibe 403 acá, y un test que lo esperara
 * no podría fallar nunca: sería decoración con forma de prueba de seguridad,
 * que es la peor clase.
 *
 * Lo escribí y lo descubrí al correrlo, no al pensarlo.
 *
 * Que todos lo vean es correcto: quien atiende el mostrador es justamente quien
 * tiene que saber a quién llamar. La barrera real de esta ruta es estar
 * autenticado, y eso sí se prueba.
 */
describe('el permiso', () => {
  it('sin sesión no se ve', async () => {
    const res = await app.inject({ method: 'GET', url: '/clientes/a-llamar' })

    expect(res.statusCode).toBe(401)
  })

  it.each(['seller', 'pos', 'contador'] as const)(
    'el %s la ve: es quien atiende y quien cobra',
    async (rol) => {
      const { cookie } = await usuarioAutenticado(rol)

      const res = await app.inject({
        method: 'GET',
        url: '/clientes/a-llamar',
        headers: { cookie },
      })

      expect(res.statusCode).toBe(200)
    },
  )
})
