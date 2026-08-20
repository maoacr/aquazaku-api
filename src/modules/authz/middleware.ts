import type { FastifyReply, FastifyRequest } from 'fastify'
import { headersDesdeFastify } from '@/lib/http'
import { auth } from '@/modules/auth/better-auth'
import { COOKIE_SESION } from '@/modules/auth/cookie'
import { debeAuditarseAlPermitir, emit } from './audit'
import { type UserContext, can } from './can'
import type { Action, Resource, Role } from './matrix'

declare module 'fastify' {
  interface FastifyRequest {
    /** Lo puebla `requireAuth`. Sin ese preHandler, siempre es `undefined`. */
    user?: UserContext
  }
}

// Se reexporta por comodidad de quien ya la importaba desde acá. La fuente es
// `auth/cookie.ts`, que no importa nada: ver ahí por qué.
export { COOKIE_SESION }

/**
 * Códigos de error de autenticación.
 *
 * Son distintos a propósito: `web/` los usa para mostrar el mensaje correcto
 * ("tu sesión venció" no es lo mismo que "tu cuenta fue desactivada"). Un 401
 * genérico obligaría al usuario a adivinar por qué lo echaron.
 *
 * La frontera entre los dos primeros es si el request TRAJO cookie de sesión:
 *
 *   · `UNAUTHENTICATED` — no vino ninguna cookie. Nunca inició sesión, o
 *     cerró la que tenía.
 *   · `SESSION_EXPIRED` — vino una cookie que el servidor ya no acepta:
 *     vencida, revocada o adulterada. Para el usuario los tres casos son el
 *     mismo: volvé a entrar.
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
 * La validación se **delega a Better-Auth**, que es el dueño de la identidad
 * (ADR-0001). Él verifica la firma de la cookie, controla el vencimiento y
 * aplica la ventana deslizante del spec §7.5.
 *
 * La primera versión de este middleware consultaba `sessions` por su cuenta, y
 * eso estaba mal por partida doble: duplicaba lógica de la que Better-Auth ya
 * es dueño, y **no verificaba la firma** — la cookie es `token.firma`, así que
 * la comparación contra el token crudo nunca matcheaba. Un test de integración
 * lo destapó; con la delegación el problema desaparece por construcción.
 *
 * Lo que sí queda de nuestro lado: el estado del usuario. Better-Auth no conoce
 * `status`, y RN-ACC-05 exige que desactivar a alguien haga efecto en el
 * request siguiente, no cuando le venza la sesión.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sesion = await auth.api.getSession({ headers: headersDesdeFastify(req) })

  if (!sesion) {
    // Distinguir "nunca hubo sesión" de "la sesión ya no vale" se resuelve
    // mirando si el request TRAJO cookie, sin tocar la base.
    //
    // Consultar `sessions` después no serviría: al detectar una sesión vencida
    // Better-Auth borra la fila antes de devolver `null`, así que para cuando
    // uno va a buscarla ya no está. Lo descubrió un test de integración.
    const traiaCookie = Boolean(req.cookies[COOKIE_SESION])

    return reply
      .code(401)
      .send({ code: traiaCookie ? ERROR_AUTH.SESION_VENCIDA : ERROR_AUTH.SIN_SESION })
  }

  const usuario = sesion.user as { id: string; status?: string }

  if (usuario.status !== 'active') {
    return reply.code(401).send({ code: ERROR_AUTH.USUARIO_INACTIVO })
  }

  req.user = {
    id: usuario.id,
    roles: ((sesion.session as { roles?: string[] }).roles ?? []) as Role[],
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
export interface OpcionesDePermiso {
  /**
   * La ruta se encarga de auditar el éxito por su cuenta.
   *
   * Sirve cuando el handler conoce detalles que acá todavía no existen: el id
   * del usuario recién creado, qué roles se asignaron, qué campos cambiaron.
   * Sin esto quedarían DOS filas por acción —una del chequeo de permiso, sin
   * detalle, y otra del resultado— y la bitácora se leería el doble de larga
   * diciendo la mitad.
   *
   * Los DENEGADOS se siguen auditando siempre acá. Esa parte no es opcional.
   */
  auditaLaRuta?: true
}

export function requirePermission(
  resource: Resource,
  action: Action,
  opciones: OpcionesDePermiso = {},
) {
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

    if (!opciones.auditaLaRuta && debeAuditarseAlPermitir(resource, action)) {
      try {
        await emit({ ...registro, result: 'ok' })
      } catch (err) {
        req.log.error({ err, ...registro }, 'no se pudo auditar una acción permitida')

        return reply.code(500).send({ code: ERROR_AUTH.AUDITORIA_CAIDA })
      }
    }
  }
}
