import { PERMISSION_MATRIX, type Action, type Resource, type Role } from './matrix'

/**
 * El usuario tal como lo ve la capa de autorización. Los roles vienen de la
 * sesión, congelados al login.
 */
export interface UserContext {
  id: string
  /** TODOS los roles asignados, activos simultáneamente. No hay "rol actual". */
  roles: readonly Role[]
  /** Rutas que el usuario tiene abiertas. Habilita el alcance `ruta`. */
  activeRutas?: readonly string[]
}

/**
 * ¿Este usuario puede ejecutar esta acción sobre este recurso?
 *
 * Función pura: sin estado, sin caché, sin I/O. Se puede testear celda por celda.
 *
 * **Multi-rol es unión, no intersección** (RN-ACC-01): alcanza con que UNO de
 * los roles conceda el permiso. Un usuario `["pos","seller"]` puede cargar stock
 * a ruta porque su rol `pos` lo habilita, aunque `seller` no.
 *
 * No decide alcance — solo si la acción está permitida. El recorte de filas es
 * responsabilidad de `scopedQuery()`.
 */
export function can(user: UserContext, resource: Resource, action: Action): boolean {
  return user.roles.some((role) =>
    PERMISSION_MATRIX[role].some((rule) => rule.resource === resource && rule.action === action),
  )
}

/**
 * Todos los permisos del usuario, como strings `recurso:accion` sin repetir.
 *
 * Lo consume la UI para decidir qué mostrar. Recordar RN-ACC-02: **ocultar un
 * botón no es control de acceso**. La barrera real es `requirePermission()` en
 * cada endpoint.
 */
export function permisosDe(user: UserContext): string[] {
  const permisos = new Set<string>()

  for (const role of user.roles) {
    for (const rule of PERMISSION_MATRIX[role]) {
      permisos.add(`${rule.resource}:${rule.action}`)
    }
  }

  return Array.from(permisos).sort()
}
