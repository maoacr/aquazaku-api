import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'

describe('GET /health', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('responde 200 con el estado del servicio', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', service: 'aquazaku-api' })
  })

  /**
   * ── Ahora también dice si la base contesta ────────────────────────────────
   *
   * Antes devolvía `ok` fijo sin consultar nada, y Railway estuvo en verde toda
   * la puesta en marcha con Supabase inalcanzable: el proceso vivo y el sistema
   * inservible.
   *
   * Reporta el último latido en vez de consultar en cada petición: el
   * healthcheck de la plataforma pega cada pocos segundos, y un parpadeo de la
   * base tumbaría el contenedor sin arreglar nada.
   */
  it('reporta el estado de la base, no solo el del proceso', async () => {
    const cuerpo = await app.inject({ method: 'GET', url: '/health' }).then((r) => r.json())

    expect(cuerpo.base).toMatch(/^(ok|arrancando|sin-contacto)$/)
  })

  /*
   * Sigue siendo 200 aunque la base falle, a propósito: un 503 haría que la
   * plataforma reinicie el contenedor en bucle, y reiniciar `api` no levanta
   * Supabase. Lo que cambia es que el CUERPO lo dice.
   */
  it('no devuelve 503 aunque la base no conteste: reiniciar api no la levanta', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
  })

  it('devuelve el x-request-id que mandó el cliente', async () => {
    const requestId = 'e2e-fixed-request-id'

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': requestId },
    })

    expect(res.headers['x-request-id']).toBe(requestId)
  })

  it('genera un x-request-id cuando el cliente no manda ninguno', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.headers['x-request-id']).toEqual(expect.any(String))
    expect(res.headers['x-request-id']).not.toBe('')
  })
})
