import { type SQL, eq, inArray, sql } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { type Scope, esScopeDeDatos } from './matrix'

/**
 * Traducción de alcances a condiciones SQL.
 *
 * ── Principio rector: FALLAR CERRADO ──────────────────────────────────────
 *
 * Si un alcance no se puede aplicar, esto revienta. **Nunca** devuelve "sin
 * filtro". La diferencia entre las dos conductas es la diferencia entre un error
 * ruidoso en desarrollo y una fuga silenciosa de datos en producción: un alcance
 * `propio` que no encuentra su columna y decide no filtrar devuelve las ventas
 * de toda la empresa a un vendedor.
 *
 * Un permiso que falla abierto no es un permiso.
 */

/** Valor de la columna de ubicación que representa la bodega. */
export const UBICACION_BODEGA = 'BODEGA'

export interface ScopeContext {
  userId: string
  /** Rutas abiertas por el usuario. Sin rutas abiertas, el alcance `ruta` no ve nada. */
  activeRutas: readonly string[]
}

/**
 * Columnas de una tabla que implementan cada alcance.
 *
 * Cada módulo declara las suyas al construir una consulta. Una tabla que no
 * declara la columna que un alcance necesita no puede ser consultada con ese
 * alcance — y eso falla, no se ignora.
 */
export interface ScopeColumns {
  /** Quién creó el registro. Requerida por el alcance `propio`. */
  createdBy?: AnyColumn
  /** Ruta a la que pertenece el registro. Requerida por el alcance `ruta`. */
  rutaId?: AnyColumn
  /** Ubicación física del registro. Requerida por el alcance `BODEGA`. */
  ubicacion?: AnyColumn
}

/** Un alcance no se pudo traducir a SQL. Siempre es un error de programación. */
export class ScopeNoAplicableError extends Error {
  constructor(
    readonly scope: Scope,
    motivo: string,
  ) {
    super(`No se puede aplicar el alcance '${scope}': ${motivo}`)
    this.name = 'ScopeNoAplicableError'
  }
}

/**
 * Condición que no matchea ninguna fila. Es el piso del fallo cerrado: cuando no
 * se sabe qué mostrar, no se muestra nada.
 */
export const NINGUNA_FILA: SQL = sql`false`

/**
 * Condición SQL de un alcance sobre una tabla.
 *
 * Devuelve `undefined` **solo** para `todo`, que es el único alcance que
 * legítimamente no filtra nada. Cualquier otro caso devuelve una condición o
 * lanza.
 */
export function scopeCondition(
  scope: Scope,
  columns: ScopeColumns,
  ctx: ScopeContext,
): SQL | undefined {
  if (!esScopeDeDatos(scope)) {
    throw new ScopeNoAplicableError(
      scope,
      'es un alcance de categoría (acota qué reporte se ve, no qué filas), ' +
        'así que no se traduce a una condición sobre una tabla. ' +
        'Lo resuelve el módulo de reportes.',
    )
  }

  switch (scope) {
    case 'todo':
      return undefined

    case 'propio': {
      if (!columns.createdBy) {
        throw new ScopeNoAplicableError(
          scope,
          'la tabla no declaró la columna `createdBy`. Agregala a ScopeColumns ' +
            'o revisá si este recurso debería usar este alcance.',
        )
      }
      return eq(columns.createdBy, ctx.userId)
    }

    case 'ruta': {
      if (!columns.rutaId) {
        throw new ScopeNoAplicableError(scope, 'la tabla no declaró la columna `rutaId`.')
      }
      // Sin rutas abiertas no se ve nada. `inArray` con lista vacía genera SQL
      // inválido en algunos dialectos, así que se corta antes — y se corta
      // cerrado.
      if (ctx.activeRutas.length === 0) return NINGUNA_FILA

      return inArray(columns.rutaId, [...ctx.activeRutas])
    }

    case 'BODEGA': {
      if (!columns.ubicacion) {
        throw new ScopeNoAplicableError(scope, 'la tabla no declaró la columna `ubicacion`.')
      }
      return eq(columns.ubicacion, UBICACION_BODEGA)
    }
  }
}
