import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ZodType } from 'zod'

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

/**
 * Valida el body contra un esquema y responde 400 con el detalle si no pasa.
 *
 * Devuelve `null` cuando falló, para que el handler corte con un `if`. El
 * detalle lista campo por campo: un 400 que solo dice "inválido" obliga a
 * adivinar cuál de los ocho campos está mal.
 */
export function validar<T>(esquema: ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const resultado = esquema.safeParse(body)

  if (!resultado.success) {
    reply.code(400).send({
      code: 'VALIDATION_ERROR',
      detalle: resultado.error.issues.map((i) => ({
        campo: i.path.join('.') || '(cuerpo)',
        mensaje: i.message,
      })),
    })
    return null
  }

  return resultado.data
}
