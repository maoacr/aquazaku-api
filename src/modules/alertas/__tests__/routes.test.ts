import type { FastifyInstance, InjectOptions } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const como = async (rol: Role, pedido: Omit<InjectOptions, 'headers'>) => {
  const usuario = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie: usuario.cookie } })
}

describe('quién configura los umbrales', () => {
  it('el admin los ve', async () => {
    const res = await como('admin', { method: 'GET', url: '/parametros' })

    expect(res.statusCode).toBe(200)

    /*
     * Qué parámetros existe lo vigila `parametros.test.ts`, que es su lugar.
     * Acá lo que se prueba es la RUTA: que contesta, que devuelve la lista
     * entera y que cada fila trae sus límites —sin ellos el formulario ofrece
     * números que el servidor va a rechazar—.
     */
    const claves = res.json().map((p: { clave: string }) => p.clave)
    expect(claves).toContain('dias_aviso_vencimiento')
    expect(claves).toContain('dias_recompra_urgente')

    for (const p of res.json() as { minimo: number; maximo: number }[]) {
      expect(p.minimo).toBeLessThan(p.maximo)
    }
  })

  it('el admin los cambia', async () => {
    const res = await como('admin', {
      method: 'PUT',
      url: '/parametros/dias_entrega_bases',
      payload: { valor: 14 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().valor).toBe(14)
  })

  /*
   * El `pos` NO tiene `configuracion:ver`, y eso no le impide ver alertas: el
   * umbral viaja con el dato que lo usa —`/retornables/bases` devuelve
   * `diasDeEntrega`— así que la pantalla nunca lo consulta por su cuenta.
   */
  it('el `pos` no los ve, y no los necesita', async () => {
    expect((await como('pos', { method: 'GET', url: '/parametros' })).statusCode).toBe(403)
  })

  it('el `contador` tampoco: lee plata, no configura la planta', async () => {
    expect((await como('contador', { method: 'GET', url: '/parametros' })).statusCode).toBe(403)
  })

  it('y nadie los cambia sin sesión', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/parametros/dias_entrega_bases',
      payload: { valor: 14 },
    })

    expect(res.statusCode).toBe(401)
  })
})

describe('lo que se rechaza', () => {
  it('un valor fuera de rango: 422 con el rango en el mensaje', async () => {
    const res = await como('admin', {
      method: 'PUT',
      url: '/parametros/dias_aviso_vencimiento',
      payload: { valor: 0 },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().mensaje).toContain('va entre 1 y 30 días')
  })

  it('una clave inventada: 404, sin crear nada', async () => {
    expect(
      (await como('admin', { method: 'PUT', url: '/parametros/inventado', payload: { valor: 5 } }))
        .statusCode,
    ).toBe(404)
  })

  it('un valor no entero: 400 de forma', async () => {
    const res = await como('admin', {
      method: 'PUT',
      url: '/parametros/dias_entrega_bases',
      payload: { valor: 'siete' },
    })

    expect(res.statusCode).toBe(400)
  })
})

/**
 * ── Mover un umbral queda escrito ───────────────────────────────────────────
 *
 * Un aviso que dejó de sonar tiene dos explicaciones —el problema desapareció, o
 * alguien movió el número— y meses después no hay forma de distinguirlas. Salvo
 * que la bitácora diga quién, cuándo, y **de cuánto a cuánto**.
 */
describe('la bitácora', () => {
  const anotado = async () =>
    db.select().from(auditLog).where(eq(auditLog.resource, 'parametros'))

  it('guarda el valor anterior, no solo el nuevo', async () => {
    await como('admin', {
      method: 'PUT',
      url: '/parametros/dias_entrega_bases',
      payload: { valor: 21 },
    })

    const [entrada] = await anotado()

    expect(entrada!.result).toBe('ok')
    expect(entrada!.payload).toMatchObject({ antes: 7, despues: 21 })
  })

  /*
   * Alguien tratando de poner el aviso en cero es exactamente el patrón que hay
   * que poder ver después, y el que no deja rastro si solo se auditan los
   * éxitos.
   */
  it('también anota el intento que se rechazó', async () => {
    await como('admin', {
      method: 'PUT',
      url: '/parametros/dias_aviso_vencimiento',
      payload: { valor: 0 },
    })

    const [entrada] = await anotado()

    expect(entrada!.result).toBe('denied')
    expect(entrada!.payload).toMatchObject({ code: 'PARAMETRO_FUERA_DE_RANGO' })
  })
})
