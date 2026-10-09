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

  /**
   * ── Y dice QUÉ código es el que está contestando ──────────────────────────
   *
   * Sin esto, averiguar qué versión corre en un entorno obliga a deducirlo: el
   * uptime del propio `/health`, la hora del último deploy en el panel, o pedir
   * los logs. Las tres son indirectas, y las tres se equivocan — mirando el
   * uptime se puede confundir «el deploy nuevo entró» con «el viejo sigue
   * sirviendo», que es justo lo que pasa cuando un despliegue falla y la
   * plataforma deja al anterior en pie.
   *
   * `commit` lo contesta de frente, sin autenticación, desde afuera.
   *
   * Va en `null` cuando la plataforma no lo inyectó —correr local, un test, un
   * `docker run` a mano—. Es el mismo criterio de los cuatro saldos del cliente:
   * un valor inventado diría algo falso, y `null` dice «este proceso no sabe de
   * qué commit salió», que es la verdad.
   */
  it('dice de qué commit salió, o `null` si la plataforma no lo inyectó', async () => {
    const cuerpo = await app.inject({ method: 'GET', url: '/health' }).then((r) => r.json())

    /*
     * Se compara contra la variable REAL del proceso y no contra una forma.
     *
     * La primera versión afirmaba «es `null` o siete hexadecimales», y eso pasa
     * en verde con la implementación borrada: sin la línea, `commit` queda
     * `undefined`... y con la variable puesta tampoco distinguía entre los
     * siete caracteres correctos y otros siete. Un test que acepta las dos
     * respuestas no vigila ninguna.
     *
     * Así corre igual en local —donde no hay variable y tiene que ser `null`—
     * y en un entorno donde sí la hay, exigiendo el prefijo exacto.
     */
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA

    expect(cuerpo.commit).toBe(sha ? sha.slice(0, 7) : null)
  })
})
