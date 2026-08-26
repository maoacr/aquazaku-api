import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
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

/**
 * Qué documento originó un movimiento de stock — RN-STK-02.
 *
 * El stock nunca se edita: se mueve mediante documentos con nombre. Este enum
 * es la lista cerrada de esos documentos, y el módulo que lo produce.
 */
export const tipoMovimientoEnum = pgEnum('tipo_movimiento', [
  'produccion', // M4 — el cierre diario genera lote y entra producto
  'ajuste', // M2 — inventario físico, carga inicial
  'descarte', // M2 — sale y no vuelve
  'venta', // M6 — sale
  'devolucion', // M6 — vuelve al MISMO lote (RN-STK-05)
])

/**
 * Los tanques del sistema — RN-PRD-02.
 *
 * Son `crudo` y `procesado`, y NO `procesado_a` / `procesado_b`. Los dos tanques
 * de 2.000 L se operan en PARALELO —se llenan juntos y se vacían juntos,
 * RN-PRD-21—, así que modelarlos por separado duplicaría cada escritura para que
 * las dos filas digan siempre lo mismo. La capacidad del procesado es 4.000 L.
 *
 * Si algún día se operan por separado, ahí se parte el enum, y quien lo haga va
 * a tener que decidir conscientemente cómo se reparte lo que ya está guardado.
 */
export const tanqueEnum = pgEnum('tanque', ['crudo', 'procesado'])

/**
 * Cómo se mueve el agua.
 *
 * `ingreso_red` NO lleva cantidad medida: no hay medidor ni regleta
 * (RN-PRD-11). Registra el HECHO de que llegó agua, y el saldo sube hasta la
 * banda observada. Es una recalibración con motivo, no una medición.
 */
export const tipoMovimientoAguaEnum = pgEnum('tipo_movimiento_agua', [
  'ingreso_red', // llegó agua de la red — sin cantidad exacta
  'procesamiento', // crudo → procesado, con la merma del 30% ya aplicada
  'envasado', // sale procesada y se convierte en producto
  'lavado', // sale procesada y NO genera producto — RN-PRD-05
  'ajuste', // el saldo no cuadraba; exige motivo
])

/**
 * El nivel del tanque, como se puede ver de verdad — RN-PRD-11.
 *
 * En cuartos y no en litros porque eso es lo que el ojo distingue. Pedir un
 * número exacto obligaría a inventar precisión, que es justo lo que RN-PRD-15
 * prohíbe.
 */
export const nivelTanqueEnum = pgEnum('nivel_tanque', [
  'vacio',
  'un_cuarto',
  'medio',
  'tres_cuartos',
  'lleno',
])

/**
 * En qué se CUENTA el saldo de un insumo — RN-INS-02.
 *
 * Hoy solo hay un valor, y es a propósito que exista igual. Las bolsas se
 * COMPRAN por kilo y se GUARDAN por unidad: el kilo es la unidad de la compra,
 * no la del inventario.
 *
 * La tentación era un enum con `unidad` y `kilo` para que cada insumo eligiera.
 * Es una trampa: el saldo significaría una cosa u otra según la fila, y toda
 * consulta que sume, compare con el mínimo o pregunte «cuánto queda» tendría
 * que ramificar. El día que alguien olvide ramificar va a comparar 3 kilos
 * contra un mínimo de 200 unidades y concluir que hay que pedir.
 */
export const unidadInsumoEnum = pgEnum('unidad_insumo', ['unidad'])

/**
 * Cómo se mueve un insumo de empaque — M3.
 *
 * NO tiene `venta`, y es la regla `RN-INS-01` hecha tipo: un insumo no se
 * despacha a un cliente, desaparece cuando se convierte en producto. Si algún
 * día aparece una salida de insumo que no viene de un cierre de producción, o
 * alguien la registró mal o hay una pérdida que hay que explicar.
 */
export const tipoMovimientoInsumoEnum = pgEnum('tipo_movimiento_insumo', [
  'compra', // entra por proveedor — en unidades o en kilos
  'ajuste', // conteo físico; exige motivo
  'descarte', // se rompió o se mojó; exige causa
  'produccion', // M4 — el cierre lo consume (RN-INS-01)
])

