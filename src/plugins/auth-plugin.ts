import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { headersDesdeFastify } from '@/lib/http'
import { env } from '@/lib/env'
import { auth } from '@/modules/auth/better-auth'
import { auditarSinBloquear } from '@/modules/auth/routes'

/**
 * Monta los endpoints de Better-Auth en Fastify.
 *
 * Better-Auth habla el estándar web (`Request`/`Response`); Fastify tiene su
 * propio modelo. Este plugin traduce entre los dos, y la traducción tiene tres
 * puntos donde es fácil perder algo:
 *
 *  1. **`set-cookie` puede venir repetido.** Un `Headers.forEach` los pisa entre
 *     sí y la cookie de sesión no llega al browser: el login "funciona" y el
 *     usuario nunca queda logueado. Por eso se leen con `getSetCookie()`.
 *  2. **El body es un stream.** Devolverlo tal cual desde el handler no
 *     funciona; hay que materializarlo.
 *  3. **Los headers entrantes pueden ser arrays** (`set-cookie`, `accept`…).
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: manejarAuth,
  })
}

async function manejarAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = new URL(req.url, env.BETTER_AUTH_URL)

  const respuesta = await auth.handler(
    new Request(url, {
      method: req.method,
      headers: headersDesdeFastify(req),
      body: req.body === undefined || req.method === 'GET' ? undefined : JSON.stringify(req.body),
    }),
  )

  reply.status(respuesta.status)

  // `set-cookie` va aparte: puede haber varias y `forEach` las colapsaría en
  // una sola, perdiendo la de sesión.
  const cookies = respuesta.headers.getSetCookie()
  if (cookies.length > 0) reply.header('set-cookie', cookies)

  respuesta.headers.forEach((valor, nombre) => {
    if (nombre.toLowerCase() === 'set-cookie') return
    reply.header(nombre, valor)
  })

  const cuerpo = await respuesta.text()

  await auditarIntentoDeLogin(req, respuesta.status, cuerpo)

  // 204 y 304 no llevan cuerpo; mandarlo rompe el protocolo.
  if (cuerpo.length === 0) {
    return reply.send()
  }

  return reply.send(cuerpo)
}

/**
 * Deja constancia de cada intento de inicio de sesión.
 *
 * Los intentos FALLIDOS son la señal que más importa: una ráfaga de fallos
 * contra el mismo email es un ataque de fuerza bruta, y sin registro no hay
 * forma de verlo ni después ni en el momento. Por eso se auditan con
 * `userId: null` — no hay sesión detrás, pero sí hay un hecho que registrar.
 *
 * Nunca se guarda la contraseña, ni siquiera la fallida. Solo el email, que es
 * lo que permite reconstruir contra quién iba el intento.
 */
async function auditarIntentoDeLogin(
  req: FastifyRequest,
  status: number,
  cuerpo: string,
): Promise<void> {
  if (!req.url.includes('/sign-in/')) return

  const exitoso = status >= 200 && status < 300
  const email = (req.body as { email?: unknown } | undefined)?.email

  let userId: string | null = null
  if (exitoso) {
    try {
      userId = (JSON.parse(cuerpo) as { user?: { id?: string } }).user?.id ?? null
    } catch {
      // El cuerpo no era JSON. No es motivo para perder el registro del login.
    }
  }

  await auditarSinBloquear(req, {
    userId,
    rolEjercido: [],
    action: 'auth:sign-in',
    resource: 'auth',
    result: exitoso ? 'ok' : 'denied',
    payload: typeof email === 'string' ? { email } : undefined,
  })
}
