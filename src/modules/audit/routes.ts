import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { consultarAuditoria } from './query'

/**
 * Límite por página.
 *
 * El tope existe para que nadie —ni por error ni a propósito— pida el log
 * completo en un request y tumbe el servidor con una tabla que solo crece.
 */
const LIMITE_POR_DEFECTO = 50
const LIMITE_MAXIMO = 200

const esquemaDeFiltros = z.object({
  userId: z.uuid().optional(),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  result: z.enum(['ok', 'denied']).optional(),
  // `coerce.date()` acepta tanto `2026-08-20` como un ISO completo: el date
  // picker de la UI manda lo primero y no tiene por qué armar un timestamp.
  desde: z.coerce.date().optional(),
  hasta: z.coerce.date().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limite: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).default(LIMITE_POR_DEFECTO),
})

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Consulta de la bitácora — admin y contador (matriz de permisos).
   *
   * `requirePermission` la audita: quién mira la bitácora también queda en la
   * bitácora. Sin eso, el único control del sistema no tendría control sobre sí
   * mismo.
   */
  app.get(
    '/audit',
    { preHandler: [requireAuth, requirePermission('auditoria', 'ver')] },
    async (req, reply) => {
      const usuario = req.user
      if (!usuario) return reply.code(401).send()

      const filtros = esquemaDeFiltros.safeParse(req.query)

      if (!filtros.success) {
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          detalle: filtros.error.issues.map((i) => ({
            campo: i.path.join('.') || '(query)',
            mensaje: i.message,
          })),
        })
      }

      if (filtros.data.desde && filtros.data.hasta && filtros.data.desde > filtros.data.hasta) {
        return reply.code(400).send({
          code: 'RANGO_INVALIDO',
          mensaje: 'la fecha "desde" es posterior a "hasta"',
        })
      }

      return consultarAuditoria(filtros.data, usuario)
    },
  )
}
