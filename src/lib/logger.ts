import type { FastifyServerOptions } from 'fastify'

type LoggerOptions = FastifyServerOptions['logger']

/**
 * Configuración del logger según el entorno.
 *
 * Vive acá y no dentro de `buildApp()` para poder testear las tres variantes sin
 * levantar un servidor ni reimportar módulos con el entorno pisado.
 *
 *   test         → apagado. Si no, cada assert queda enterrado bajo JSON.
 *   development  → pino-pretty, legible por humanos.
 *   producción   → JSON crudo, que es lo que espera un agregador de logs.
 */
export function buildLoggerOptions(
  nodeEnv: string | undefined,
  logLevel: string | undefined,
): LoggerOptions {
  if (nodeEnv === 'test') return false

  const level = logLevel ?? 'info'

  if (nodeEnv === 'development') {
    return {
      level,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    }
  }

  return { level }
}
