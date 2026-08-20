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
    expect(res.json()).toEqual({ status: 'ok', service: 'aquazaku-api' })
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
