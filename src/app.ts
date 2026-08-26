import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { env } from '@/lib/env'
import { buildLoggerOptions } from '@/lib/logger'
import { authRoutes } from '@/modules/auth/routes'
import { auditRoutes } from '@/modules/audit/routes'
import { productoRoutes } from '@/modules/productos/routes'
import { insumosRoutes } from '@/modules/insumos/routes'
import { stockRoutes } from '@/modules/stock/routes'
import { userRoutes } from '@/modules/users/routes'
import { authPlugin } from '@/plugins/auth-plugin'

/**
 * Construye la instancia de Fastify sin levantarla.
 *
 * Separar la construcción del `listen()` es lo que permite testear con
 * `app.inject()` — requests HTTP reales, sin puerto, sin race conditions de
 * arranque. `server.ts` es el único lugar que abre un socket.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(process.env.NODE_ENV, process.env.LOG_LEVEL),
    // Cada request lleva un id. Si el cliente ya trae uno (web/ lo propaga vía
    // el helper BFF), lo respetamos para poder correlacionar logs entre los dos
    // servicios. Si no, Fastify genera el suyo.
    genReqId: (req) => req.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
  })

  // Sin esto `req.cookies` no existe, y toda la autenticación depende de leer
  // la cookie de sesión.
  await app.register(cookie)

  // Devuelve el request id al cliente para que el error sea rastreable desde
  // el browser hasta el log de api/.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  // El browser nunca habla directo con api/ (patrón BFF), así que el único
  // origen permitido es web/. `credentials` va en true porque la sesión viaja
  // en cookie.
  await app.register(cors, {
    origin: [env.WEB_PUBLIC_URL],
    credentials: true,
  })

  app.get('/health', async () => {
    return { status: 'ok', service: 'aquazaku-api' }
  })

  await app.register(authPlugin)
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(auditRoutes)
  await app.register(productoRoutes)
  await app.register(stockRoutes)
  await app.register(insumosRoutes)

  return app
}
