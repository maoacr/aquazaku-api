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
    /*
     * Los dos canales vienen en la MISMA respuesta y no en dos peticiones: la
     * pantalla muestra el conteo de las dos pestañas antes de que nadie toque
     * ninguna, así que pedirlas por separado sería un viaje para pintar un
     * número que ya se podía traer.
     */
    expect(res.json()).toEqual({ botellones: [], otros: [], ocultas: { botellones: 0, otros: 0 } })
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

/**
 * Ocultar y mostrar una fila — RN-CLI-18.
 *
 * ── Lo que vigila ───────────────────────────────────────────────────────────
 *
 * El PERMISO, antes que nada. `clientes:ocultar_seguimiento` lo tienen los tres
 * roles operativos y NO `contador`, que es de solo lectura. Esconder el botón
 * en la pantalla no es control de acceso (RN-ACC-02): la barrera real es ésta,
 * y si no está, cualquiera con sesión puede vaciar la lista de llamados.
 *
 * Y que `/clientes/a-llamar/ocultar` no se lea como un id. Es el mismo riesgo
 * de ruteo que arriba, con un segmento más.
 */
describe('ocultar una fila por la api', () => {
  const unaFila = {
    clienteId: '00000000-0000-4000-8000-000000000001',
    direccionId: null,
    canal: 'botellones',
  }

  it('el contador NO puede: es de solo lectura', async () => {
    const { cookie } = await usuarioAutenticado('contador')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes/a-llamar/ocultar',
      headers: { cookie },
      payload: unaFila,
    })

    expect(res.statusCode).toBe(403)
  })

  it('sin sesión tampoco', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clientes/a-llamar/ocultar',
      payload: unaFila,
    })

    expect(res.statusCode).toBe(401)
  })

  it('el vendedor sí: es quien recorre la lista marcando', async () => {
    const { cookie, usuario } = await usuarioAutenticado('seller')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes/a-llamar/ocultar',
      headers: { cookie },
      payload: { ...unaFila, clienteId: usuario.id },
    })

    /*
     * 400 si el cliente no existe —la FK lo rechaza— pero NUNCA 403: lo que se
     * prueba acá es el permiso, y el id de un usuario no es el de un cliente.
     */
    expect(res.statusCode).not.toBe(403)
  })

  /*
   * El canal es parte de la clave, así que un valor inventado no puede pasar:
   * la columna es un enum y un `canal: 'pacas'` escribiría una fila que ninguna
   * consulta encontraría — un ocultamiento fantasma.
   */
  it('un canal que no existe se rechaza con 400, no con un 500 de la base', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes/a-llamar/ocultar',
      headers: { cookie },
      payload: { ...unaFila, canal: 'pacas' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('omitir `direccionId` se rechaza: `null` tiene que ser explícito', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes/a-llamar/ocultar',
      headers: { cookie },
      payload: { clienteId: unaFila.clienteId, canal: 'botellones' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('devolver a la lista pide el mismo permiso', async () => {
    const { cookie } = await usuarioAutenticado('contador')

    const res = await app.inject({
      method: 'DELETE',
      url: '/clientes/a-llamar/ocultar',
      headers: { cookie },
      payload: unaFila,
    })

    expect(res.statusCode).toBe(403)
  })

  it('`?ocultas=1` responde 200 y la misma forma', async () => {
    const { cookie } = await usuarioAutenticado('admin')

    const res = await app.inject({
      method: 'GET',
      url: '/clientes/a-llamar?ocultas=1',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ botellones: [], otros: [], ocultas: { botellones: 0, otros: 0 } })
  })
})