/** Causas de descarte — RN-STK-06. Sin clasificar, no se descarta. */
export const causaDescarteEnum = pgEnum('causa_descarte', [
  'falla_produccion', // Aquazaku repone al cliente
  'mal_manejo_cliente', // el cliente asume; entra a su historial
  'vencido', // objetivo, no hace falta clasificar más
  'otro', // queda marcado para revisión del admin
])

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

/**
 * Lotes de producto terminado — RN-STK-08.
 *
 * Un lote es "este producto, empacado este día". Lleva su propio saldo encima
 * en vez de vivir en una tabla aparte: un lote ya es producto + fecha, y una
 * tabla de saldos solo repetiría esa clave para agregar un número.
 *
 * ── El saldo no se edita ────────────────────────────────────────────────────
 *
 * `cantidad_disponible` se mueve insertando un movimiento, nunca con un UPDATE
 * suelto (RN-STK-02). La operación correcta decide y descuenta a la vez:
 *
 *     UPDATE lotes SET cantidad_disponible = cantidad_disponible - $n
 *      WHERE id = $lote AND cantidad_disponible >= $n
 *
 * Leer el saldo, comparar en TypeScript y después restar deja una ventana entre
 * la decisión y el efecto — y por esa ventana se vende producto que no existe.
 * El mostrador y la preparación de pedidos descuentan del mismo saldo al mismo
 * tiempo (RN-STK-01): la concurrencia acá es un caso real, no teórico.
 */
export const lotes = pgTable(
  'lotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productoId: uuid('producto_id')
      .notNull()
      .references(() => productos.id),

    /** `YYYY-MM-DD-L1`. Se imprime en la bolsa física — RN-STK-08. */
    codigo: text('codigo').notNull(),

    fechaEmpaque: date('fecha_empaque').notNull(),

    /**
     * GUARDADA, no generada. Es la diferencia con `litros` en `productos`, y es
     * fácil equivocarse porque las dos las calcula el sistema.
     *
     * `litros` es una DEFINICIÓN: 12 L es lo que una paca *es*, y si cambian
     * sus entradas debe recalcularse. Esto es un HECHO DE UN MOMENTO: este lote
     * vence este día.
     *
     * Con una columna generada, cambiar la regla a 45 días recalcularía el
     * vencimiento de todos los lotes del pasado —incluidos los ya vendidos— y
     * eso es exactamente lo que RN-CAT-07 prohíbe para los precios: una regla
     * nueva no puede reescribir lo que ya pasó.
     */
    fechaVencimiento: date('fecha_vencimiento').notNull(),

    cantidadInicial: integer('cantidad_inicial').notNull(),
    cantidadDisponible: integer('cantidad_disponible').notNull(),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lotes_codigo_key').on(t.codigo),
    // FIFO consulta por producto ordenando por vencimiento: el índice ES el orden.
    index('lotes_fifo_idx').on(t.productoId, t.fechaVencimiento),

    // RN-STK-03: no hay venta con stock negativo. Acá y no en el servicio,
    // porque el servicio se puede saltear con un UPDATE directo (ADR-0006).
    check('lotes_saldo_no_negativo', sql`${t.cantidadDisponible} >= 0`),
    check('lotes_cantidad_inicial_positiva', sql`${t.cantidadInicial} > 0`),
    check('lotes_vence_despues_de_empacar', sql`${t.fechaVencimiento} > ${t.fechaEmpaque}`),
  ],
)

/**
 * Libro de movimientos de stock — RN-STK-02.
 *
 * Append-only, igual que `audit_log` (ADR-0004): el rol de la aplicación tiene
 * SELECT e INSERT y nada más. Un libro que se puede editar no es un libro — es
 * una tabla que alguna vez coincidió con la realidad.
 *
 * Cada movimiento y el saldo que produce se escriben en la MISMA transacción.
 * Si el saldo baja y el movimiento no queda, el libro deja de explicar el saldo:
 * es la primera forma de descuadre y la más difícil de rastrear después.
 */
