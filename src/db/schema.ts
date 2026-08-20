import {
  bigserial,
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * `citext` — texto case-insensitive nativo de Postgres.
 *
 * Drizzle no lo trae, así que se declara. Se usa en `users.email` para que la
 * unicidad y el login sean case-insensitive **en la base**, sin depender de que
 * cada query se acuerde de meter un `LOWER()`. La garantía que no depende de la
 * disciplina del que escribe la query es la única que sobrevive.
 *
 * Requiere `CREATE EXTENSION citext` — lo hace la primera migración.
 */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext'
  },
})

/** Timestamp con zona horaria. Todas las fechas del sistema son timestamptz. */
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const userStatusEnum = pgEnum('user_status', ['active', 'inactive'])
export const auditResultEnum = pgEnum('audit_result', ['ok', 'denied'])

// ─────────────────────────────────────────────────────────────────────────────
// Tablas que administra Better-Auth
//
// Los NOMBRES DE CAMPO en TypeScript (emailVerified, userId, ipAddress…) los
// impone Better-Auth: su adapter de Drizzle los busca por ese nombre exacto. Las
// COLUMNAS en la base van en snake_case, que es la convención de Postgres.
// Drizzle traduce entre ambos.
//
// Los nombres de tabla son plurales porque es la convención del resto del
// schema; Better-Auth espera singular, así que Task 5 debe mapearlos con
// `modelName` en su config.
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: citext('email').notNull(),
    // Requerido por Better-Auth. En Aquazaku las cuentas las crea un admin, así
    // que no hay verificación por email: el seed y el alta marcan `true`.
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),

    // Campos propios de Aquazaku (van como `additionalFields` en la config de
    // Better-Auth).
    status: userStatusEnum('status').notNull().default('active'),
    mustChangePassword: boolean('must_change_password').notNull().default(true),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Better-Auth guarda el token aparte del id. Es lo que viaja en la cookie.
    token: text('token').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    // `text` y no `inet`: Better-Auth escribe acá lo que venga en el header, que
    // no siempre es una IP parseable. Con `inet` un proxy mal configurado tira
    // el login abajo.
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Campo propio: todos los roles del usuario, congelados al momento del
    // login. NO existe `active_role` ni switch — RN-ACC-01.
    roles: text('roles').array().notNull().default([]),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('sessions_token_key').on(t.token), index('sessions_user_idx').on(t.userId)],
)

/**
 * Credenciales. **Acá vive el hash de la contraseña**, no en `users` — así lo
 * modela Better-Auth, que separa identidad de credencial para poder sumar
 * proveedores OAuth sin tocar la tabla de usuarios.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // `issuer` es requerido desde Better-Auth 1.7 y forma índice único con
    // `accountId`.
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Hash argon2id para el proveedor `credential`. Nulo en cuentas OAuth.
    password: text('password'),

    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('accounts_issuer_account_id_key').on(t.issuer, t.accountId),
    index('accounts_user_idx').on(t.userId),
  ],
)

/** Tokens de un solo uso: recuperación de contraseña (Task 7). */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
)

// ─────────────────────────────────────────────────────────────────────────────
// Tablas propias de Aquazaku
// ─────────────────────────────────────────────────────────────────────────────

/** Catálogo cerrado de roles. Las cuatro filas las crea el seed (Task 14). */
export const roles = pgTable('roles', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
})

/**
 * Multi-rol: un usuario tiene N roles y todos están activos a la vez. La unión
 * de permisos se calcula en `authz/can.ts` (Task 3), no acá.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleName: text('role_name')
      .notNull()
      .references(() => roles.name),
    grantedAt: tstz('granted_at').notNull().defaultNow(),
    // Quién otorgó el rol. Se conserva aunque ese admin se borre después, por
    // eso es `set null` y no `cascade`.
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleName] })],
)

/**
 * Bitácora inmutable — RN-ACC-04.
 *
 * Append-only, garantizado por DOS mecanismos independientes que se instalan en
 * la primera migración:
 *
 *  1. Triggers que rechazan UPDATE y DELETE. Aplican a todo el mundo, incluido
 *     el dueño de la tabla.
 *  2. El rol de la aplicación (`aquazaku_app`) tiene SELECT e INSERT, y nada
 *     más. No es dueño de la tabla, así que tampoco puede desactivar el trigger.
 *
 * Uno solo no alcanza: los triggers los puede desactivar el dueño, y los
 * permisos por sí solos no frenan a quien se conecte con el rol dueño.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Sin FK a users a propósito: si un usuario se borra, su rastro de auditoría
    // tiene que sobrevivir. Un log que se borra en cascada no es un log.
    userId: uuid('user_id'),
    // Todos los roles que el usuario tenía activos al ejecutar la acción.
    rolEjercido: text('rol_ejercido').array(),
    action: text('action').notNull(),
    resource: text('resource'),
    resourceId: text('resource_id'),
    result: auditResultEnum('result').notNull(),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    payload: jsonb('payload'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_user_idx').on(t.userId),
    index('audit_created_idx').on(t.createdAt),
    index('audit_action_idx').on(t.action),
    index('audit_result_idx').on(t.result),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type Account = typeof accounts.$inferSelect
export type Role = typeof roles.$inferSelect
export type UserRole = typeof userRoles.$inferSelect
export type AuditLogEntry = typeof auditLog.$inferSelect
export type NewAuditLogEntry = typeof auditLog.$inferInsert
