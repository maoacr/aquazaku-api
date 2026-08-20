import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { leerEntorno, sembrar, sembrarRoles } from '../../../drizzle/seed'
import { closeDb, db } from '@/db/client'
import { accounts, roles, userRoles, users } from '@/db/schema'
import { ROLES } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'

const ADMIN = {
  email: 'admin@aquazaku.com',
  nombre: 'Admin Inicial',
  password: 'contrasena-de-seed-123',
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

describe('catálogo de roles', () => {
  it('inserta los cuatro', async () => {
    await sembrarRoles()

    const filas = await db.select().from(roles)
    expect(filas.map((r) => r.name).sort()).toEqual([...ROLES].sort())
  })

  it('todos tienen descripción: la tabla se lee desde psql', async () => {
    await sembrarRoles()

    for (const fila of await db.select().from(roles)) {
      expect(fila.description.length).toBeGreaterThan(10)
    }
  })

  it('es idempotente: correrlo dos veces no duplica ni falla', async () => {
    await sembrarRoles()
    await sembrarRoles()

    expect(await db.select().from(roles)).toHaveLength(ROLES.length)
  })
})

describe('primer administrador', () => {
  it('lo crea con el rol admin', async () => {
    const resultado = await sembrar(ADMIN)

    expect(resultado.creado).toBe(true)
    const [asignacion] = await db.select().from(userRoles)
    expect(asignacion?.roleName).toBe('admin')
  })

  it('la contraseña queda en accounts, con argon2id', async () => {
    await sembrar(ADMIN)

    const [cuenta] = await db.select().from(accounts)
    // El plan insertaba `passwordHash` en `users`, columna que no existe.
    expect(cuenta?.password).toMatch(/^\$argon2id\$/)
    expect(cuenta?.password).not.toContain(ADMIN.password)
  })

  it('nace obligado a cambiar la contraseña', async () => {
    await sembrar(ADMIN)

    const [admin] = await db.select().from(users)
    // La contraseña vino de una variable de entorno: la vio quien hizo el
    // deploy y probablemente quedó en un historial de shell.
    expect(admin?.mustChangePassword).toBe(true)
  })

  it('puede iniciar sesión con la contraseña del seed', async () => {
    await sembrar(ADMIN)

    const { auth } = await import('@/modules/auth/better-auth')
    const res = await auth.api.signInEmail({
      body: { email: ADMIN.email, password: ADMIN.password },
      asResponse: true,
    })

    // Si esto fallara, el seed habría dejado un sistema en el que nadie puede
    // entrar — que es exactamente lo que viene a evitar.
    expect(res.status).toBe(200)
  })

  it('respeta el email y el nombre que se le pasan', async () => {
    await sembrar({ ...ADMIN, email: 'mao@aquazaku.com', nombre: 'Mao Acosta' })

    const [admin] = await db.select().from(users)
    expect(admin?.email).toBe('mao@aquazaku.com')
    expect(admin?.name).toBe('Mao Acosta')
  })

  it('el NOMBRE sí acepta acentos y ñ', async () => {
    // El email no: Better-Auth rechaza caracteres no ASCII en la parte local
    // con "Invalid email address". El nombre es texto libre y sí los acepta —
    // que es lo que importa para que la auditoría muestre bien a las personas.
    await sembrar({ ...ADMIN, nombre: 'Yeimy Rodríguez Muñoz' })

    const [admin] = await db.select().from(users)
    expect(admin?.name).toBe('Yeimy Rodríguez Muñoz')
  })

  it('recorta espacios alrededor del email', async () => {
    await sembrar({ ...ADMIN, email: '  admin@aquazaku.com  ' })

    const [admin] = await db.select().from(users)
    expect(admin?.email).toBe('admin@aquazaku.com')
  })
})

describe('idempotencia: corre en cada deploy sin romper nada', () => {
  it('con un admin activo no crea otro, y NO falla', async () => {
    await sembrar(ADMIN)

    const segunda = await sembrar({ ...ADMIN, email: 'otro@aquazaku.com' })

    // Abortar con error dejaría el script fuera de cualquier pipeline: nadie
    // pone en su deploy un paso que falla la segunda vez.
    expect(segunda).toEqual({ creado: false, motivo: 'ya-hay-admin' })
    expect(await db.select().from(users)).toHaveLength(1)
  })

  it('un admin DESACTIVADO no cuenta: si contara, nadie podría entrar', async () => {
    await sembrar(ADMIN)
    await db.update(users).set({ status: 'inactive' }).where(eq(users.email, ADMIN.email))

    const segunda = await sembrar({ ...ADMIN, email: 'rescate@aquazaku.com' })

    expect(segunda.creado).toBe(true)
  })

  it('un usuario sin rol admin no bloquea el seed', async () => {
    await sembrarRoles()
    const { auth } = await import('@/modules/auth/better-auth')
    await auth.api.signUpEmail({
      body: { name: 'Vendedor', email: 'vendedor@aquazaku.com', password: 'contrasena-123' },
    })

    expect((await sembrar(ADMIN)).creado).toBe(true)
  })
})

describe('validación del entorno', () => {
  it('exige SEED_ADMIN_PASSWORD', () => {
    const problema = leerEntorno({})

    expect(problema).toMatchObject({ mensaje: expect.stringContaining('SEED_ADMIN_PASSWORD') })
  })

  it('el mensaje dice cómo generar una', () => {
    expect(leerEntorno({})).toMatchObject({ mensaje: expect.stringContaining('openssl rand') })
  })

  it('rechaza contraseñas cortas', () => {
    expect(leerEntorno({ SEED_ADMIN_PASSWORD: 'corta' })).toMatchObject({
      mensaje: expect.stringContaining('8 caracteres'),
    })
  })

  it('en producción exige SEED_CONFIRM=yes', () => {
    const problema = leerEntorno({
      NODE_ENV: 'production',
      SEED_ADMIN_PASSWORD: 'contrasena-larga-123',
    })

    // Este script crea una cuenta con acceso total: no puede correr solo por
    // accidente en un pipeline de producción.
    expect(problema).toMatchObject({ mensaje: expect.stringContaining('SEED_CONFIRM=yes') })
  })

  it('en producción con la confirmación, pasa', () => {
    const entorno = leerEntorno({
      NODE_ENV: 'production',
      SEED_CONFIRM: 'yes',
      SEED_ADMIN_PASSWORD: 'contrasena-larga-123',
    })

    expect(entorno).toMatchObject({ password: 'contrasena-larga-123' })
  })

  it('en desarrollo no pide confirmación', () => {
    expect(leerEntorno({ SEED_ADMIN_PASSWORD: 'contrasena-larga-123' })).toMatchObject({
      email: 'admin@aquazaku.com',
      nombre: 'Admin Inicial',
    })
  })

  it('SEED_CONFIRM con cualquier otro valor no alcanza', () => {
    for (const valor of ['true', '1', 'YES', 'si']) {
      expect(
        leerEntorno({
          NODE_ENV: 'production',
          SEED_CONFIRM: valor,
          SEED_ADMIN_PASSWORD: 'contrasena-larga-123',
        }),
        `SEED_CONFIRM=${valor} no debería alcanzar`,
      ).toMatchObject({ mensaje: expect.stringContaining('SEED_CONFIRM=yes') })
    }
  })

  it('respeta email y nombre del entorno', () => {
    expect(
      leerEntorno({
        SEED_ADMIN_PASSWORD: 'contrasena-larga-123',
        SEED_ADMIN_EMAIL: 'mao@aquazaku.com',
        SEED_ADMIN_NAME: 'Mao',
      }),
    ).toMatchObject({ email: 'mao@aquazaku.com', nombre: 'Mao' })
  })
})