export const movimientosStock = pgTable(
  'movimientos_stock',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    loteId: uuid('lote_id')
      .notNull()
      .references(() => lotes.id),

    /** Positivo entra, negativo sale. Nunca cero. */
    cantidad: integer('cantidad').notNull(),
    tipo: tipoMovimientoEnum('tipo').notNull(),

    /** Obligatorio en ajuste — RN-STK-02. Lo exige un CHECK, no el servicio. */
    motivo: text('motivo'),
    /** Obligatoria en descarte — RN-STK-06. */
    causa: causaDescarteEnum('causa'),

    /** La venta o el cierre de producción que lo originó. Null en ajuste manual. */
    documentoId: uuid('documento_id'),

    // Se conserva el movimiento aunque el usuario se borre: un libro que pierde
    // filas cuando se va alguien no sirve para cuadrar nada.
    registradoPor: uuid('registrado_por').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('movimientos_lote_idx').on(t.loteId),
    index('movimientos_fecha_idx').on(t.createdAt),
    index('movimientos_tipo_idx').on(t.tipo),

    check('movimientos_cantidad_no_cero', sql`${t.cantidad} <> 0`),

    /**
     * Los dos CHECK condicionales exigen el dato SOLO donde corresponde, sin
     * obligar a un motivo en una venta.
     *
     * Van en la base y no en el servicio porque un ajuste sin motivo que entre
     * por un script deja el inventario descuadrado sin nadie a quién
     * preguntarle.
     */
    check('movimientos_ajuste_con_motivo', sql`${t.tipo} <> 'ajuste' OR ${t.motivo} IS NOT NULL`),
    check('movimientos_descarte_con_causa', sql`${t.tipo} <> 'descarte' OR ${t.causa} IS NOT NULL`),
  ],
)

/**
 * ═══ Insumos de empaque — M3 ═══════════════════════════════════════════════
 *
 * Tapas, sellos y bolsas: lo que se consume al producir. No se venden.
 *
 * Mismo patrón que M2: la tabla lleva el saldo encima y `movimientos_insumo` es
 * el libro que lo explica. Los dos se escriben en la MISMA transacción.
 */
export const insumos = pgTable(
  'insumos',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `TAPA_20L`, `BOLSA_600`. En mayúsculas, como el código de producto. */
    codigo: text('codigo').notNull(),
    nombre: text('nombre').notNull(),

    /**
     * Hoy solo vale `unidad`, y parece una columna inútil. Está por una razón:
     * hace EXPLÍCITO en el esquema que el saldo se cuenta en unidades y que el
     * kilo es de la compra (RN-INS-02).
     *
     * Sin ella, alguien que vea que las bolsas se compran por kilo va a asumir
     * que el saldo también, y va a tener razón en asumirlo — no habría nada que
     * diga lo contrario. Si algún día entra un insumo que de verdad se almacene
     * por peso, esta columna es donde se decide, y quien la agregue va a tener
     * que resolver la ramificación conscientemente en vez de heredarla.
     */
    unidad: unidadInsumoEnum('unidad').notNull().default('unidad'),

    /**
     * El umbral que dispara el aviso — RN-INS-03. Valor inicial 200 para tapas
     * y sellos, CONFIGURABLE: el mínimo correcto es «lo que consumo mientras
     * llega el pedido», y eso depende del ritmo de producción y del proveedor.
     * Ninguno de los dos está medido. Pasa a parámetro en M12.
     */
    minimo: integer('minimo').notNull(),

    /**
     * Unidades en existencia. Lo mueve un UPDATE condicional, nunca una lectura
     * seguida de una escritura: dos salidas simultáneas leerían el mismo saldo
     * y las dos restarían sobre él.
     */
    saldo: integer('saldo').notNull().default(0),

    /**
     * Cuántas unidades trae un kilo. NULL hasta medirlo en planta.
     *
     * Es el valor VIGENTE, y sirve para proponer la conversión al cargar una
     * compra. El valor que se USÓ queda copiado en el movimiento: por eso
     * cambiar esto no reescribe la historia.
     *
     * NULL no es un dato faltante por descuido: es la pregunta 37, y mientras
     * siga así el sistema RECHAZA la entrada por kilos en vez de inventar un
     * número. Una equivalencia mal puesta descuadra el inventario en silencio.
     */
    equivalenciaPorKilo: numeric('equivalencia_por_kilo', { precision: 10, scale: 3 }),

    activo: boolean('activo').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('insumos_codigo_idx').on(t.codigo),
    index('insumos_activo_idx').on(t.activo),

    check('insumos_minimo_positivo', sql`${t.minimo} > 0`),

    /*
     * La red de abajo, para lo que entre por fuera del servicio. NO es lo que
     * resuelve la carrera: un CHECK valida la fila que se escribe, no la suma
     * de las que existen. Eso lo resuelve el UPDATE condicional del servicio, y
     * se verifica quitándole la condición.
     */
    check('insumos_saldo_no_negativo', sql`${t.saldo} >= 0`),

    /* Cero unidades por kilo convertiría cualquier compra en cero unidades. */
    check(
      'insumos_equivalencia_positiva',
      sql`${t.equivalenciaPorKilo} IS NULL OR ${t.equivalenciaPorKilo} > 0`,
    ),
  ],
)

