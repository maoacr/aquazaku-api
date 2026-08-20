import { and, desc, eq, gte, lt, lte } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog, users } from '@/db/schema'
import type { UserContext } from '@/modules/authz/can'
import { scopedCondition } from '@/modules/authz/scoped-query'

/**
 * Consulta de la bitácora.
 *
 * Sin esto, `audit_log` sería —en palabras del propio documento de dominio— "un
 * log oculto" y no un control. RN-ACC-04 exige que se pueda consultar desde la
 * UI: el admin ve todo, el contador ve todo en modo lectura.
 */

export interface FiltrosDeAuditoria {
  userId?: string | undefined
  action?: string | undefined
  resource?: string | undefined
  result?: 'ok' | 'denied' | undefined
  desde?: Date | undefined
  hasta?: Date | undefined
  /** Id de la última fila de la página anterior. */
  cursor?: number | undefined
  limite: number
}

export interface RegistroDeAuditoria {
  id: number
  userId: string | null
  /** Nombre del usuario al momento de consultar. `null` si la cuenta ya no existe. */
  userName: string | null
  userEmail: string | null
  rolEjercido: string[] | null
  action: string
  resource: string | null
  resourceId: string | null
  result: 'ok' | 'denied'
  requestId: string | null
  ip: string | null
  userAgent: string | null
  payload: unknown
  createdAt: Date
}

export interface PaginaDeAuditoria {
  filas: RegistroDeAuditoria[]
  /**
   * Cursor de la página siguiente, o `null` si esta era la última.
   *
   * Solo se devuelve cuando la página vino **completa**. Devolverlo siempre
   * —como hacía la primera versión— hace que la UI muestre "cargar más" para
   * después traer cero filas: el usuario cree que el sistema se rompió.
   */
  siguienteCursor: number | null
}

/**
 * Trae una página de la bitácora, de la más reciente hacia atrás.
 *
 * Paginación **por cursor** y no por offset. Con offset, la página 20 obliga a
 * Postgres a recorrer y descartar las 950 filas anteriores, y encima una fila
 * nueva insertada mientras se pagina corre todo un lugar y hace que un registro
 * aparezca dos veces o ninguna. Con cursor sobre el id, cada página es un
 * `WHERE id < N` que usa el índice y no se descoloca aunque el log siga
 * creciendo — que es exactamente lo que hace un log.
 *
 * A propósito **no** devuelve el total: contar filas de una tabla que solo crece
 * es cada vez más caro y nadie necesita saber que hay 84.219 registros.
 */
export async function consultarAuditoria(
  filtros: FiltrosDeAuditoria,
  usuario: UserContext,
): Promise<PaginaDeAuditoria> {
  // RN-ACC-03: el alcance se aplica en esta capa, no en cada endpoint. Hoy tanto
  // admin como contador tienen alcance `todo`, así que no filtra nada; pasa por
  // acá igual para que el día que un rol tenga alcance acotado funcione solo.
  const alcance = scopedCondition(usuario, 'auditoria', 'ver', { createdBy: auditLog.userId })

  const condiciones = and(
    alcance,
    filtros.userId ? eq(auditLog.userId, filtros.userId) : undefined,
    filtros.action ? eq(auditLog.action, filtros.action) : undefined,
    filtros.resource ? eq(auditLog.resource, filtros.resource) : undefined,
    filtros.result ? eq(auditLog.result, filtros.result) : undefined,
    filtros.desde ? gte(auditLog.createdAt, filtros.desde) : undefined,
    filtros.hasta ? lte(auditLog.createdAt, filtros.hasta) : undefined,
    filtros.cursor !== undefined ? lt(auditLog.id, filtros.cursor) : undefined,
  )

  const filas = await db
    .select({
      id: auditLog.id,
      userId: auditLog.userId,
      // LEFT JOIN, no INNER: `audit_log` no tiene FK a `users` a propósito, para
      // que el rastro sobreviva al borrado de una cuenta. Con INNER, borrar un
      // usuario haría desaparecer su historial de la consulta — justo lo que la
      // ausencia de FK evita.
      userName: users.name,
      userEmail: users.email,
      rolEjercido: auditLog.rolEjercido,
      action: auditLog.action,
      resource: auditLog.resource,
      resourceId: auditLog.resourceId,
      result: auditLog.result,
      requestId: auditLog.requestId,
      ip: auditLog.ip,
      userAgent: auditLog.userAgent,
      payload: auditLog.payload,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(condiciones)
    .orderBy(desc(auditLog.id))
    // Se pide UNA fila de más de las que se van a devolver.
    //
    // Es la única forma de saber si hay página siguiente sin contar la tabla
    // entera. Mirar solo si vinieron tantas filas como el límite no alcanza: una
    // última página que casualmente viene justa se confunde con una página
    // completa que tiene continuación, y la UI muestra "cargar más" para después
    // traer cero filas. La fila extra se descarta y nunca sale de acá.
    .limit(filtros.limite + 1)

  const hayMas = filas.length > filtros.limite
  const pagina = hayMas ? filas.slice(0, filtros.limite) : filas
  const ultima = pagina[pagina.length - 1]

  return {
    filas: pagina,
    siguienteCursor: hayMas && ultima ? ultima.id : null,
  }
}
