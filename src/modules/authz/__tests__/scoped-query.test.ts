import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { resetDb } from '@/test/db'
import type { UserContext } from '../can'
import type { Role } from '../matrix'
import { NINGUNA_FILA, ScopeNoAplicableError } from '../scopes'
import { SinPermisoError, applicableScopes, combinarAlcances, scopedCondition } from '../scoped-query'

const usuario = (...roles: Role[]): UserContext => ({
  id: '11111111-1111-1111-1111-111111111111',
  roles,
})

describe('combinarAlcances()', () => {
  const cond = (nombre: string) => sql`${sql.raw(nombre)} = 1`

  it('una sola condición pasa tal cual', () => {
    const unica = cond('a')
    expect(combinarAlcances([unica])).toBe(unica)
  })

  it('varias condiciones se unen con OR — multi-rol SUMA visibilidad', () => {
    const combinada = combinarAlcances([cond('a'), cond('b')])

    expect(combinada).toBeDefined()
    expect(db.select().from(auditLog).where(combinada).toSQL().sql).toMatch(/ or /i)
  })

  it('sin ninguna condición NO devuelve undefined: devuelve la que no matchea nada', () => {
    // Este es el caso peligroso. Un `undefined` acá significaría "mostrale todo"
    // justo cuando no sabemos qué mostrarle. Ante la duda, cerrado.
    expect(combinarAlcances([])).toBe(NINGUNA_FILA)
    expect(combinarAlcances([undefined, undefined])).toBe(NINGUNA_FILA)
  })

  it('descarta los undefined y conserva los definidos', () => {
    const definida = cond('a')
    expect(combinarAlcances([undefined, definida])).toBe(definida)
  })
})

describe('applicableScopes()', () => {
  it('sin permiso, lista vacía', () => {
    expect(applicableScopes(usuario('seller'), 'usuarios', 'ver')).toEqual([])
    expect(applicableScopes(usuario(), 'ventas', 'ver')).toEqual([])
  })

  it('admin ve todo', () => {
    expect(applicableScopes(usuario('admin'), 'ventas', 'ver')).toEqual(['todo'])
  })

  it('seller ve solo lo propio', () => {
    expect(applicableScopes(usuario('seller'), 'ventas', 'ver')).toEqual(['propio'])
  })

  it('pos ve stock solo de bodega', () => {
    expect(applicableScopes(usuario('pos'), 'stock', 'ver')).toEqual(['BODEGA'])
  })

  it('multi-rol suma alcances distintos sobre el mismo recurso', () => {
    // seller ve stock con alcance `todo`; pos, solo `BODEGA`.
    const scopes = applicableScopes(usuario('pos', 'seller'), 'stock', 'ver')

    expect(scopes).toContain('BODEGA')
    expect(scopes).toContain('todo')
  })

  it('no repite un alcance que dan los dos roles', () => {
    expect(applicableScopes(usuario('pos', 'seller'), 'ventas', 'ver')).toEqual(['propio'])
  })

  it('sumar admin trae el alcance `todo`', () => {
    expect(applicableScopes(usuario('seller', 'admin'), 'ventas', 'ver')).toContain('todo')
  })
})

describe('scopedCondition()', () => {
  const columnas = { createdBy: auditLog.userId }

  describe('sin permiso', () => {
    it('LANZA en vez de devolver una consulta vacía', () => {
      expect(() => scopedCondition(usuario('seller'), 'usuarios', 'ver', columnas)).toThrow(
        SinPermisoError,
      )
    })

    it('el error avisa que faltó chequear el permiso antes', () => {
      expect(() => scopedCondition(usuario(), 'ventas', 'ver', columnas)).toThrow(
        /can\(\)|requirePermission/,
      )
    })
  })

  describe('alcance todo', () => {
    it('no filtra', () => {
      expect(scopedCondition(usuario('admin'), 'ventas', 'ver', columnas)).toBeUndefined()
    })

    it('`todo` gana sobre los recortes de los otros roles', () => {
      // El usuario tiene `propio` por seller y `todo` por admin: ve todo.
      expect(
        scopedCondition(usuario('seller', 'admin'), 'ventas', 'ver', columnas),
      ).toBeUndefined()
    })
  })

  describe('alcance restringido', () => {
    it('devuelve una condición', () => {
      expect(scopedCondition(usuario('seller'), 'ventas', 'ver', columnas)).toBeDefined()
    })

    it('propaga el fallo cerrado si falta la columna', () => {
      expect(() => scopedCondition(usuario('seller'), 'ventas', 'ver', {})).toThrow(
        ScopeNoAplicableError,
      )
    })

    it('un alcance categórico sobre una tabla también falla', () => {
      // pos tiene `reportes:operativos` con alcance `prep`, que no filtra filas.
      expect(() => scopedCondition(usuario('pos'), 'reportes', 'operativos', columnas)).toThrow(
        ScopeNoAplicableError,
      )
    })
  })
})

/**
 * Los tests de arriba prueban la decisión. Estos prueban que la condición
 * generada **realmente recorta filas** cuando la ejecuta Postgres. Una condición
 * SQL que nunca se ejecutó no está probada: está escrita.
 *
 * `audit_log` hace de tabla de prueba porque las de ventas y stock son de M1+.
 * La mecánica es la misma.
 */
describe('scopedCondition() contra la base real', () => {
  const PROPIO = '11111111-1111-1111-1111-111111111111'
  const AJENO = '22222222-2222-2222-2222-222222222222'

  beforeEach(async () => {
    await resetDb()
    await db.insert(auditLog).values([
      { userId: PROPIO, action: 'ventas:crear', result: 'ok' },
      { userId: PROPIO, action: 'ventas:ver', result: 'ok' },
      { userId: AJENO, action: 'ventas:crear', result: 'ok' },
      { userId: AJENO, action: 'ventas:anular', result: 'denied' },
    ])
  })

  afterAll(async () => {
    await closeDb()
  })

  it('el seller solo ve sus propios registros', async () => {
    const filtro = scopedCondition(usuario('seller'), 'ventas', 'ver', {
      createdBy: auditLog.userId,
    })

    const filas = await db.select().from(auditLog).where(filtro)

    expect(filas).toHaveLength(2)
    expect(filas.every((f) => f.userId === PROPIO)).toBe(true)
  })

  it('el admin ve los cuatro registros', async () => {
    const filtro = scopedCondition(usuario('admin'), 'ventas', 'ver', {
      createdBy: auditLog.userId,
    })

    expect(filtro).toBeUndefined()
    expect(await db.select().from(auditLog).where(filtro)).toHaveLength(4)
  })

  it('sumar admin a un seller le abre los cuatro', async () => {
    const filtro = scopedCondition(usuario('seller', 'admin'), 'ventas', 'ver', {
      createdBy: auditLog.userId,
    })

    expect(await db.select().from(auditLog).where(filtro)).toHaveLength(4)
  })

  it('un usuario sin registros propios ve cero, no todo', async () => {
    const otro: UserContext = { id: '33333333-3333-3333-3333-333333333333', roles: ['seller'] }
    const filtro = scopedCondition(otro, 'ventas', 'ver', { createdBy: auditLog.userId })

    // Cero es la respuesta correcta. Si acá vinieran 4, sería la fuga que todo
    // este módulo existe para evitar.
    expect(await db.select().from(auditLog).where(filtro)).toHaveLength(0)
  })
})