/**
 * El libro de los insumos. Append-only, igual que `movimientos_stock`.
 */
export const movimientosInsumo = pgTable(
  'movimientos_insumo',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    insumoId: uuid('insumo_id')
      .notNull()
      .references(() => insumos.id),

    /** UNIDADES. Positivo entra, negativo sale. Nunca cero. */
    cantidad: integer('cantidad').notNull(),
    tipo: tipoMovimientoInsumoEnum('tipo').notNull(),

    /** Obligatorio en ajuste. Lo exige un CHECK, no el servicio. */
    motivo: text('motivo'),
    /** Obligatoria en descarte. */
    causa: causaDescarteEnum('causa'),

    /**
     * Los dos campos de la conversión, cuando la compra vino en kilos.
     *
     * Van JUNTOS o ninguno, y lo exige un CHECK. Sin eso se puede guardar
     * «entraron 12 kilos» sin decir a cuántas unidades se convirtieron, y ese
     * movimiento no se puede auditar después: no hay forma de saber si el
     * descuadre vino de la balanza o de la equivalencia.
     *
     * `equivalencia` se copia acá y no se lee del insumo a propósito. Es el
     * valor que se usó ESE DÍA, y va a cambiar — el grosor de la bolsa varía
     * entre lotes. Leerla del insumo haría que actualizarla reescribiera la
     * historia, que es el mismo error que M2 evitó con `fecha_vencimiento`.
     */
    kilos: numeric('kilos', { precision: 10, scale: 3 }),
    equivalencia: numeric('equivalencia', { precision: 10, scale: 3 }),

    /** La compra o el cierre que lo originó. Null en ajuste manual. */
    documentoId: uuid('documento_id'),

    // Se conserva el movimiento aunque el usuario se borre: un libro que pierde
    // filas cuando se va alguien no sirve para cuadrar nada.
    registradoPor: uuid('registrado_por').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('movimientos_insumo_insumo_idx').on(t.insumoId),
    index('movimientos_insumo_fecha_idx').on(t.createdAt),
    index('movimientos_insumo_tipo_idx').on(t.tipo),

    check('movimientos_insumo_cantidad_no_cero', sql`${t.cantidad} <> 0`),

    check(
      'movimientos_insumo_ajuste_con_motivo',
      sql`${t.tipo} <> 'ajuste' OR ${t.motivo} IS NOT NULL`,
    ),
    check(
      'movimientos_insumo_descarte_con_causa',
      sql`${t.tipo} <> 'descarte' OR ${t.causa} IS NOT NULL`,
    ),

    /* Los dos campos de la conversión, juntos o ninguno. */
    check(
      'movimientos_insumo_conversion_completa',
      sql`(${t.kilos} IS NULL) = (${t.equivalencia} IS NULL)`,
    ),

    /* Una compra en kilos con cero kilos, o convertida con cero, no es una compra. */
    check(
      'movimientos_insumo_conversion_positiva',
      sql`${t.kilos} IS NULL OR (${t.kilos} > 0 AND ${t.equivalencia} > 0)`,
    ),
  ],
)

/**
 * ═══ Producción — M4 ═══════════════════════════════════════════════════════
 *
 * El cierre diario es LA BISAGRA del sistema: el único evento que convierte
 * litros en producto. Por eso toca tres módulos a la vez — descuenta agua,
 * descuenta insumos e ingresa stock — y los cuatro escritos van en la MISMA
 * transacción.
 *
 * Un cierre parcial no es un cierre a medias: es un documento que dice que se
 * envasaron 200 botellones con las tapas intactas. Una mentira consistente, que
 * es la clase de dato que nadie sospecha hasta que ya causó daño.
 */
