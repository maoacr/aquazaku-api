import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { accounts, roles, sessions, userRoles, users } from '@/db/schema'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

describe('schema de M0', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('users.email es citext', () => {
    it('encuentra al usuario sin importar el case', async () => {
      await db.insert(users).values({ name: 'Admin', email: 'Admin@Aquazaku.COM' })

      const encontrado = await db.select().from(users).where(eq(users.email, 'admin@aquazaku.com'))

      expect(encontrado).toHaveLength(1)
      expect(encontrado[0]?.name).toBe('Admin')
    })

    it('rechaza dos emails que solo difieren en el case', async () => {
      await db.insert(users).values({ name: 'Primero', email: 'mao@aquazaku.com' })

      const error = await pgErrorOf(
        db.insert(users).values({ name: 'Segundo', email: 'MAO@AQUAZAKU.COM' }),
      )

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
      expect(error.constraint).toBe('users_email_key')
    })
  })

  describe('defaults de users', () => {
    it('nace activo y obligado a cambiar la contraseña', async () => {
      const [creado] = await db
        .insert(users)
        .values({ name: 'Nuevo', email: 'nuevo@aquazaku.com' })
        .returning()

      expect(creado?.status).toBe('active')
      expect(creado?.mustChangePassword).toBe(true)
      expect(creado?.emailVerified).toBe(false)
      expect(creado?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    })
  })

  describe('multi-rol', () => {
    beforeEach(async () => {
      await db.insert(roles).values([
        { name: 'admin', description: 'Administrador' },
        { name: 'pos', description: 'Punto de venta' },
      ])
    })

    it('un usuario puede tener varios roles a la vez', async () => {
      const [usuario] = await db
        .insert(users)
        .values({ name: 'Multi', email: 'multi@aquazaku.com' })
        .returning()

      await db.insert(userRoles).values([
        { userId: usuario!.id, roleName: 'admin' },
        { userId: usuario!.id, roleName: 'pos' },
      ])

      const asignados = await db.select().from(userRoles).where(eq(userRoles.userId, usuario!.id))
      expect(asignados.map((r) => r.roleName).sort()).toEqual(['admin', 'pos'])
    })

    it('no permite asignar dos veces el mismo rol', async () => {
      const [usuario] = await db
        .insert(users)
        .values({ name: 'Repe', email: 'repe@aquazaku.com' })
        .returning()

      await db.insert(userRoles).values({ userId: usuario!.id, roleName: 'admin' })

      const error = await pgErrorOf(
        db.insert(userRoles).values({ userId: usuario!.id, roleName: 'admin' }),
      )

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    })

    it('rechaza un rol que no está en el catálogo', async () => {
      const [usuario] = await db
        .insert(users)
        .values({ name: 'Invalido', email: 'invalido@aquazaku.com' })
        .returning()

      const error = await pgErrorOf(
        db.insert(userRoles).values({ userId: usuario!.id, roleName: 'gerente' }),
      )

      expect(error.code).toBe(PG_ERROR.FOREIGN_KEY_VIOLATION)
    })
  })

  describe('borrado en cascada', () => {
    it('borrar un usuario se lleva sus sesiones, cuentas y roles', async () => {
      await db.insert(roles).values({ name: 'admin', description: 'Administrador' })
      const [usuario] = await db
        .insert(users)
        .values({ name: 'Efimero', email: 'efimero@aquazaku.com' })
        .returning()

      await db.insert(userRoles).values({ userId: usuario!.id, roleName: 'admin' })
      await db.insert(accounts).values({
        issuer: 'aquazaku',
        accountId: usuario!.id,
        providerId: 'credential',
        userId: usuario!.id,
        password: 'hash-falso',
      })
      await db.insert(sessions).values({
        token: 'token-de-prueba',
        userId: usuario!.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        roles: ['admin'],
      })

      await db.delete(users).where(eq(users.id, usuario!.id))

      expect(await db.select().from(sessions)).toHaveLength(0)
      expect(await db.select().from(accounts)).toHaveLength(0)
      expect(await db.select().from(userRoles)).toHaveLength(0)
    })
  })

  describe('sessions', () => {
    it('guarda todos los roles activos, sin rol "actual"', async () => {
      const [usuario] = await db
        .insert(users)
        .values({ name: 'Sesion', email: 'sesion@aquazaku.com' })
        .returning()

      const [sesion] = await db
        .insert(sessions)
        .values({
          token: 'token-multi-rol',
          userId: usuario!.id,
          expiresAt: new Date(Date.now() + 3_600_000),
          roles: ['pos', 'seller'],
        })
        .returning()

      expect(sesion?.roles).toEqual(['pos', 'seller'])
    })

    it('rechaza dos sesiones con el mismo token', async () => {
      const [usuario] = await db
        .insert(users)
        .values({ name: 'Token', email: 'token@aquazaku.com' })
        .returning()

      const base = {
        userId: usuario!.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        token: 'token-repetido',
      }

      await db.insert(sessions).values(base)
      const error = await pgErrorOf(db.insert(sessions).values(base))

      expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
      expect(error.constraint).toBe('sessions_token_key')
    })
  })
})
