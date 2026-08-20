import { type SQL, or } from 'drizzle-orm'
import type { UserContext } from './can'
import { PERMISSION_MATRIX, type Action, type Resource, type Scope } from './matrix'
import {
  NINGUNA_FILA,
  type ScopeColumns,
  type ScopeContext,
  scopeCondition,
} from './scopes'

/**
 * La ÚNICA capa donde se aplica el alcance — RN-ACC-03.
 *
 * Ningún módulo filtra por su cuenta. Si el recorte de filas viviera repartido
 * en cincuenta endpoints, bastaría con que uno se olvide para filtrar datos, y
 * ese uno no se descubre hasta que ya pasó.
 */

/** Se pidió el alcance de una acción que el usuario no tiene permitida. */
export class SinPermisoError extends Error {
  constructor(resource: Resource, action: Action) {
    super(
      `El usuario no tiene el permiso '${resource}:${action}'. ` +
        'Llamá a can() o usá requirePermission() antes de construir la consulta.',
    )
    this.name = 'SinPermisoError'
  }
}

/**
 * Alcances que aplican al usuario para una acción, sin repetir.
 *
 * Multi-rol suma alcances (RN-ACC-01): si un rol da `propio` y otro `BODEGA`,
 * el usuario ve la **unión** de ambos conjuntos, no la intersección. Restringir
 * de más también es un bug — le esconde a alguien datos que le corresponden.
 */
export function applicableScopes(
  user: UserContext,
  resource: Resource,
  action: Action,
): Scope[] {
  const scopes = new Set<Scope>()

  for (const role of user.roles) {
    for (const rule of PERMISSION_MATRIX[role]) {
      if (rule.resource === resource && rule.action === action) {
        scopes.add(rule.scope)
      }
    }
  }

  return Array.from(scopes)
}

/**
 * Condición SQL que recorta una consulta al alcance del usuario.
 *
 * - `undefined` significa "sin filtro", y **solo** ocurre cuando el usuario
 *   tiene alcance `todo`. Nunca es el resultado de que algo salió mal.
 * - Si el usuario no tiene el permiso, lanza `SinPermisoError`. No devuelve una
 *   consulta vacía disimulando el problema: significa que alguien se salteó el
 *   chequeo de permisos, y eso hay que verlo.
 * - Con varios alcances, se combinan con `OR` — la unión.
 *
 * @example
 * const filtro = scopeCondition(user, 'ventas', 'ver', { createdBy: ventas.createdBy })
 * const q = db.select().from(ventas)
 * return filtro ? q.where(filtro) : q
 */
export function scopedCondition(
  user: UserContext,
  resource: Resource,
  action: Action,
  columns: ScopeColumns,
): SQL | undefined {
  const scopes = applicableScopes(user, resource, action)

  if (scopes.length === 0) throw new SinPermisoError(resource, action)

  // `todo` gana sobre cualquier otro alcance: si un rol permite ver todo, los
  // recortes de los otros roles no le quitan nada.
  if (scopes.includes('todo')) return undefined

  const ctx: ScopeContext = {
    userId: user.id,
    activeRutas: user.activeRutas ?? [],
  }

  return combinarAlcances(scopes.map((scope) => scopeCondition(scope, columns, ctx)))
}

/**
 * Combina en una sola condición los alcances que aplican al usuario.
 *
 * Se une con `OR` porque multi-rol **suma** visibilidad: un usuario que ve lo
 * propio por un rol y la bodega por otro tiene que ver ambos conjuntos.
 *
 * Está separada de `scopedCondition()` para poder testear la unión de varios
 * alcances restringidos. Hoy la matriz no produce esa combinación —toda
 * combinación multi-rol que da dos alcances incluye `todo`, que corta antes—
 * pero M1+ puede introducirla, y el día que pase esto ya está probado.
 *
 * Exportada solo por eso; los módulos usan `scopedCondition()`.
 */
export function combinarAlcances(condiciones: readonly (SQL | undefined)[]): SQL | undefined {
  const definidas = condiciones.filter((c): c is SQL => c !== undefined)

  // Sin ninguna condición no se devuelve `undefined`, que significaría "mostrale
  // todo". Se devuelve la condición que no matchea nada. Ante la duda, cerrado.
  if (definidas.length === 0) return NINGUNA_FILA

  if (definidas.length === 1) return definidas[0]

  return or(...definidas)
}