export const cierresProduccion = pgTable(
  'cierres_produccion',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Uno por día — RN-PRD-22. No se registra por tanda. */
    fecha: date('fecha').notNull(),

    // ── El procesamiento — RN-PRD-18 ──────────────────────────────────────
    /** Del encendido al apagado, que registra el `pos` — RN-PRD-24. */
    minutosProcesando: integer('minutos_procesando').notNull(),

    /**
     * El caudal que se usó ESE DÍA. Se COPIA, no se referencia.
     *
     * Es la tercera vez que aparece este patrón —`fecha_vencimiento` en M2,
     * `equivalencia` en M3— así que ya no es una decisión: es la regla del
     * proyecto. Un hecho de un momento no se recalcula.
     *
     * Acá pesa especialmente porque el caudal TODAVÍA NO SE MIDIÓ (preguntas 4
     * y 5). Cuando se mida, corregirlo con una referencia viva reescribiría
     * cuántos litros se procesaron todos los días del pasado.
     */
    caudalGpm: numeric('caudal_gpm', { precision: 10, scale: 3 }),

    /**
     * `caudal × minutos × 3,785 × 0,70` — RN-PRD-12, el rendimiento del 70%.
     *
     * GUARDADO y no generado, por lo mismo: si algún día se corrige el
     * rendimiento, los cierres viejos tienen que seguir diciendo lo que dijeron.
     *
     * NULL mientras no haya caudal: el sistema no estima. Es el mismo criterio
     * que la equivalencia de las bolsas en M3.
     */
    litrosProcesados: integer('litros_procesados'),

    // ── El envasado — RN-PRD-04 ───────────────────────────────────────────
    pacas600: integer('pacas_600').notNull().default(0),
    pacas300: integer('pacas_300').notNull().default(0),
    botellonesLlenados: integer('botellones_llenados').notNull().default(0),
    /** Consume agua y NO genera producto — RN-PRD-05. */
    botellonesLavados: integer('botellones_lavados').notNull().default(0),

    // ── El cierre del balance ─────────────────────────────────────────────
    /**
     * Derivado de las cuatro cifras de arriba, con las equivalencias vigentes
     * ese día. También guardado: `productos.litros` es una columna generada que
     * puede cambiar si cambia la definición de una paca, y eso no debería mover
     * lo que consumió un día de hace tres meses.
     */
    litrosConsumidos: integer('litros_consumidos').notNull(),

    /**
     * La lectura visual del tanque, en cuartos — RN-PRD-11.
     *
     * NULL si no se miró. No es obligatorio: reconcilia, no corrige, y forzarlo
     * llevaría a que alguien ponga cualquier cosa para poder cerrar el día.
     */
    nivelObservado: nivelTanqueEnum('nivel_observado'),

    registradoPor: uuid('registrado_por').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    /* Un cierre por día — RN-PRD-22. Dos cierres serían dos verdades. */
    uniqueIndex('cierres_fecha_idx').on(t.fecha),

    check('cierres_minutos_positivos', sql`${t.minutosProcesando} > 0`),
    check(
      'cierres_conteos_no_negativos',
      sql`${t.pacas600} >= 0 AND ${t.pacas300} >= 0 AND ${t.botellonesLlenados} >= 0 AND ${t.botellonesLavados} >= 0`,
    ),
    check('cierres_consumo_no_negativo', sql`${t.litrosConsumidos} >= 0`),

    /* Los dos del procesamiento van juntos o ninguno: sin caudal no hay litros. */
    check(
      'cierres_procesamiento_completo',
      sql`(${t.caudalGpm} IS NULL) = (${t.litrosProcesados} IS NULL)`,
    ),
    check(
      'cierres_caudal_positivo',
      sql`${t.caudalGpm} IS NULL OR (${t.caudalGpm} > 0 AND ${t.litrosProcesados} > 0)`,
    ),
  ],
)

/**
 * El libro del agua. Append-only, igual que los otros dos libros del sistema.
 *
 * ── Lo que esta tabla NO tiene, y es lo importante ────────────────────────
 *
 * No hay ninguna columna que diga cuántos litros entraron de la red. No hay
 * medidor ni regleta (RN-PRD-11), y un campo que invite a llenarlo a ojo
 * **fabrica precisión que no existe** — RN-PRD-15.
 *
 * Un `ingreso_red` lleva `litros: 0`: registra el HECHO de que llegó agua. El
 * saldo se recalibra después contra la banda observada, con un `ajuste` que
 * exige motivo. Así queda claro cuál número es medido y cuál es estimado, que es
 * justo lo que se pierde cuando alguien completa un campo «para que no quede
 * vacío».
 */
