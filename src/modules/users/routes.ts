import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodType } from 'zod'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { ErrorDeNegocio } from '@/lib/errors'
import { emit } from '@/modules/authz/audit'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import type { Role } from '@/modules/authz/matrix'
import {
  asignarRoles,
  buscarUsuario,
  crearUsuario,
  editarUsuario,
  listarUsuarios,
} from './service'
import { esquemaAltaDeUsuario, esquemaDeRoles, esquemaEdicionDeUsuario } from './validation'

/**
 * Administración de usuarios. Solo `admin` (RN-ACC-01, matriz de permisos).
 *
 * Las rutas de escritura llevan `auditaLaRuta: true`: el detalle —a quién se
 * creó, qué roles quedaron, qué campos cambiaron— solo se conoce dentro del
 * handler, así que la bitácora la escribe la ruta y no el middleware. Los
 * accesos denegados los sigue registrando el middleware, siempre.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/users',
    { preHandler: [requireAuth, requirePermission('usuarios', 'ver')] },
    async () => listarUsuarios(),
  )

  app.get(
    '/users/:id',
    { preHandler: [requireAuth, requirePermission('usuarios', 'ver')] },
    async (req, reply) => {
      const usuario = await buscarUsuario((req.params as { id: string }).id)
      if (!usuario) return reply.code(404).send({ code: 'USUARIO_NO_ENCONTRADO' })

      return usuario
    },
  )

  app.post(
    '/users',
    { preHandler: [requireAuth, requirePermission('usuarios', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaAltaDeUsuario, req.body, reply)
      if (!datos) return

      try {
        const usuario = await crearUsuario({ ...datos, roles: datos.roles as Role[] })

        await auditar(req, 'usuarios:crear', usuario.id, 'ok', {
          email: usuario.email,
          roles: usuario.roles,
        })

        return reply.code(201).send(usuario)
      } catch (err) {
        return manejarError(err, req, reply, 'usuarios:crear')
      }
    },
  )

  app.patch(
    '/users/:id',
    { preHandler: [requireAuth, requirePermission('usuarios', 'editar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaEdicionDeUsuario, req.body, reply)
      if (!datos) return

      try {
        const usuario = await editarUsuario(id, datos)

        await auditar(req, 'usuarios:editar', id, 'ok', { cambios: datos })

        return usuario
      } catch (err) {
        return manejarError(err, req, reply, 'usuarios:editar', id)
      }
    },
  )

  /**
   * Reemplaza los roles de un usuario.
   *
   * Es `PUT` y no `POST` porque la operación es idempotente: manda el conjunto
   * completo de roles que el usuario debe tener, no un agregado. Con `POST`
   * quedaría ambiguo si repetir la llamada suma roles o los reemplaza.
   */
  app.put(
    '/users/:id/roles',
    { preHandler: [requireAuth, requirePermission('usuarios', 'editar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeRoles, req.body, reply)
      if (!datos) return

      const quienOtorga = req.user
      if (!quienOtorga) return reply.code(401).send()

      try {
        const antes = await buscarUsuario(id)
        const usuario = await asignarRoles(id, datos.roles as Role[], quienOtorga.id)

        await auditar(req, 'usuarios:editar', id, 'ok', {
          rolesAntes: antes?.roles ?? [],
          rolesDespues: usuario.roles,
        })

        return usuario
      } catch (err) {
        return manejarError(err, req, reply, 'usuarios:editar', id)
      }
    },
  )
}

/** Valida el body y responde 400 con el detalle si no pasa. */
function validar<T>(esquema: ZodType<T>, body: unknown, reply: FastifyReply): T | null {
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

/**
 * Escribe en la bitácora una acción sobre usuarios.
 *
 * Administrar cuentas SÍ es una acción sensible: quien crea usuarios o reparte
 * roles puede fabricarse acceso a todo el sistema. Por eso, a diferencia de los
 * eventos de sesión, un fallo de auditoría acá **corta la operación** — misma
 * regla que en `requirePermission`.
 */
async function auditar(
  req: FastifyRequest,
  action: string,
  resourceId: string,
  result: 'ok' | 'denied',
  payload: Record<string, unknown>,
): Promise<void> {
  await emit({
    userId: req.user?.id ?? null,
    rolEjercido: req.user?.roles ?? [],
    action,
    resource: 'usuarios',
    resourceId,
    result,
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    payload,
  })
}

async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
  resourceId = '(nuevo)',
): Promise<FastifyReply> {
  if (err instanceof ErrorDeNegocio) {
    // El intento fallido también se registra: alguien tratando de quitarse el
    // rol admin es exactamente el tipo de cosa que hay que poder ver después.
    await auditarSinBloquear(req, {
      userId: req.user?.id ?? null,
      rolEjercido: req.user?.roles ?? [],
      action,
      resource: 'usuarios',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
