import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { emit } from '@/modules/authz/audit'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { cambiarParametro, listarParametros } from './parametros'
import { esquemaDeParametro } from './validation'

/**
 * Los umbrales de las alertas — M12.
 *
 * ── Solo el admin, y solo acá ───────────────────────────────────────────────
 *
 * `configuracion:ver` y `configuracion:editar` ya estaban en la matriz desde M0,
 * y el `pos` NO los tiene. Eso no le impide ver alertas: **el umbral viaja con
 * el dato que lo usa** —`/retornables/bases` ya devuelve `diasDeEntrega`— así
 * que la pantalla nunca necesita consultarlo por su cuenta.
 *
 * Esta ruta existe para el formulario de administración, no para el cálculo.
 *
 * ── Cambiar un umbral SÍ se audita ──────────────────────────────────────────
 *
 * Un aviso que dejó de sonar tiene dos explicaciones —el problema desapareció, o
 * alguien movió el número— y meses después no hay forma de distinguirlas. Salvo
 * que quede escrito quién lo movió, cuándo, y de cuánto a cuánto.
 */
export async function alertasRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/parametros',
    { preHandler: [requireAuth, requirePermission('configuracion', 'ver')] },
    async () => listarParametros(),
  )

  app.put(
    '/parametros/:clave',
    { preHandler: [requireAuth, requirePermission('configuracion', 'editar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const { clave } = req.params as { clave: string }
      const datos = validar(esquemaDeParametro, req.body, reply)
      if (!datos) return

      /*
       * El valor anterior se lee ANTES de cambiarlo: sin él, la bitácora dice
       * «lo puso en 3» y no «lo bajó de 7 a 3», que es la mitad que importa
       * cuando se investiga por qué un aviso dejó de sonar.
       */
      const previos = await listarParametros()
      const antes = previos.find((p) => p.clave === clave)?.valor ?? null

      try {
        const nuevo = await cambiarParametro(clave, datos.valor)

        await emit({
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'configuracion:editar',
          resource: 'parametros',
          resourceId: clave,
          result: 'ok',
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          payload: { antes, despues: nuevo.valor, etiqueta: nuevo.etiqueta },
        })

        return nuevo
      } catch (err) {
        return manejarError(err, req, reply, clave)
      }
    },
  )
}

/**
 * Un intento fallido también se anota.
 *
 * Alguien tratando de poner el aviso en cero es exactamente el patrón que hay
 * que poder ver después — y el que no deja rastro si solo se auditan los
 * éxitos.
 */
async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  clave: string,
): Promise<FastifyReply> {
  if (err instanceof ErrorDeNegocio) {
    await auditarSinBloquear(req, {
      userId: req.user?.id ?? null,
      rolEjercido: req.user?.roles ?? [],
      action: 'configuracion:editar',
      resource: 'parametros',
      result: 'denied',
      // `auditarSinBloquear` toma el request y de ahí saca id, ip y agente.
      payload: { clave, code: err.code, mensaje: err.message },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
