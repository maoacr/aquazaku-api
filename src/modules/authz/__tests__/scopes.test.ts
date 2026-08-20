import { describe, expect, it } from 'vitest'
import { auditLog, sessions, users } from '@/db/schema'
import {
  type ScopeColumns,
  type ScopeContext,
  ScopeNoAplicableError,
  UBICACION_BODEGA,
  scopeCondition,
} from '../scopes'

/**
 * En M0 todavía no existen las tablas de ventas ni stock (son M1+), así que se
 * usan columnas de tablas reales como stand-in. Lo que se prueba es la mecánica
 * de traducción de alcance a SQL, que es genérica: no depende de qué tabla sea.
 */
const columnas: ScopeColumns = {
  createdBy: auditLog.userId,
  rutaId: sessions.id,
  ubicacion: users.status,
}

const ctx = (parcial: Partial<ScopeContext> = {}): ScopeContext => ({
  userId: '11111111-1111-1111-1111-111111111111',
  activeRutas: [],
  ...parcial,
})

describe('scopeCondition()', () => {
  describe('todo', () => {
    it('no filtra: es el único alcance que legítimamente devuelve undefined', () => {
      expect(scopeCondition('todo', columnas, ctx())).toBeUndefined()
    })

    it('no filtra ni siquiera sin columnas declaradas', () => {
      expect(scopeCondition('todo', {}, ctx())).toBeUndefined()
    })
  })

  describe('propio', () => {
    it('produce una condición', () => {
      expect(scopeCondition('propio', columnas, ctx())).toBeDefined()
    })

    it('FALLA si la tabla no declaró createdBy — nunca devuelve todo sin filtrar', () => {
      expect(() => scopeCondition('propio', {}, ctx())).toThrow(ScopeNoAplicableError)
    })

    it('el error dice qué falta y cómo arreglarlo', () => {
      expect(() => scopeCondition('propio', {}, ctx())).toThrow(/createdBy/)
      expect(() => scopeCondition('propio', {}, ctx())).toThrow(/ScopeColumns/)
    })
  })

  describe('ruta', () => {
    it('produce una condición cuando hay rutas abiertas', () => {
      const cond = scopeCondition('ruta', columnas, ctx({ activeRutas: ['r1', 'r2'] }))
      expect(cond).toBeDefined()
    })

    it('sin rutas abiertas no ve NADA — y eso es una condición, no ausencia de filtro', () => {
      const cond = scopeCondition('ruta', columnas, ctx({ activeRutas: [] }))

      // Lo importante: no es `undefined`. Un undefined acá significaría
      // "devolveme todas las rutas de la empresa".
      expect(cond).toBeDefined()
    })

    it('FALLA si la tabla no declaró rutaId', () => {
      expect(() => scopeCondition('ruta', {}, ctx({ activeRutas: ['r1'] }))).toThrow(
        ScopeNoAplicableError,
      )
    })
  })

  describe('BODEGA', () => {
    it('produce una condición', () => {
      expect(scopeCondition('BODEGA', columnas, ctx())).toBeDefined()
    })

    it('FALLA si la tabla no declaró ubicacion', () => {
      expect(() => scopeCondition('BODEGA', {}, ctx())).toThrow(ScopeNoAplicableError)
    })

    it('la constante de bodega está expuesta para que nadie la escriba a mano', () => {
      expect(UBICACION_BODEGA).toBe('BODEGA')
    })
  })

  describe('alcances categóricos', () => {
    it('prep no se traduce a SQL: acota reportes, no filas', () => {
      expect(() => scopeCondition('prep', columnas, ctx())).toThrow(ScopeNoAplicableError)
    })

    it('operativos tampoco', () => {
      expect(() => scopeCondition('operativos', columnas, ctx())).toThrow(ScopeNoAplicableError)
    })

    it('el error explica por qué, no solo que falló', () => {
      expect(() => scopeCondition('prep', columnas, ctx())).toThrow(/categoría/)
      expect(() => scopeCondition('prep', columnas, ctx())).toThrow(/reportes/)
    })
  })

  describe('la invariante que sostiene todo', () => {
    it('ningún alcance salvo `todo` puede devolver undefined', () => {
      const alcances = ['propio', 'ruta', 'BODEGA'] as const

      for (const scope of alcances) {
        const cond = scopeCondition(scope, columnas, ctx({ activeRutas: ['r1'] }))
        expect(cond, `el alcance '${scope}' devolvió undefined`).toBeDefined()
      }
    })

    it('con columnas vacías, todo alcance de datos lanza en vez de no filtrar', () => {
      const alcances = ['propio', 'ruta', 'BODEGA'] as const

      for (const scope of alcances) {
        expect(() => scopeCondition(scope, {}, ctx({ activeRutas: ['r1'] }))).toThrow(
          ScopeNoAplicableError,
        )
      }
    })
  })
})
