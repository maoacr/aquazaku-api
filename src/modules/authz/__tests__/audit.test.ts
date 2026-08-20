import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { resetDb } from '@/test/db'
import { PERMISSION_MATRIX, ROLES } from '../matrix'
import { debeAuditarseAlPermitir, emit } from '../audit'

describe('debeAuditarseAlPermitir()', () => {
  describe('acciones que modifican estado — todas dejan rastro', () => {
    const sensibles = [
      ['ventas', 'anular'],
      ['ventas', 'anular_verificada'],
      ['ventas', 'verificar_pago'],
      ['stock', 'ajustar'],
      ['stock', 'cargar_ruta'],
      ['insumos', 'ajustar'],
      ['botellones', 'descartar'],
      ['bases', 'prestar'],
      ['bases', 'retirar'],
      ['bases', 'descartar'],
      ['productos', 'editar_precios'],
      ['clientes', 'habilitar_credito'],
      ['rutas', 'cerrar_con_faltante'],
      ['usuarios', 'crear'],
      ['usuarios', 'editar'],
      ['configuracion', 'editar'],
    ] as const

    for (const [resource, action] of sensibles) {
      it(`${resource}:${action}`, () => {
        expect(debeAuditarseAlPermitir(resource, action)).toBe(true)
      })
    }
  })

  describe('lecturas puras — no dejan rastro al permitirse', () => {
    it('ver no se audita: sería un INSERT por cada pantalla', () => {
      expect(debeAuditarseAlPermitir('ventas', 'ver')).toBe(false)
      expect(debeAuditarseAlPermitir('clientes', 'ver')).toBe(false)
      expect(debeAuditarseAlPermitir('stock', 'ver')).toBe(false)
    })

    it('consultar reportes tampoco', () => {
      expect(debeAuditarseAlPermitir('reportes', 'operativos')).toBe(false)
      expect(debeAuditarseAlPermitir('reportes', 'financieros')).toBe(false)
    })
  })

  describe('excepciones a la excepción', () => {
    it('mirar la bitácora sí deja rastro: el control se controla a sí mismo', () => {
      expect(debeAuditarseAlPermitir('auditoria', 'ver')).toBe(true)
    })

    it('descargar un PDF sí deja rastro — lo pide el doc de dominio', () => {
      expect(debeAuditarseAlPermitir('reportes', 'descargar_pdf')).toBe(true)
    })
  })

  describe('la política falla hacia MÁS auditoría', () => {
    it('toda acción de la matriz que no sea lectura pura se audita', () => {
      const lecturasExentas = new Set(['ver', 'operativos', 'financieros'])

      for (const role of ROLES) {
        for (const { resource, action } of PERMISSION_MATRIX[role]) {
          if (lecturasExentas.has(action)) continue

          expect(
            debeAuditarseAlPermitir(resource, action),
            `${resource}:${action} debería auditarse`,
          ).toBe(true)
        }
      }
    })
  })
})

describe('emit()', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('escribe con solo los campos obligatorios y deja el resto en null', async () => {
    await emit({
      userId: null,
      rolEjercido: [],
      action: 'auth:login',
      result: 'denied',
      requestId: 'req-1',
    })

    const [fila] = await db.select().from(auditLog)

    expect(fila).toMatchObject({
      userId: null,
      rolEjercido: [],
      action: 'auth:login',
      result: 'denied',
      requestId: 'req-1',
      resource: null,
      resourceId: null,
      ip: null,
      userAgent: null,
      payload: null,
    })
  })

  it('acepta userId nulo: un login fallido no tiene sesión detrás', async () => {
    await emit({
      userId: null,
      rolEjercido: [],
      action: 'auth:login',
      result: 'denied',
      requestId: 'req-2',
      payload: { email: 'noexiste@aquazaku.com' },
    })

    const [fila] = await db.select().from(auditLog)
    expect(fila?.userId).toBeNull()
    expect(fila?.payload).toEqual({ email: 'noexiste@aquazaku.com' })
  })

  it('guarda todos los campos opcionales cuando vienen', async () => {
    await emit({
      userId: null,
      rolEjercido: ['admin', 'contador'],
      action: 'ventas:anular',
      resource: 'ventas',
      resourceId: 'venta-42',
      result: 'ok',
      requestId: 'req-3',
      ip: '10.0.0.1',
      userAgent: 'navegador/1.0',
      payload: { motivo: 'cliente devolvio el producto' },
    })

    const [fila] = await db.select().from(auditLog)

    expect(fila).toMatchObject({
      rolEjercido: ['admin', 'contador'],
      resource: 'ventas',
      resourceId: 'venta-42',
      ip: '10.0.0.1',
      userAgent: 'navegador/1.0',
    })
  })

  it('la fecha la pone la base, no el que llama', async () => {
    const antes = new Date(Date.now() - 1000)

    await emit({
      userId: null,
      rolEjercido: [],
      action: 'auth:login',
      result: 'ok',
      requestId: 'req-4',
    })

    const [fila] = await db.select().from(auditLog)
    expect(fila?.createdAt.getTime()).toBeGreaterThan(antes.getTime())
  })
})
