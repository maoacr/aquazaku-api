import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { accounts, sessions, userRoles, users, verifications } from '@/db/schema'
import { env } from '@/lib/env'
import { COOKIE_SESION } from '@/modules/authz/middleware'

/**
 * Better-Auth: SOLO identidad.
 *
 * La autorización es nuestra (`modules/authz/`). La división es deliberada
 * (ADR-0001): Better-Auth sabe *quién sos*; la matriz sabe *qué podés hacer*.
 *
 * ── Por qué NO se usa el plugin `admin` ──────────────────────────────────────
 *
 * El plugin trae su propio `user.role`: **un** string por usuario. Aquazaku
 * modela multi-rol en `user_roles` (N:M) y resuelve permisos con una matriz en
 * código, donde un usuario puede ser `pos` y `seller` a la vez (RN-ACC-01).
 * Activarlo dejaría dos fuentes de verdad para los roles, que es la clase de
 * bug que no se encuentra nunca.
 *
 * Además pide columnas que no tenemos (`banned`, `banReason`, `banExpires`,
 * `session.impersonatedBy`), y su CRUD de usuarios lo construimos nosotros en
 * la Task 8, con auditoría propia.
 */
export const auth = betterAuth({
  appName: 'aquazaku',

  database: drizzleAdapter(db, {
    provider: 'pg',
    // Better-Auth nombra sus modelos en singular; nuestras tablas son plurales,
    // como el resto del schema. El mapeo va acá para no ensuciar la base con
    // dos convenciones distintas.
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_PUBLIC_URL],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Crear una cuenta no inicia sesión: en Aquazaku las cuentas las crea un
    // admin desde el panel, no la persona que va a usarlas.
    autoSignIn: false,
    password: {
      // argon2id, no el scrypt que Better-Auth trae por defecto. Lo pide el
      // spec §5 y es el estándar actual para contraseñas.
      hash: (password) => argonHash(password),
      verify: ({ hash, password }) => argonVerify(hash, password),
    },
  },

  user: {
    additionalFields: {
      status: { type: 'string', defaultValue: 'active', input: false },
      mustChangePassword: { type: 'boolean', defaultValue: true, input: false },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    // Ventana deslizante (spec §7.5): la sesión se renueva si se usa después de
    // un día. Este es el único dueño del ciclo de vida de la sesión — el
    // middleware de authz solo valida, no renueva.
    updateAge: 60 * 60 * 24,
    additionalFields: {
      roles: { type: 'string[]', defaultValue: [], input: false },
    },
  },

  advanced: {
    database: {
      // Sin esto Better-Auth genera ids con su propio formato de string y los
      // INSERT contra nuestras columnas `uuid` fallan.
      generateId: 'uuid',
    },
    cookies: {
      session_token: {
        name: COOKIE_SESION,
        attributes: {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: env.NODE_ENV === 'production',
          domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
        },
      },
    },
  },

  databaseHooks: {
    session: {
      create: {
        /**
         * Congela los roles del usuario dentro de la sesión.
         *
         * Se leen una vez al login y viajan en la sesión, así el middleware no
         * consulta `user_roles` en cada request. RN-ACC-01: van TODOS los roles,
         * activos simultáneamente — no existe rol actual ni switch.
         *
         * Consecuencia a tener presente: cambiarle los roles a alguien no le
         * afecta la sesión abierta. Task 8 debe invalidar las sesiones del
         * usuario al modificarle los roles.
         */
        before: async (session) => {
          const filas = await db
            .select({ roleName: userRoles.roleName })
            .from(userRoles)
            .where(eq(userRoles.userId, session.userId))

          return { data: { ...session, roles: filas.map((f) => f.roleName) } }
        },
      },
    },
  },
})

export type Auth = typeof auth
