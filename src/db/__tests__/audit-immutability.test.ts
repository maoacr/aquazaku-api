import type { Sql } from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PG_ERROR, appSql, ownerSql, pgErrorOf, resetDb } from '@/test/db'

/**
 * RN-ACC-04: `audit_log` es append-only.
 *
 * Se prueban las DOS capas por separado, porque cada una tapa el agujero de la
 * otra y una sola no alcanza:
 *
 *   · Permisos — el rol de la aplicación no tiene UPDATE ni DELETE.
 *   · Triggers — rechazan la mutación incluso ejecutada por el dueño.
 */
describe('audit_log — inmutabilidad', () => {
  let app: Sql
  let owner: Sql

  beforeAll(() => {
    app = appSql()
    owner = ownerSql()
  })

  afterAll(async () => {
    await app.end()
    await owner.end()
  })

  beforeEach(async () => {
    await resetDb()
    await app`
      INSERT INTO audit_log (action, result, resource)
      VALUES ('ventas:anular', 'denied', 'ventas')
    `
  })

  describe('la aplicación', () => {
    it('puede insertar', async () => {
      await app`INSERT INTO audit_log (action, result) VALUES ('auth:login', 'ok')`

      const filas = await app<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log`
      expect(filas[0]?.n).toBe('2')
    })

    it('puede leer', async () => {
      const filas = await app<{ action: string }[]>`SELECT action FROM audit_log`
      expect(filas[0]?.action).toBe('ventas:anular')
    })

    it('NO puede modificar — le falta el permiso', async () => {
      const error = await pgErrorOf(
        app`UPDATE audit_log SET action = 'auth:login' WHERE action = 'ventas:anular'`,
      )

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
      // Frena el GRANT, antes de que el trigger llegue a correr.
      expect(error.message).toMatch(/permission denied/i)
    })

    it('NO puede borrar — le falta el permiso', async () => {
      const error = await pgErrorOf(app`DELETE FROM audit_log`)

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
      expect(error.message).toMatch(/permission denied/i)
    })

    it('NO puede truncar', async () => {
      const error = await pgErrorOf(app.unsafe('TRUNCATE audit_log'))

      expect(error.message).toMatch(/permission denied|must be owner/i)
    })

    it('sigue teniendo la fila después de todos los intentos fallidos', async () => {
      const filas = await app<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log`
      expect(filas[0]?.n).toBe('1')
    })
  })

  describe('el dueño de la tabla', () => {
    it('tampoco puede modificar — lo frena el trigger', async () => {
      const error = await pgErrorOf(owner`UPDATE audit_log SET action = 'hackeado'`)

      // El dueño SÍ tiene el permiso: acá el que frena es el trigger.
      expect(error.message).toMatch(/append-only: UPDATE rechazado/i)
    })

    it('tampoco puede borrar — lo frena el trigger', async () => {
      const error = await pgErrorOf(owner`DELETE FROM audit_log`)

      expect(error.message).toMatch(/append-only: DELETE rechazado/i)
    })

    it('tampoco puede truncar — lo frena el trigger', async () => {
      const error = await pgErrorOf(owner.unsafe('TRUNCATE audit_log'))

      expect(error.message).toMatch(/append-only: TRUNCATE rechazado/i)
    })

    /**
     * El caso que motivó usar triggers STATEMENT-level en vez de ROW-level: un
     * `DELETE` que no matchea ninguna fila jamás dispararía un `FOR EACH ROW`, y
     * pasaría en silencio. Tiene que fallar ruidosamente igual.
     */
    it('falla incluso cuando el DELETE no matchea ninguna fila', async () => {
      const error = await pgErrorOf(
        owner`DELETE FROM audit_log WHERE action = 'no-existe-esta-accion'`,
      )

      expect(error.message).toMatch(/append-only: DELETE rechazado/i)
    })
  })

  it('el registro sobrevive a que se borre el usuario que lo generó', async () => {
    const [usuario] = await app<{ id: string }[]>`
      INSERT INTO users (name, email) VALUES ('Temporal', 'temporal@aquazaku.com')
      RETURNING id
    `
    const userId = usuario?.id
    expect(userId).toBeDefined()

    await app`INSERT INTO audit_log (user_id, action, result) VALUES (${userId!}, 'auth:login', 'ok')`
    await app`DELETE FROM users WHERE id = ${userId!}`

    // Sin FK a users a propósito: la auditoría no se borra en cascada.
    const filas = await app<{ user_id: string }[]>`
      SELECT user_id FROM audit_log WHERE user_id = ${userId!}
    `
    expect(filas).toHaveLength(1)
  })
})
