import type { FastifyRequest } from 'fastify'

/**
 * Convierte los headers de Fastify a los `Headers` del estándar web.
 *
 * Better-Auth habla `Request`/`Response`; Fastify tiene su propio modelo. Un
 * header puede venir repetido (`set-cookie`, `accept`), así que se usa `append`
 * y no `set`: con `set` el último pisa a los anteriores y se pierden valores.
 */
export function headersDesdeFastify(req: FastifyRequest): Headers {
  const headers = new Headers()

  for (const [nombre, valor] of Object.entries(req.headers)) {
    if (valor === undefined) continue

    if (Array.isArray(valor)) {
      for (const v of valor) headers.append(nombre, v)
    } else {
      headers.append(nombre, String(valor))
    }
  }

  return headers
}
