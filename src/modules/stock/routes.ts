import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { listarMovimientos, lotesConSaldoDe, resumenDeStock } from './consultas'
import { ajustarLote, descartar, registrarEntrada } from './service'
import {
  esquemaDeAjuste,
  esquemaDeDescarte,
  esquemaDeEntrada,
  esquemaDeFiltroDeMovimientos,
} from './validation'

/**
 * Stock de producto terminado — RN-STK-01 a 08.
 *
 * ── No hay ninguna ruta que edite el saldo ──────────────────────────────────
 *
 * Ni `PUT` ni `PATCH` sobre las unidades. El stock **se mueve mediante
 * documentos** con motivo y responsable (RN-STK-02), nunca se corrige a mano.
 * Que esas rutas no existan es parte del contrato, no una omisión — y hay un
 * test que lo verifica.
 *
 * El ajuste es el escape válido: la realidad física siempre difiere del
 * sistema. Pero es un documento con nombre, fecha y motivo.
 */
export async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/stock',
    { preHandler: [requireAuth, requirePermission('stock', 'ver')] },
    async (req) => resumenDeStock(hoyDe(req)),
  )

  app.get(
    '/stock/:productoId/lotes',
    { preHandler: [requireAuth, requirePermission('stock', 'ver')] },
    async (req) => lotesConSaldoDe((req.params as { productoId: string }).productoId),
  )

  app.get(
    '/stock/movimientos',
    { preHandler: [requireAuth, requirePermission('stock', 'ver')] },
    async (req, reply) => {
      const filtros = validar(esquemaDeFiltroDeMovimientos, req.query ?? {}, reply)
      if (!filtros) return

      return listarMovimientos(filtros)
    },
  )

  app.post(
    '/stock/entradas',
    { preHandler: [requireAuth, requirePermission('stock', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeEntrada, req.body, reply)
      if (!datos) return

      try {
        // El servicio escribe la bitácora con el saldo antes y después: acá no
        // se duplica.
        return reply.code(201).send(await registrarEntrada(datos, contextoDe(req)))
      } catch (err) {
        return manejarError(err, req, reply, 'stock:ajustar')
      }
    },
  )

  app.post(
    '/stock/ajustes',
    { preHandler: [requireAuth, requirePermission('stock', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeAjuste, req.body, reply)
      if (!datos) return

      try {
        return await ajustarLote(datos, contextoDe(req))
      } catch (err) {
        return manejarError(err, req, reply, 'stock:ajustar', datos.loteId)
      }
    },
  )

  app.post(
    '/stock/descartes',
    { preHandler: [requireAuth, requirePermission('stock', 'descartar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeDescarte, req.body, reply)
      if (!datos) return

      try {
        return await descartar(datos, contextoDe(req))
      } catch (err) {
        return manejarError(err, req, reply, 'stock:descartar', datos.loteId)
      }
    },
  )
}

/**
 * La fecha con la que se decide qué está vencido.
 *
 * Se calcula acá, en el borde, y viaja hacia adentro como dato. Las funciones de
 * dominio no llaman a `new Date()`: así el vencimiento se puede testear sin
 * esperar a mañana, y una misma petición usa la misma fecha de principio a fin
 * aunque cruce la medianoche.
 */
function hoyDe(_req: FastifyRequest): string {
  return new Date().toISOString().slice(0, 10)
}

function contextoDe(req: FastifyRequest) {
  return {
    userId: req.user?.id ?? null,
    rolEjercido: req.user?.roles ?? [],
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }
}

/**
 * Traduce un error de negocio a HTTP y deja el intento fallido en la bitácora.
 *
 * Registrar el rechazo importa tanto como el éxito: alguien intentando ajustar
 * repetidamente un lote que no tiene saldo es exactamente el patrón que hay que
 * poder ver después.
 */
async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
  resourceId = '(nuevo)',
): Promise<FastifyReply> {
  if (err instanceof ErrorDeNegocio) {
    await auditarSinBloquear(req, {
      userId: req.user?.id ?? null,
      rolEjercido: req.user?.roles ?? [],
      action,
      resource: 'stock',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
