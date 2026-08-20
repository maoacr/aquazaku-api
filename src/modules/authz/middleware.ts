import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '@/db/client'
import { sessions, users } from '@/db/schema'
import { debeAuditarseAlPermitir, emit } from './audit'
import { type UserContext, can } from './can'
import type { Action, Resource, Role } from './matrix'

declare module 'fastify' {
  interface FastifyRequest {
    /** Lo puebla `requireAuth`. Sin ese preHandler, siempre es `undefined`. */
    user?: UserContext
  }
}

/** Nombre de la cookie de sesión. Lo comparte Better-Auth (Task 5). */
export const COOKIE_SESION = 'aquazaku_session'

/**
 * Códigos de error de autenticación.
 *
 * Son distintos a propósito: `web/` los usa para mostrar el mensaje correcto
 * ("tu sesión venció" no es lo mismo que "tu cuenta fue desactivada"). Un 401
 * genérico obligaría al usuario a adivinar por qué lo echaron.
 */
export const ERROR_AUTH = {
  SIN_SESION: 'UNAUTHENTICATED',
  SESION_VENCIDA: 'SESSION_EXPIRED',
  USUARIO_INACTIVO: 'USER_INACTIVE',
  SIN_PERMISO: 'FORBIDDEN',
  AUDITORIA_CAIDA: 'AUDIT_UNAVAILABLE',
} as const

/**
 * Valida la sesión y puebla `req.user`.
 *
 * Una sola consulta con join: se ejecuta en cada request autenticado, y dos
 * viajes a la base donde alcanza uno se pagan en cada endpoint del sistema.
 *
 * NO renueva la expiración. El spec §7.5 pide ventana deslizante, pero el ciclo
 * de vida de la sesión lo administra Better-Auth (Task 5) con su `updateAge`.
 * Implementarlo también acá sería tener dos dueños del mismo dato.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[COOKIE_SESION]

  if (!token) {
    return reply.code(401).send({ code: ERROR_AUTH.SIN_SESION })
  }

  const [fila] = await db
    .select({
      userId: users.id,
      status: users.status,
      roles: sessions.roles,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .limit(1)

  // Token inexistente y token vencido devuelven lo mismo hacia afuera salvo el
  // código: no queremos que un atacante distinga "no existe" de "venció".
  if (!fila) {
    return reply.code(401).send({ code: ERROR_AUTH.SIN_SESION })
  }

  if (fila.expiresAt.getTime() <= Date.now()) {
    return reply.code(401).send({ code: ERROR_AUTH.SESION_VENCIDA })
  }

  // Se chequea en CADA request, no solo al login: RN-ACC-05 dice que un usuario
  // no se borra, se desactiva — y la desactivación tiene que hacer efecto en el
  // request siguiente, no cuando le venza la sesión.
  if (fila.status !== 'active') {
    return reply.code(401).send({ code: ERROR_AUTH.USUARIO_INACTIVO })
  }

  req.user = {
    id: fila.userId,
    roles: fila.roles as Role[],
  }
}

/**
 * Exige un permiso concreto y deja el rastro en la bitácora.
 *
 * Corre siempre DESPUÉS de `requireAuth`. Es la barrera real del sistema:
 * ocultar un botón en la UI no es control de acceso (RN-ACC-02).
 *
 * ── Qué pasa si no se puede auditar ─────────────────────────────────────────
 *
 * Los dos casos se tratan distinto, y la diferencia importa:
 *
 *   · Denegado — se responde 403 igual. El usuario queda bloqueado, que es lo
 *     que protege al sistema. La falla de auditoría se loguea como error.
 *   · Permitido — se responde 500 y la acción NO se ejecuta. RN-ACC-04 exige
 *     que las acciones sensibles queden auditadas; dejar pasar una sin registro
 *     sería incumplir la regla en silencio. Preferimos un endpoint caído a una
 *     acción sensible sin rastro.
 */
export function requirePermission(resource: Resource, action: Action) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      return reply.code(401).send({ code: ERROR_AUTH.SIN_SESION })
    }

    const permitido = can(req.user, resource, action)

    const registro = {
      userId: req.user.id,
      rolEjercido: req.user.roles,
      // Formato canónico del dominio. Va en la columna `action`, que está
      // indexada, y no escondido en el payload: si no se puede filtrar por
      // acción, la UI de auditoría no sirve.
      action: `${resource}:${action}`,
      resource,
      requestId: String(req.id),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }

    if (!permitido) {
      try {
        await emit({ ...registro, result: 'denied' })
      } catch (err) {
        // El usuario queda bloqueado igual. Perder el rastro de un intento
        // denegado es grave, pero dejarlo pasar sería peor.
        req.log.error({ err, ...registro }, 'no se pudo auditar un acceso denegado')
      }

      return reply.code(403).send({ code: ERROR_AUTH.SIN_PERMISO, resource, action })
    }

    if (debeAuditarseAlPermitir(resource, action)) {
      try {
        await emit({ ...registro, result: 'ok' })
      } catch (err) {
        req.log.error({ err, ...registro }, 'no se pudo auditar una acción permitida')

        return reply.code(500).send({ code: ERROR_AUTH.AUDITORIA_CAIDA })
      }
    }
  }
}
