import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import {
  ajustarInsumo,
  buscarInsumo,
  crearInsumo,
  descartarInsumo,
  editarInsumo,
  listarInsumos,
  movimientosDe,
  registrarEntrada,
} from './service'
import {
  esquemaDeAjuste,
  esquemaDeAlta,
  esquemaDeDescarte,
  esquemaDeEdicion,
  esquemaDeEntrada,
} from './validation'

/**
 * Insumos de empaque — RN-INS-01 a 04.
 *
 * ── No hay ninguna ruta que edite el saldo ──────────────────────────────────
 *
 * Ni `PUT` ni `PATCH` sobre las unidades. El saldo **se mueve mediante
 * documentos** con motivo y responsable, nunca se corrige a mano. Que esas
 * rutas no existan es parte del contrato, no una omisión — igual que en M2, y
 * hay un test que lo verifica.
 *
 * `PATCH /insumos/:id` sí existe, pero toca la CONFIGURACIÓN del insumo
 * —nombre, mínimo, equivalencia, activo—, no su saldo.
 *
 * ── Por qué no hay `insumos:crear` en la matriz ─────────────────────────────
 *
 * Dar de alta un insumo es configuración, no operación: pasa una vez y la hace
 * un admin. Se cubre con `insumos:ajustar`, igual que se resolvió
 * `stock:descartar`. Un permiso que se usa tres veces al año no justifica una
 * fila más que hay que mantener y auditar.
 */
export async function insumosRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/insumos',
    { preHandler: [requireAuth, requirePermission('insumos', 'ver')] },
    async (req) => {
      const incluirInactivos = (req.query as { estado?: string }).estado === 'todos'
      return listarInsumos(incluirInactivos)
    },
  )

  app.get(
    '/insumos/:id',
    { preHandler: [requireAuth, requirePermission('insumos', 'ver')] },
    async (req, reply) => {
      const insumo = await buscarInsumo((req.params as { id: string }).id)
      if (!insumo) {
        return reply.code(404).send({ code: 'INSUMO_NO_ENCONTRADO', mensaje: 'no existe ese insumo' })
      }
      return insumo
    },
  )

  app.get(
    '/insumos/:id/movimientos',
    { preHandler: [requireAuth, requirePermission('insumos', 'ver')] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      try {
        return await movimientosDe(id)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ver', id)
      }
    },
  )

  app.post(
    '/insumos',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeAlta, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await crearInsumo(datos))
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar')
      }
    },
  )

  app.patch(
    '/insumos/:id',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeEdicion, req.body, reply)
      if (!datos) return

      try {
        return await editarInsumo(id, datos)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )

  app.post(
    '/insumos/:id/entrada',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeEntrada, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await registrarEntrada(id, datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )

  app.post(
    '/insumos/:id/ajuste',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeAjuste, req.body, reply)
      if (!datos) return

      try {
        return await ajustarInsumo(id, datos, req.user?.id ?? null)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )

  app.post(
    '/insumos/:id/descarte',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeDescarte, req.body, reply)
      if (!datos) return

      try {
        return await descartarInsumo(id, datos, req.user?.id ?? null)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )
}

/**
 * Traduce un error de negocio a su status, y lo deja en la bitácora.
 *
 * `auditarSinBloquear`: acá ya se ejecutó la acción o ya se rechazó, así que un
 * fallo de auditoría no puede tumbar la respuesta. Lo que sí bloquea es la
 * auditoría PREVIA de `requirePermission({ auditaLaRuta: true })`.
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
      resource: 'insumos',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
