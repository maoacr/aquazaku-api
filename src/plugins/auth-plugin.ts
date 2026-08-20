import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { headersDesdeFastify } from '@/lib/http'
import { env } from '@/lib/env'
import { auth } from '@/modules/auth/better-auth'
import { auditarSinBloquear } from '@/modules/auth/routes'
import {
  LIMITE_LOGIN,
  LIMITE_RESET,
  type OpcionesDeLimite,
  claveDeIntento,
  limpiarIntentos,
  registrarIntento,
} from '@/modules/auth/rate-limit'

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

/**
 * Rutas de Better-Auth que llevan límite de intentos, y con qué regla.
 *
 * El límite se aplica ACÁ y no dentro de Better-Auth porque este plugin es el
 * único punto por el que pasan todos sus endpoints: una regla en un solo lugar
 * es una regla que no se puede olvidar en el próximo endpoint que se agregue.
 */
const RUTAS_LIMITADAS: ReadonlyArray<{ patron: string; limite: OpcionesDeLimite }> = [
  { patron: '/sign-in/', limite: LIMITE_LOGIN },
  { patron: '/request-password-reset', limite: LIMITE_RESET },
  { patron: '/forget-password', limite: LIMITE_RESET },
]

function limiteAplicable(url: string): OpcionesDeLimite | null {
  return RUTAS_LIMITADAS.find((r) => url.includes(r.patron))?.limite ?? null
}

async function manejarAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const limite = limiteAplicable(req.url)

  if (limite) {
    const email = (req.body as { email?: unknown } | undefined)?.email
    const clave = claveDeIntento(req.ip, typeof email === 'string' ? email : '')
    const resultado = registrarIntento(clave, limite)

    if (!resultado.permitido) {
      // Queda registrado: una ráfaga que llega al límite es justamente lo que
      // hay que poder ver después.
      await auditarSinBloquear(req, {
        userId: null,
        rolEjercido: [],
        action: 'auth:rate-limit',
        resource: 'auth',
        result: 'denied',
        payload: typeof email === 'string' ? { email, ruta: req.url } : { ruta: req.url },
      })

      return reply
        .code(429)
        .header('retry-after', String(resultado.reintentarEn))
        .send({ code: 'RATE_LIMITED', reintentarEn: resultado.reintentarEn })
    }
  }

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

  // Quien entra bien deja de arrastrar sus intentos fallidos: era el dueño de
  // la cuenta y simplemente se equivocó unas veces.
  if (exitoso && typeof email === 'string') {
    limpiarIntentos(claveDeIntento(req.ip, email))
  }

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
