import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { validar } from '@/lib/http'
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
  restablecerPassword,
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

  /**
   * Restablece la contraseña y devuelve la temporal UNA sola vez.
   *
   * `POST` y no `PUT`: cada llamada genera una contraseña distinta y deja la
   * anterior inservible, así que repetirla NO da el mismo resultado.
   *
   * ── La temporal viaja en la respuesta y en ningún otro lado ────────────────
   *
   * No se guarda en claro, no se escribe al log y **no entra en la auditoría**.
   * `audit_log` es inmutable y lo pueden leer `admin` y `contador`: dejar ahí la
   * contraseña la volvería permanente y legible por más gente que la que la
   * necesita. Lo que sí queda registrado es que hubo un restablecimiento, quién
   * lo hizo y sobre quién — que es lo que hay que poder auditar.
   */
  app.post(
    '/users/:id/reset-password',
    { preHandler: [requireAuth, requirePermission('usuarios', 'editar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id

      try {
        const { usuario, temporal } = await restablecerPassword(id)

        await auditar(req, 'usuarios:restablecer-password', id, 'ok', {
          email: usuario.email,
          // El VALOR no; el hecho sí. Sin esto, un restablecimiento hecho para
          // entrar a la cuenta de otro no dejaría rastro de haber ocurrido.
          sesionesCerradas: true,
        })

        return { usuario, temporal }
      } catch (err) {
        return manejarError(err, req, reply, 'usuarios:restablecer-password', id)
      }
    },
  )
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
