import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
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
export const presentacionEnum = pgEnum('presentacion', ['paca', 'botellon'])

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

/**
 * Catálogo de productos — RN-CAT-01 a 11.
 *
 * Es la única fuente de qué se puede vender. Lo que NO vive acá:
 *
 *   - `stock`  → M2. Mezclar catálogo con inventario los ata para siempre.
 *   - `costo`  → M9. El margen no es un atributo del catálogo.
 *   - el envase retornable → M7 (RN-CAT-05). El botellón se vende como agua,
 *     no como recipiente: un flag acá invitaría a confundir los dos ciclos
 *     de vida, que es justo el error que desangra el parque de envases.
 *
 * Los invariantes viven en la base, no en el servicio. El servicio igual valida
 * —para poder explicar el error en castellano— pero la garantía es el CHECK: un
 * UPDATE directo también tiene que fallar, o RN-CAT-04 sería una promesa vacía.
 */
export const productos = pgTable(
  'productos',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Legible y estable, pero NO es la identidad — RN-CAT-11. Esa es el `id`,
     * igual que el documento no identifica al cliente (RN-CLI-01). Así, un
     * código renombrado no arrastra ventas históricas ni movimientos de stock.
     */
    codigo: text('codigo').notNull(),
    nombre: text('nombre').notNull(),
    presentacion: presentacionEnum('presentacion').notNull(),

    /**
     * Equivalencia en litros — RN-PRD-01: es configuración, no código. El día
     * que salga una bolsa de 500 ml o una paca de 24, se edita un dato.
     *
     * El botellón lleva `unidades = 1` en vez de null para que la fórmula de
     * `litros` sea la misma para los tres productos, sin COALESCE. Que la paca
     * TENGA 20 unidades no la hace divisible: RN-CAT-10 sigue valiendo.
     */
    contenidoMl: integer('contenido_ml').notNull(),
    unidades: integer('unidades').notNull().default(1),

    /**
     * Derivado, calculado por Postgres. Un derivado que se escribe a mano se
     * desincroniza de sus entradas; este no puede.
     */
    litros: numeric('litros', { precision: 10, scale: 3 })
      .notNull()
      .generatedAlwaysAs(sql`(contenido_ml::numeric * unidades) / 1000`),

    /**
     * Los precios viven acá y no en M10 — RN-CAT-03. No es preferencia de
     * diseño: M6 (Ventas) depende de M1 y no de M10, así que con los precios
     * en M10 no se podría vender hasta construirlo.
     *
     * `numeric` y nunca `float`: un peso perdido por redondeo binario es un
     * peso que no cuadra en el cierre.
     */
    precioResidencial: numeric('precio_residencial', { precision: 12, scale: 2 }).notNull(),
    precioComercial: numeric('precio_comercial', { precision: 12, scale: 2 }).notNull(),
    precioMinimo: numeric('precio_minimo', { precision: 12, scale: 2 }).notNull(),

    /**
     * Semántica tributaria — RN-CAT-09. Hoy Aquazaku no retiene IVA ni declara
     * nada, así que estos valores son `true` y `0`.
     *
     * Existen igual porque el día que se conecte la facturación electrónica hay
     * que poder decir qué representaban los precios viejos, y eso no se
     * reconstruye: es información que solo existía al momento de la venta.
     */
    precioIncluyeImpuestos: boolean('precio_incluye_impuestos').notNull().default(true),
    tarifaIvaPorcentaje: numeric('tarifa_iva_porcentaje', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),

    /** RN-CAT-02: un producto no se borra, se desactiva. */
    activo: boolean('activo').notNull().default(true),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('productos_codigo_key').on(t.codigo),
    index('productos_activo_idx').on(t.activo),

    /**
     * RN-CAT-04 — el piso es piso. Acá y no en el servicio: el servicio se
     * puede saltear con un UPDATE directo, el CHECK no.
     */
    check(
      'productos_precio_minimo_es_piso',
      sql`${t.precioMinimo} <= ${t.precioResidencial} AND ${t.precioMinimo} <= ${t.precioComercial}`,
    ),
    check('productos_precios_no_negativos', sql`${t.precioMinimo} >= 0`),
    check('productos_unidades_positivas', sql`${t.unidades} >= 1`),
    check('productos_contenido_positivo', sql`${t.contenidoMl} >= 1`),
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
export type Producto = typeof productos.$inferSelect
export type NuevoProducto = typeof productos.$inferInsert
