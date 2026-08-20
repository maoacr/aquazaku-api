import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Construye la instancia de Fastify sin levantarla.
 *
 * Separar la construcción del `listen()` es lo que permite testear con
 * `app.inject()` — requests HTTP reales, sin puerto, sin race conditions de
 * arranque. `server.ts` es el único lugar que abre un socket.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const env = process.env.NODE_ENV

  const app = Fastify({
    // En tests el logger se apaga: si no, cada assert queda enterrado bajo
    // líneas de JSON y el output deja de ser leíble.
    logger:
      env === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // Logs legibles en dev; JSON crudo en cualquier otro entorno, que
            // es lo que espera un agregador de logs.
            transport:
              env === 'development'
                ? {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
                  }
                : undefined,
          },
    // Cada request lleva un id. Si el cliente ya trae uno (web/ lo propaga vía
    // el helper BFF), lo respetamos para poder correlacionar logs entre los dos
    // servicios. Si no, Fastify genera el suyo.
    genReqId: (req) => req.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
  })

  // Devuelve el request id al cliente para que el error sea rastreable desde
  // el browser hasta el log de api/.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  app.get('/health', async () => {
    return { status: 'ok', service: 'aquazaku-api' }
  })

  return app
}