export const movimientosAgua = pgTable(
  'movimientos_agua',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tanque: tanqueEnum('tanque').notNull(),

    /** Positivo entra, negativo sale. Cero SOLO en `ingreso_red`. */
    litros: integer('litros').notNull(),
    tipo: tipoMovimientoAguaEnum('tipo').notNull(),

    /** Obligatorio en ajuste. Lo exige un CHECK, no el servicio. */
    motivo: text('motivo'),

    /** El cierre que lo originó. NULL en ingreso de red y en ajuste manual. */
    cierreId: uuid('cierre_id').references(() => cierresProduccion.id),

    registradoPor: uuid('registrado_por').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('movimientos_agua_tanque_idx').on(t.tanque),
    index('movimientos_agua_fecha_idx').on(t.createdAt),
    index('movimientos_agua_cierre_idx').on(t.cierreId),

    /*
     * Cero solo se permite en `ingreso_red`, y esa excepción ES la regla de
     * RN-PRD-11 hecha CHECK: llegó agua, no sabemos cuánta. Cualquier otro
     * movimiento con cero sería un registro que no movió nada.
     */
    check(
      'movimientos_agua_cantidad',
      sql`(${t.tipo} = 'ingreso_red' AND ${t.litros} = 0) OR (${t.tipo} <> 'ingreso_red' AND ${t.litros} <> 0)`,
    ),

    check('movimientos_agua_ajuste_con_motivo', sql`${t.tipo} <> 'ajuste' OR ${t.motivo} IS NOT NULL`),
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
export type Lote = typeof lotes.$inferSelect
export type NuevoLote = typeof lotes.$inferInsert
export type MovimientoStock = typeof movimientosStock.$inferSelect
export type NuevoMovimientoStock = typeof movimientosStock.$inferInsert
export type Insumo = typeof insumos.$inferSelect
export type NuevoInsumo = typeof insumos.$inferInsert
export type MovimientoInsumo = typeof movimientosInsumo.$inferSelect
export type NuevoMovimientoInsumo = typeof movimientosInsumo.$inferInsert

export type CierreProduccion = typeof cierresProduccion.$inferSelect
export type NuevoCierreProduccion = typeof cierresProduccion.$inferInsert
export type MovimientoAgua = typeof movimientosAgua.$inferSelect
export type NuevoMovimientoAgua = typeof movimientosAgua.$inferInsert


// ─────────────────────────────────────────────────────────────────────────────
// Clientes — M5
// ─────────────────────────────────────────────────────────────────────────────

/** Define qué lista de precios se le aplica — RN-CLI-16. */
export const tipoClienteEnum = pgEnum('tipo_cliente', ['residencial', 'comercial'])

/**
 * Los dos identificadores que conviven en Colombia — RN-CLI-09.
 *
 * El NIT de una persona natural se basa en su cédula, así que el mismo número
 * puede existir como `CC` y como `NIT` y ser la misma persona. Por eso la
 * unicidad va sobre el PAR y no sobre el número.
 */
export const tipoDocumentoEnum = pgEnum('tipo_documento', ['CC', 'NIT'])

/** Registrar el número y comprobarlo son dos cosas distintas — RN-CLI-10. */
export const verificacionEstadoEnum = pgEnum('verificacion_estado', ['pendiente', 'verificado'])

/**
 * Cómo se comprobó — RN-CLI-14.
 *
 * Se DERIVA del rol de quien verifica, no se recibe por parámetro: dejarlo
 * elegir permitiría que un `seller` marque `admin_oficial`, que es la
 * ratificación formal y vale distinto.
 */
export const verificacionMetodoEnum = pgEnum('verificacion_metodo', [
  'seller_manual',
  'pos_manual',
  'admin_oficial',
])

export const clientes = pgTable(
  'clientes',
  {
    /** La identidad es este UUID, no el documento — RN-CLI-01. */
    id: uuid('id').primaryKey().defaultRandom(),

    nombre: text('nombre').notNull(),
    tipo: tipoClienteEnum('tipo').notNull().default('residencial'),

    tipoDocumento: tipoDocumentoEnum('tipo_documento').notNull(),
    /** El número BASE, normalizado: sin puntos, sin guion y sin el DV. */
    numeroDocumento: text('numero_documento').notNull(),

    verificacionEstado: verificacionEstadoEnum('verificacion_estado')
      .notNull()
      .default('pendiente'),
    verificadoPor: uuid('verificado_por').references(() => users.id, { onDelete: 'set null' }),
    verificadoEn: tstz('verificado_en'),
    verificacionMetodo: verificacionMetodoEnum('verificacion_metodo'),

    creditoHabilitado: boolean('credito_habilitado').notNull().default(false),
    /** `null` es SIN TOPE, y es el default — RN-CLI-12. */
    creditoLimite: numeric('credito_limite', { precision: 12, scale: 2 }),

    /** Un cliente no se borra, se desactiva — RN-CLI-02. */
    activo: boolean('activo').notNull().default(true),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    /*
     * ── La unicidad va sobre el PAR, no sobre el número ──────────────────────
     *
     * RN-CLI-08 dice que un número pertenece a una sola persona. Pero el NIT de
     * una persona natural se basa en su cédula: `CC 79123456` y `NIT 79123456`
     * son la misma persona escrita de dos formas, y registrar el NIT de alguien
     * que ya está como CC es un caso legítimo.
     *
     * Con el par, el duplicado REAL —mismo tipo y mismo número— sigue siendo
     * imposible. El cruce entre tipos lo atiende el servicio con un aviso: la
     * base no puede saber si son la misma persona, y adivinarlo sería peor que
     * preguntar.
     */
    uniqueIndex('clientes_documento_idx').on(t.tipoDocumento, t.numeroDocumento),

    /*
     * ── El invariante de M5 — RN-CLI-15 ─────────────────────────────────────
     *
     * Crédito exige verificación. Va en la base y no solo en el servicio porque
     * cubre los DOS caminos: habilitar crédito sin verificar, y *des*verificar a
     * alguien que ya tiene crédito puesto. Un guard en el servicio de habilitar
     * solo atrapa el primero, y nadie se acuerda del segundo hasta que pasa.
     *
     * «El que más necesita crédito es el que más urgente tiene saltarse la
     * verificación» — por eso es un invariante y no una validación.
     */
    check(
      'clientes_credito_exige_verificacion',
      sql`NOT ${t.creditoHabilitado} OR ${t.verificacionEstado} = 'verificado'`,
    ),

    /*
     * Los cuatro campos de la verificación van juntos o van los cuatro nulos.
     * Misma forma que `cierres_procesamiento_completo` en M4: media verificación
     * —estado sin responsable, o responsable sin fecha— no significa nada, y
     * quien la lea después no va a saber si fue un bug o un dato real.
     */
    check(
      'clientes_verificacion_completa',
      sql`(${t.verificacionEstado} = 'pendiente'
             AND ${t.verificadoPor} IS NULL
             AND ${t.verificadoEn} IS NULL
             AND ${t.verificacionMetodo} IS NULL)
          OR (${t.verificacionEstado} = 'verificado'
             AND ${t.verificadoEn} IS NOT NULL
             AND ${t.verificacionMetodo} IS NOT NULL)`,
    ),

    check('clientes_limite_positivo', sql`${t.creditoLimite} IS NULL OR ${t.creditoLimite} > 0`),

    index('clientes_activo_idx').on(t.activo),
  ],
)

/**
 * La dirección es una entidad, no un campo de texto — RN-CLI-07.
 *
 * Sin `ruta_id`: las rutas son M8. Agregar hoy una columna que apunta a una
 * tabla que no existe es andamio — y no cuesta más ponerla entonces, porque esta
 * tabla ya va a estar. Lo caro sería lo contrario: partir clientes que ya tienen
 * deuda y botellones para poder separarles las direcciones.
 */
export const direcciones = pgTable(
  'direcciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clienteId: uuid('cliente_id')
      .notNull()
      .references(() => clientes.id, { onDelete: 'restrict' }),

    /** Cómo la llaman: «Sucursal Norte», «la casa», «el depósito». */
    etiqueta: text('etiqueta').notNull(),
    direccion: text('direccion').notNull(),
    /** Referencias para llegar: «al lado de la panadería». */
    indicaciones: text('indicaciones'),

    activa: boolean('activa').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('direcciones_cliente_idx').on(t.clienteId)],
)

export type Cliente = typeof clientes.$inferSelect
export type NuevoCliente = typeof clientes.$inferInsert
export type Direccion = typeof direcciones.$inferSelect
export type NuevaDireccion = typeof direcciones.$inferInsert
