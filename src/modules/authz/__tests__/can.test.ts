import { describe, expect, it } from 'vitest'
import { type UserContext, can, permisosDe } from '../can'
import type { Role } from '../matrix'

const usuario = (...roles: Role[]): UserContext => ({ id: 'u1', roles })

describe('can()', () => {
  describe('casos borde', () => {
    it('sin roles no puede nada', () => {
      const sinRoles = usuario()

      expect(can(sinRoles, 'ventas', 'ver')).toBe(false)
      expect(can(sinRoles, 'productos', 'ver')).toBe(false)
      expect(can(sinRoles, 'auditoria', 'ver')).toBe(false)
    })

    it('un rol no concede permisos de otro recurso que no tiene', () => {
      expect(can(usuario('seller'), 'usuarios', 'ver')).toBe(false)
      expect(can(usuario('seller'), 'auditoria', 'ver')).toBe(false)
      expect(can(usuario('pos'), 'usuarios', 'crear')).toBe(false)
      expect(can(usuario('contador'), 'ventas', 'crear')).toBe(false)
    })
  })

  describe('rol único', () => {
    it('admin puede anular una venta verificada', () => {
      expect(can(usuario('admin'), 'ventas', 'anular_verificada')).toBe(true)
    })

    it('seller puede crear ventas pero no anular verificadas', () => {
      expect(can(usuario('seller'), 'ventas', 'crear')).toBe(true)
      expect(can(usuario('seller'), 'ventas', 'anular_verificada')).toBe(false)
    })

    it('pos puede cargar stock a ruta, el seller no', () => {
      expect(can(usuario('pos'), 'stock', 'cargar_ruta')).toBe(true)
      expect(can(usuario('seller'), 'stock', 'cargar_ruta')).toBe(false)
    })

    it('contador ve ventas pero no las toca', () => {
      const contador = usuario('contador')

      expect(can(contador, 'ventas', 'ver')).toBe(true)
      expect(can(contador, 'ventas', 'crear')).toBe(false)
      expect(can(contador, 'ventas', 'anular')).toBe(false)
      expect(can(contador, 'ventas', 'verificar_pago')).toBe(false)
    })

    it('contador ve la auditoría; el pos no', () => {
      expect(can(usuario('contador'), 'auditoria', 'ver')).toBe(true)
      expect(can(usuario('pos'), 'auditoria', 'ver')).toBe(false)
    })

    it('contador no ve tanques', () => {
      expect(can(usuario('contador'), 'tanques', 'ver')).toBe(false)
    })
  })

  describe('multi-rol: la unión, no la intersección (RN-ACC-01)', () => {
    it('alcanza con que UN rol conceda el permiso', () => {
      // `seller` solo no puede cargar stock a ruta; con `pos` encima, sí.
      expect(can(usuario('seller'), 'stock', 'cargar_ruta')).toBe(false)
      expect(can(usuario('pos', 'seller'), 'stock', 'cargar_ruta')).toBe(true)
    })

    it('si ningún rol lo concede, sigue siendo no', () => {
      expect(can(usuario('pos', 'seller'), 'ventas', 'anular_verificada')).toBe(false)
      expect(can(usuario('pos', 'seller', 'contador'), 'usuarios', 'crear')).toBe(false)
    })

    it('el orden de los roles no cambia el resultado', () => {
      expect(can(usuario('seller', 'pos'), 'stock', 'cargar_ruta')).toBe(
        can(usuario('pos', 'seller'), 'stock', 'cargar_ruta'),
      )
    })

    it('repetir un rol no cambia nada', () => {
      expect(can(usuario('pos', 'pos'), 'stock', 'cargar_ruta')).toBe(true)
    })

    it('sumar contador a un rol operativo no le quita permisos de escritura', () => {
      // El readonly del contador es suyo, no contagia al resto de los roles.
      expect(can(usuario('pos', 'contador'), 'ventas', 'crear')).toBe(true)
      expect(can(usuario('pos', 'contador'), 'auditoria', 'ver')).toBe(true)
    })

    it('sumar admin concede todo lo del admin', () => {
      expect(can(usuario('seller', 'admin'), 'usuarios', 'crear')).toBe(true)
      expect(can(usuario('seller', 'admin'), 'ventas', 'anular_verificada')).toBe(true)
    })
  })
})

describe('permisosDe()', () => {
  it('sin roles, lista vacía', () => {
    expect(permisosDe(usuario())).toEqual([])
  })

  it('devuelve strings recurso:accion ordenados', () => {
    const permisos = permisosDe(usuario('contador'))

    expect(permisos).toContain('auditoria:ver')
    expect(permisos).toContain('reportes:financieros')
    expect([...permisos].sort()).toEqual(permisos)
  })

  it('no repite un permiso que dan dos roles a la vez', () => {
    const permisos = permisosDe(usuario('pos', 'seller'))

    expect(permisos.filter((p) => p === 'ventas:crear')).toHaveLength(1)
    expect(new Set(permisos).size).toBe(permisos.length)
  })

  it('multi-rol suma los permisos de ambos', () => {
    const soloSeller = permisosDe(usuario('seller'))
    const combinado = permisosDe(usuario('pos', 'seller'))

    expect(soloSeller).not.toContain('stock:cargar_ruta')
    expect(combinado).toContain('stock:cargar_ruta')
    for (const permiso of soloSeller) expect(combinado).toContain(permiso)
  })

  it('es consistente con can(): todo permiso listado se puede ejecutar', () => {
    const user = usuario('pos', 'contador')

    for (const permiso of permisosDe(user)) {
      const [resource, action] = permiso.split(':')
      // biome-ignore lint: los strings vienen de la propia matriz, son válidos
      expect(can(user, resource as never, action as never)).toBe(true)
    }
  })
})
