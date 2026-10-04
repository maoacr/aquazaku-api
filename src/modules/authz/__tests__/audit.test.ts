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

/*
 * El pool se cierra cuando termina el ARCHIVO, no cuando termina un `describe`.
 * Estaba dentro de `describe('emit()')`, y eso dejaba sin conexión a cualquier
 * bloque declarado después: los tests fallaban por timeout en su `beforeEach`,
 * sin una sola aserción que mirar.
 */
afterAll(async () => {
  await closeDb()
})

describe('emit()', () => {
  beforeEach(async () => {
    await resetDb()
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

/**
 * La fila de una acción sensible vive o muere CON el cambio que registra.
 *
 * [ADR-0007](docs: decisiones/0007-auditoria-bloqueante) decide que una acción
 * sensible sin bitácora **no se ejecuta**. Eso no se puede cumplir emitiendo
 * después del commit: si el `INSERT` en `audit_log` falla ahí, el cambio YA
 * está aplicado y lo único que se puede hacer es devolver un 500 sobre algo
 * que sí ocurrió — el estado real y lo que la persona cree quedan en
 * desacuerdo, que es peor que no auditar.
 *
 * La única forma de que «no se ejecuta» sea verdad es que las dos escrituras
 * compartan transacción: si una se cae, el rollback se lleva las dos.
 *
 * Estos dos casos son la infraestructura que lo habilita. Mover cada acción
 * sensible adentro de su transacción viene después, módulo por módulo.
 */
describe('emit() dentro de una transacción', () => {
  beforeEach(resetDb)

  const unaFila = {
    userId: null,
    rolEjercido: ['admin'],
    action: 'ventas:anular',
    resource: 'ventas',
    result: 'ok' as const,
    requestId: 'req-de-prueba',
  }

  it('si la transacción se revierte, NO queda la fila', async () => {
    await expect(
      db.transaction(async (tx) => {
        await emit(unaFila, tx)

        /*
         * Lo que en producción sería la escritura del cambio fallando después
         * del emit: una restricción violada, la conexión cortada, un deadlock.
         * El rollback tiene que llevarse la fila de auditoría con él.
         */
        throw new Error('el cambio falló después de auditar')
      }),
    ).rejects.toThrow('el cambio falló después de auditar')

    expect(await db.select().from(auditLog)).toHaveLength(0)
  })

  it('si la transacción termina bien, la fila queda', async () => {
    await db.transaction(async (tx) => {
      await emit(unaFila, tx)
    })

    const filas = await db.select().from(auditLog)

    expect(filas).toHaveLength(1)
    expect(filas[0]!.action).toBe('ventas:anular')
  })

  /*
   * El default sigue siendo `db`: las decenas de llamadas que ya existen no se
   * tocan, y las que no están dentro de una transacción —los eventos de sesión
   * y los rechazos, que la ADR deja no bloqueantes— siguen funcionando igual.
   */
  it('sin ejecutor explícito, escribe contra la conexión de siempre', async () => {
    await emit(unaFila)

    expect(await db.select().from(auditLog)).toHaveLength(1)
  })
})
