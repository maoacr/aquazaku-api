import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { headersDesdeFastify } from '@/lib/http'
import { emit } from '@/modules/authz/audit'
import { permisosDe } from '@/modules/authz/can'
import { COOKIE_SESION, requireAuth } from '@/modules/authz/middleware'
import { auth } from './better-auth'
import { perfilDe } from './service'

/**
 * Endpoints propios de sesión.
 *
 * Van en `/auth/*`, separados de `/api/auth/*` que es de Better-Auth. La
 * división no es cosmética: `/api/auth/*` son los endpoints que Better-Auth
 * administra, y `/auth/*` los que agregamos nosotros encima.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Todo lo que `web/` necesita para armar la pantalla, en un solo viaje.
   *
   * Incluye los permisos ya resueltos para que el front no tenga que replicar
   * la matriz. Recordar RN-ACC-02: esto sirve para **ocultar** opciones, no para
   * autorizar. La barrera real es `requirePermission()` en cada endpoint.
   */
  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const usuario = req.user
    if (!usuario) return reply.code(401).send()

    const perfil = await perfilDe(usuario.id)
    if (!perfil) return reply.code(401).send()

    return {
      id: perfil.id,
      name: perfil.name,
      email: perfil.email,
      roles: usuario.roles,
      permisos: permisosDe(usuario),
      // `web/` fuerza el cambio de contraseña en el primer login (spec §7.2).
      mustChangePassword: perfil.mustChangePassword,
    }
  })

  /**
   * Cierra la sesión.
   *
   * Se delega en Better-Auth en vez de borrar la fila a mano: él sabe cómo
   * invalidar la sesión y cómo emitir la cookie de borrado con los mismos
   * atributos con que la creó. Una cookie limpiada con otro `path` o `domain`
   * no borra nada, y el usuario se queda logueado creyendo que salió.
   */
  app.post('/auth/sign-out', { preHandler: requireAuth }, async (req, reply) => {
    const usuario = req.user
    if (!usuario) return reply.code(401).send()

    const respuesta = await auth.api.signOut({
      headers: headersDesdeFastify(req),
      asResponse: true,
    })

    const cookies = respuesta.headers.getSetCookie()
    if (cookies.length > 0) reply.header('set-cookie', cookies)

    await auditarSinBloquear(req, {
      userId: usuario.id,
      rolEjercido: usuario.roles,
      action: 'auth:sign-out',
      resource: 'auth',
      result: 'ok',
    })

    return { ok: true }
  })

  /**
   * Cambio de contraseña con sesión abierta (spec §7.2).
   *
   * Exige la contraseña actual. No es burocracia: sin ese requisito, cualquiera
   * que se apodere de una sesión —una computadora sin bloquear, una cookie
   * robada— puede cambiar la contraseña y dejar afuera al dueño de la cuenta de
   * forma permanente. Pedirla convierte un robo de sesión en algo temporal.
   *
   * Al cambiarla se cierran las demás sesiones, por la misma razón.
   */
  app.post('/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const usuario = req.user
    if (!usuario) return reply.code(401).send()

    const datos = esquemaCambioDePassword.safeParse(req.body)
    if (!datos.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        detalle: datos.error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
      })
    }

    try {
      await auth.api.changePassword({
        body: {
          currentPassword: datos.data.currentPassword,
          newPassword: datos.data.newPassword,
          revokeOtherSessions: true,
        },
        headers: headersDesdeFastify(req),
      })
    } catch {
      await auditarSinBloquear(req, {
        userId: usuario.id,
        rolEjercido: usuario.roles,
        action: 'auth:change-password',
        resource: 'auth',
        result: 'denied',
      })

      // Mismo mensaje para "contraseña actual incorrecta" y para cualquier otro
      // rechazo: no hay nada que ganar contándole al que ya está adentro cuál de
      // los dos fue.
      return reply.code(400).send({ code: 'INVALID_CREDENTIALS' })
    }

    await db
      .update(users)
      .set({ mustChangePassword: false })
      .where(eq(users.id, usuario.id))

    await auditarSinBloquear(req, {
      userId: usuario.id,
      rolEjercido: usuario.roles,
      action: 'auth:change-password',
      resource: 'auth',
      result: 'ok',
    })

    return { ok: true }
  })
}

const esquemaCambioDePassword = z.object({
  currentPassword: z.string().min(1, 'la contraseña actual es obligatoria'),
  newPassword: z.string().min(8, 'la contraseña nueva necesita al menos 8 caracteres'),
})

type DatosDeAuditoria = {
  userId: string | null
  rolEjercido: readonly string[]
  action: string
  resource: string
  result: 'ok' | 'denied'
  payload?: Record<string, unknown>
}

/**
 * Audita sin cortar el request si la bitácora falla.
 *
 * Es distinto de lo que hace `requirePermission`, que ante un fallo de auditoría
 * bloquea la acción. La diferencia no es de criterio sino de regla: RN-ACC-04
 * enumera las acciones sensibles —anulaciones, ajustes, bajas, préstamos,
 * cambios de precio— y entrar o salir del sistema no está entre ellas.
 *
 * Se auditan igual porque saber quién entró y cuándo es la base de cualquier
 * investigación. Pero convertir una caída de la bitácora en imposibilidad de
 * iniciar sesión transformaría un problema de registro en una caída total.
 */
export async function auditarSinBloquear(
  req: { id: string | number; ip: string; headers: Record<string, unknown>; log: { error: (obj: unknown, msg: string) => void } },
  datos: DatosDeAuditoria,
): Promise<void> {
  try {
    await emit({
      ...datos,
      requestId: String(req.id),
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    })
  } catch (err) {
    req.log.error({ err, action: datos.action }, 'no se pudo auditar un evento de sesión')
  }
}
