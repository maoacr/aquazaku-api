-- Clona el schema `public` de Aquazaku a `preview` (entorno staging).
-- Pegar y correr en el SQL Editor de Supabase con rol `postgres`.
-- Generado automáticamente — NO modificar a mano.
--
-- Por qué `SET search_path` antes Y después de cada migración: las
-- migraciones originales asumen que el runner de Drizzle setea
-- `search_path = preview, public` antes de cada CREATE/ALTER. El SQL
-- Editor no garantiza mantener ese path entre statements (puede partir
-- el bloque), así que lo seteamos antes Y después de cada migración.
-- Es idempotente.

-- Pre-amble: schema + GRANTs a aquazaku_app (único rol del proyecto;
-- el owner es `postgres`, no necesita GRANTs explícitos).
CREATE SCHEMA IF NOT EXISTS "preview";

GRANT USAGE ON SCHEMA "preview" TO "aquazaku_app";

ALTER DEFAULT PRIVILEGES IN SCHEMA "preview"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aquazaku_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "preview"
  GRANT USAGE, SELECT ON SEQUENCES TO aquazaku_app;

SET search_path TO preview, public;


-- ═══ 0000_m0_initial.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- `users.email` es citext: unicidad y login case-insensitive garantizados
-- por la base, sin depender de que cada query recuerde un LOWER().
-- drizzle-kit no genera esto, se agrega a mano.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "preview"."audit_result" AS ENUM('ok', 'denied');--> statement-breakpoint
CREATE TYPE "preview"."user_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"rol_ejercido" text[],
	"action" text NOT NULL,
	"resource" text,
	"resource_id" text,
	"result" "audit_result" NOT NULL,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_name" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	CONSTRAINT "user_roles_user_id_role_name_pk" PRIMARY KEY("user_id","role_name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_name_roles_name_fk" FOREIGN KEY ("role_name") REFERENCES "preview"."roles"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_issuer_account_id_key" ON "accounts" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_result_idx" ON "audit_log" USING btree ("result");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");
SET search_path TO preview, public;

-- ═══ 0001_audit_append_only.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- audit_log inmutable — RN-ACC-04
--
-- Dos mecanismos independientes, porque ninguno alcanza solo:
--
--   1. Triggers que rechazan UPDATE y DELETE. Aplican a TODO el mundo, incluido
--      el dueño de la tabla. Pero el dueño puede desactivarlos.
--   2. El rol de la aplicación no es dueño y solo tiene SELECT e INSERT. No
--      puede borrar filas ni desactivar el trigger. Pero por sí solo no frena a
--      quien se conecte con el rol dueño.
--
-- Juntos cubren el hueco del otro: para adulterar la bitácora hay que tener las
-- credenciales del rol dueño Y ejecutar un ALTER TABLE explícito. Nada de eso
-- puede pasar por accidente ni por una inyección en el código de la API.
-- ============================================================================

CREATE OR REPLACE FUNCTION reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only: % rechazado', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Los triggers son STATEMENT-level y no ROW-level a propósito: así un
-- `DELETE FROM audit_log` sin WHERE (que no matchea ninguna fila y por lo tanto
-- nunca dispararía un trigger FOR EACH ROW) también falla ruidosamente.
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

-- TRUNCATE no dispara triggers de UPDATE/DELETE: necesita el suyo.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

-- ============================================================================
-- Permisos del rol de aplicación
--
-- El rol lo crea el provisionamiento del entorno, no esta migración: es un
-- objeto de cluster, no de base. Ver /empezar/entorno-local/.
-- ============================================================================

GRANT USAGE ON SCHEMA preview TO aquazaku_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, accounts, verifications, roles, user_roles
  TO aquazaku_app;
--> statement-breakpoint

-- audit_log: se escribe y se lee. NUNCA se modifica ni se borra.
GRANT SELECT, INSERT ON audit_log TO aquazaku_app;
--> statement-breakpoint

-- Necesario para que el bigserial de audit_log pueda avanzar al insertar.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA preview TO aquazaku_app;
--> statement-breakpoint

-- Las tablas de los módulos siguientes (M1+) heredan estos permisos solas, para
-- que nadie tenga que acordarse de correr un GRANT después de cada migración.
-- audit_log queda excluida porque ya existe y este default no la toca.
ALTER DEFAULT PRIVILEGES IN SCHEMA preview
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aquazaku_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA preview
  GRANT USAGE, SELECT ON SEQUENCES TO aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0002_productos.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- Catálogo de productos — M1, RN-CAT-01 a 11
--
-- Los invariantes de precio viven acá y no en la capa de servicio. El servicio
-- igual valida, pero para poder explicar el error en castellano: la garantía es
-- el CHECK. Un UPDATE directo contra la base también tiene que fallar, o
-- RN-CAT-04 sería una promesa que solo se cumple si nadie se equivoca.
--
-- `litros` es una columna GENERADA. Un derivado que se escribe a mano se
-- desincroniza de sus entradas tarde o temprano; este no puede.
-- ============================================================================

CREATE TYPE "preview"."presentacion" AS ENUM('paca', 'botellon');--> statement-breakpoint
CREATE TABLE "productos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"nombre" text NOT NULL,
	"presentacion" "presentacion" NOT NULL,
	"contenido_ml" integer NOT NULL,
	"unidades" integer DEFAULT 1 NOT NULL,
	"litros" numeric(10, 3) GENERATED ALWAYS AS ((contenido_ml::numeric * unidades) / 1000) STORED NOT NULL,
	"precio_residencial" numeric(12, 2) NOT NULL,
	"precio_comercial" numeric(12, 2) NOT NULL,
	"precio_minimo" numeric(12, 2) NOT NULL,
	"precio_incluye_impuestos" boolean DEFAULT true NOT NULL,
	"tarifa_iva_porcentaje" numeric(5, 2) DEFAULT '0' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "productos_precio_minimo_es_piso" CHECK ("productos"."precio_minimo" <= "productos"."precio_residencial" AND "productos"."precio_minimo" <= "productos"."precio_comercial"),
	CONSTRAINT "productos_precios_no_negativos" CHECK ("productos"."precio_minimo" >= 0),
	CONSTRAINT "productos_unidades_positivas" CHECK ("productos"."unidades" >= 1),
	CONSTRAINT "productos_contenido_positivo" CHECK ("productos"."contenido_ml" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "productos_codigo_key" ON "productos" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "productos_activo_idx" ON "productos" USING btree ("activo");

--> statement-breakpoint

-- ============================================================================
-- Permisos — RN-CAT-02: un producto no se borra, se desactiva.
--
-- OJO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Es decir que
-- `productos` YA NACIÓ con permiso de borrado heredado, sin que esta migración
-- lo pida.
--
-- Por eso hace falta revocarlo explícitamente. Que el servicio no exponga un
-- método de borrado depende de que nadie escriba uno; que el rol no tenga el
-- privilegio, no depende de nadie.
-- ============================================================================

REVOKE DELETE ON productos FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0003_stock.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- Stock de producto terminado — M2, RN-STK-01 a 08
--
-- Dos tablas: `lotes` lleva el saldo encima y `movimientos_stock` es el libro
-- que lo explica. Los dos se escriben en la misma transacción; si el saldo baja
-- y el movimiento no queda, el libro deja de explicar el saldo — la primera
-- forma de descuadre, y la más difícil de rastrear después.
--
-- `fecha_vencimiento` es una columna COMÚN, no generada. Parece el caso de
-- `productos.litros` porque las dos las calcula el sistema, pero `litros` es una
-- DEFINICIÓN (12 L es lo que una paca es) y esto es un HECHO DE UN MOMENTO. Con
-- una columna generada, cambiar la regla a 45 días recalcularía el vencimiento
-- de todos los lotes del pasado, incluidos los ya vendidos.
--
-- Los CHECK de motivo y causa son condicionales a propósito: exigen el dato
-- solo en ajuste y descarte, sin obligar a un motivo en una venta.
-- ============================================================================

CREATE TYPE "preview"."causa_descarte" AS ENUM('falla_produccion', 'mal_manejo_cliente', 'vencido', 'otro');--> statement-breakpoint
CREATE TYPE "preview"."tipo_movimiento" AS ENUM('produccion', 'ajuste', 'descarte', 'venta', 'devolucion');--> statement-breakpoint
CREATE TABLE "lotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producto_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"fecha_empaque" date NOT NULL,
	"fecha_vencimiento" date NOT NULL,
	"cantidad_inicial" integer NOT NULL,
	"cantidad_disponible" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lotes_saldo_no_negativo" CHECK ("lotes"."cantidad_disponible" >= 0),
	CONSTRAINT "lotes_cantidad_inicial_positiva" CHECK ("lotes"."cantidad_inicial" > 0),
	CONSTRAINT "lotes_vence_despues_de_empacar" CHECK ("lotes"."fecha_vencimiento" > "lotes"."fecha_empaque")
);
--> statement-breakpoint
CREATE TABLE "movimientos_stock" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lote_id" uuid NOT NULL,
	"cantidad" integer NOT NULL,
	"tipo" "tipo_movimiento" NOT NULL,
	"motivo" text,
	"causa" "causa_descarte",
	"documento_id" uuid,
	"registrado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movimientos_cantidad_no_cero" CHECK ("movimientos_stock"."cantidad" <> 0),
	CONSTRAINT "movimientos_ajuste_con_motivo" CHECK ("movimientos_stock"."tipo" <> 'ajuste' OR "movimientos_stock"."motivo" IS NOT NULL),
	CONSTRAINT "movimientos_descarte_con_causa" CHECK ("movimientos_stock"."tipo" <> 'descarte' OR "movimientos_stock"."causa" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "preview"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_lote_id_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "preview"."lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lotes_codigo_key" ON "lotes" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "lotes_fifo_idx" ON "lotes" USING btree ("producto_id","fecha_vencimiento");--> statement-breakpoint
CREATE INDEX "movimientos_lote_idx" ON "movimientos_stock" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "movimientos_fecha_idx" ON "movimientos_stock" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "movimientos_tipo_idx" ON "movimientos_stock" USING btree ("tipo");

--> statement-breakpoint

-- ============================================================================
-- Permisos
--
-- RECORDATORIO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Las dos tablas de
-- acá YA NACIERON con esos cuatro privilegios. Lo que no deban tener hay que
-- REVOCARLO, no omitirlo. Ver ADR-0006.
-- ============================================================================

-- El libro es append-only, igual que audit_log: se escribe y se lee, nunca se
-- modifica. Un libro editable no es un libro.
REVOKE UPDATE, DELETE ON movimientos_stock FROM aquazaku_app;
--> statement-breakpoint

-- `lotes` CONSERVA el UPDATE: ahí vive el saldo y es lo único que se mueve.
-- Pierde el DELETE — un lote no se borra, se queda en cero. Borrarlo dejaría
-- movimientos apuntando a un lote inexistente y ventas sin trazabilidad.
REVOKE DELETE ON lotes FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0004_insumos.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- Insumos de empaque — M3, RN-INS-01 a 04
--
-- Tapas, sellos y bolsas: lo que se consume al producir. No se venden.
--
-- Mismo patrón que M2: `insumos` lleva el saldo encima y `movimientos_insumo`
-- es el libro que lo explica. Los dos se escriben en la misma transacción; si
-- el saldo baja y el movimiento no queda, el libro deja de explicar el saldo.
--
-- ── Las bolsas se compran por KILO y se guardan por UNIDAD (RN-INS-02) ──────
--
-- La conversión es SIEMPRE aproximada: el grosor de la bolsa varía entre lotes,
-- así que un kilo no trae siempre la misma cantidad. La pregunta no es si hay
-- error, es dónde ponerlo — y va en la unidad, por tres razones:
--
--   1. La pregunta que importa está en unidades: «¿cuántas pacas más puedo
--      envasar?» no se responde en kilos.
--   2. El consumo tiene que ser exacto. 20 bolsas son 20 bolsas; guardando
--      kilos, cada cierre restaría una fracción y el saldo se llenaría de
--      decimales que no significan nada.
--   3. Los dos momentos que SÍ están en kilos —recibir una compra y hacer un
--      conteo físico— ya son puntos donde el sistema exige motivo. Meter ahí la
--      aproximación es honesto: queda registrada, con quién y por qué.
--
-- Por eso `equivalencia` se COPIA en cada movimiento en vez de leerse del
-- insumo: es el valor que se usó ese día. Leerla del insumo haría que
-- actualizarla reescribiera la historia — el mismo error que M2 evitó con
-- `fecha_vencimiento`.
--
-- `insumos.equivalencia_por_kilo` nace NULL a propósito. Cuántas bolsas trae un
-- kilo es una MEDICIÓN DE PLANTA que todavía no se hizo, y mientras siga NULL
-- el servicio rechaza la entrada por kilos en vez de inventar un número. Una
-- equivalencia mal puesta descuadra el inventario en silencio y se descubre el
-- día que faltan bolsas para envasar.
-- ============================================================================

CREATE TYPE "preview"."unidad_insumo" AS ENUM('unidad');--> statement-breakpoint
CREATE TYPE "preview"."tipo_movimiento_insumo" AS ENUM('compra', 'ajuste', 'descarte', 'produccion');--> statement-breakpoint

CREATE TABLE "insumos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"nombre" text NOT NULL,
	"unidad" "unidad_insumo" DEFAULT 'unidad' NOT NULL,
	"minimo" integer NOT NULL,
	"saldo" integer DEFAULT 0 NOT NULL,
	"equivalencia_por_kilo" numeric(10, 3),
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insumos_minimo_positivo" CHECK ("insumos"."minimo" > 0),
	CONSTRAINT "insumos_saldo_no_negativo" CHECK ("insumos"."saldo" >= 0),
	CONSTRAINT "insumos_equivalencia_positiva" CHECK ("insumos"."equivalencia_por_kilo" IS NULL OR "insumos"."equivalencia_por_kilo" > 0)
);--> statement-breakpoint

CREATE TABLE "movimientos_insumo" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"insumo_id" uuid NOT NULL,
	"cantidad" integer NOT NULL,
	"tipo" "tipo_movimiento_insumo" NOT NULL,
	"motivo" text,
	"causa" "causa_descarte",
	"kilos" numeric(10, 3),
	"equivalencia" numeric(10, 3),
	"documento_id" uuid,
	"registrado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movimientos_insumo_cantidad_no_cero" CHECK ("movimientos_insumo"."cantidad" <> 0),
	CONSTRAINT "movimientos_insumo_ajuste_con_motivo" CHECK ("movimientos_insumo"."tipo" <> 'ajuste' OR "movimientos_insumo"."motivo" IS NOT NULL),
	CONSTRAINT "movimientos_insumo_descarte_con_causa" CHECK ("movimientos_insumo"."tipo" <> 'descarte' OR "movimientos_insumo"."causa" IS NOT NULL),
	CONSTRAINT "movimientos_insumo_conversion_completa" CHECK (("movimientos_insumo"."kilos" IS NULL) = ("movimientos_insumo"."equivalencia" IS NULL)),
	CONSTRAINT "movimientos_insumo_conversion_positiva" CHECK ("movimientos_insumo"."kilos" IS NULL OR ("movimientos_insumo"."kilos" > 0 AND "movimientos_insumo"."equivalencia" > 0))
);--> statement-breakpoint

ALTER TABLE "movimientos_insumo" ADD CONSTRAINT "movimientos_insumo_insumo_id_insumos_id_fk" FOREIGN KEY ("insumo_id") REFERENCES "preview"."insumos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_insumo" ADD CONSTRAINT "movimientos_insumo_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "insumos_codigo_idx" ON "insumos" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "insumos_activo_idx" ON "insumos" USING btree ("activo");--> statement-breakpoint
CREATE INDEX "movimientos_insumo_insumo_idx" ON "movimientos_insumo" USING btree ("insumo_id");--> statement-breakpoint
CREATE INDEX "movimientos_insumo_fecha_idx" ON "movimientos_insumo" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "movimientos_insumo_tipo_idx" ON "movimientos_insumo" USING btree ("tipo");--> statement-breakpoint

-- ============================================================================
-- Permisos
--
-- RECORDATORIO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Las dos tablas de
-- acá YA NACIERON con esos cuatro privilegios. Lo que no deban tener hay que
-- REVOCARLO, no omitirlo. Ver ADR-0006.
-- ============================================================================

-- El libro es append-only, igual que `movimientos_stock` y `audit_log`: se
-- escribe y se lee, nunca se modifica. Un libro editable no es un libro.
REVOKE UPDATE, DELETE ON movimientos_insumo FROM aquazaku_app;
--> statement-breakpoint

-- `insumos` CONSERVA el UPDATE: ahí vive el saldo, y es lo único que se mueve.
-- Pierde el DELETE — un insumo no se borra, se desactiva. Borrarlo dejaría
-- movimientos apuntando a un insumo inexistente y el libro sin poder explicar
-- qué se consumió.
REVOKE DELETE ON insumos FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0005_produccion.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- Producción y cierre del día — M4, RN-PRD-01 a 24
--
-- El cierre diario es LA BISAGRA del sistema: el único evento que convierte
-- litros en producto. Toca tres módulos a la vez —descuenta agua, descuenta
-- insumos e ingresa stock— y los cuatro escritos van en la MISMA transacción.
--
-- Un cierre parcial no es un cierre a medias: es un documento que dice que se
-- envasaron 200 botellones con las tapas intactas. Una mentira consistente, que
-- es la clase de dato que nadie sospecha hasta que ya causó daño.
--
-- ── Lo que este esquema NO tiene, y es la decisión más importante ───────────
--
-- NO HAY una columna que diga cuántos litros entraron de la red municipal.
--
-- No hay medidor ni regleta (RN-PRD-11). La tentación es poner el campo y dejar
-- que alguien lo llene a ojo, y eso convierte un hueco conocido en un número que
-- parece medido: el día que el saldo no cuadre, nadie va a saber si el problema
-- fue el consumo, la merma o esa estimación.
--
-- Un `ingreso_red` lleva `litros = 0` y registra el HECHO de que llegó agua. El
-- saldo se recalibra después con un `ajuste` que exige motivo. Así queda claro
-- cuál número es medido y cuál es estimado — RN-PRD-15.
--
-- ── Un enum de tanque, no dos ──────────────────────────────────────────────
--
-- Los dos tanques de 2.000 L se operan en PARALELO: se llenan juntos y se vacían
-- juntos (RN-PRD-21). Modelarlos por separado duplicaría cada escritura para que
-- las dos filas digan siempre lo mismo. La capacidad del procesado es 4.000 L.
--
-- ── `caudal_gpm` y `litros_procesados` se GUARDAN, no se generan ───────────
--
-- Es la tercera vez que aparece este patrón: `fecha_vencimiento` en M2 y
-- `equivalencia` en M3. Ya no es una decisión, es la regla del proyecto — un
-- hecho de un momento no se recalcula.
--
-- Acá pesa doble porque el caudal TODAVÍA NO SE MIDIÓ (preguntas 4 y 5). Cuando
-- se mida, corregirlo con una referencia viva reescribiría cuántos litros se
-- procesaron todos los días del pasado.
-- ============================================================================

CREATE TYPE "preview"."tanque" AS ENUM('crudo', 'procesado');--> statement-breakpoint
CREATE TYPE "preview"."tipo_movimiento_agua" AS ENUM('ingreso_red', 'procesamiento', 'envasado', 'lavado', 'ajuste');--> statement-breakpoint
CREATE TYPE "preview"."nivel_tanque" AS ENUM('vacio', 'un_cuarto', 'medio', 'tres_cuartos', 'lleno');--> statement-breakpoint

CREATE TABLE "cierres_produccion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fecha" date NOT NULL,
	"minutos_procesando" integer NOT NULL,
	"caudal_gpm" numeric(10, 3),
	"litros_procesados" integer,
	"pacas_600" integer DEFAULT 0 NOT NULL,
	"pacas_300" integer DEFAULT 0 NOT NULL,
	"botellones_llenados" integer DEFAULT 0 NOT NULL,
	"botellones_lavados" integer DEFAULT 0 NOT NULL,
	"litros_consumidos" integer NOT NULL,
	"nivel_observado" "nivel_tanque",
	"registrado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cierres_minutos_positivos" CHECK ("cierres_produccion"."minutos_procesando" > 0),
	CONSTRAINT "cierres_conteos_no_negativos" CHECK ("cierres_produccion"."pacas_600" >= 0 AND "cierres_produccion"."pacas_300" >= 0 AND "cierres_produccion"."botellones_llenados" >= 0 AND "cierres_produccion"."botellones_lavados" >= 0),
	CONSTRAINT "cierres_consumo_no_negativo" CHECK ("cierres_produccion"."litros_consumidos" >= 0),
	CONSTRAINT "cierres_procesamiento_completo" CHECK (("cierres_produccion"."caudal_gpm" IS NULL) = ("cierres_produccion"."litros_procesados" IS NULL)),
	CONSTRAINT "cierres_caudal_positivo" CHECK ("cierres_produccion"."caudal_gpm" IS NULL OR ("cierres_produccion"."caudal_gpm" > 0 AND "cierres_produccion"."litros_procesados" > 0))
);--> statement-breakpoint

CREATE TABLE "movimientos_agua" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tanque" "tanque" NOT NULL,
	"litros" integer NOT NULL,
	"tipo" "tipo_movimiento_agua" NOT NULL,
	"motivo" text,
	"cierre_id" uuid,
	"registrado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movimientos_agua_cantidad" CHECK (("movimientos_agua"."tipo" = 'ingreso_red' AND "movimientos_agua"."litros" = 0) OR ("movimientos_agua"."tipo" <> 'ingreso_red' AND "movimientos_agua"."litros" <> 0)),
	CONSTRAINT "movimientos_agua_ajuste_con_motivo" CHECK ("movimientos_agua"."tipo" <> 'ajuste' OR "movimientos_agua"."motivo" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "cierres_produccion" ADD CONSTRAINT "cierres_produccion_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_agua" ADD CONSTRAINT "movimientos_agua_cierre_id_cierres_produccion_id_fk" FOREIGN KEY ("cierre_id") REFERENCES "preview"."cierres_produccion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_agua" ADD CONSTRAINT "movimientos_agua_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Un cierre por día — RN-PRD-22. Dos cierres serían dos verdades sobre el mismo
-- día, y no habría forma de decidir cuál manda.
CREATE UNIQUE INDEX "cierres_fecha_idx" ON "cierres_produccion" USING btree ("fecha");--> statement-breakpoint
CREATE INDEX "movimientos_agua_tanque_idx" ON "movimientos_agua" USING btree ("tanque");--> statement-breakpoint
CREATE INDEX "movimientos_agua_fecha_idx" ON "movimientos_agua" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "movimientos_agua_cierre_idx" ON "movimientos_agua" USING btree ("cierre_id");--> statement-breakpoint

-- ============================================================================
-- Permisos
--
-- RECORDATORIO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Las dos tablas de
-- acá YA NACIERON con esos cuatro privilegios. Lo que no deban tener hay que
-- REVOCARLO, no omitirlo. Ver ADR-0006.
-- ============================================================================

-- El cierre NO SE EDITA — RN-PRD-08. Y acá pesa doble: es el único evento que
-- convierte litros en producto, así que editarlo cambiaría a la vez el agua, el
-- stock y los insumos, sin dejar rastro de qué decía antes. Una corrección es un
-- ajuste posterior con motivo y responsable.
REVOKE UPDATE, DELETE ON cierres_produccion FROM aquazaku_app;
--> statement-breakpoint

-- El libro del agua, append-only como los otros dos del sistema.
REVOKE UPDATE, DELETE ON movimientos_agua FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0006_clientes.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TYPE "tipo_cliente" AS ENUM('residencial', 'comercial');--> statement-breakpoint
CREATE TYPE "tipo_documento" AS ENUM('CC', 'NIT');--> statement-breakpoint
CREATE TYPE "verificacion_estado" AS ENUM('pendiente', 'verificado');--> statement-breakpoint
CREATE TYPE "verificacion_metodo" AS ENUM('seller_manual', 'pos_manual', 'admin_oficial');--> statement-breakpoint

CREATE TABLE "clientes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nombre" text NOT NULL,
  "tipo" "tipo_cliente" DEFAULT 'residencial' NOT NULL,
  "tipo_documento" "tipo_documento" NOT NULL,
  "numero_documento" text NOT NULL,
  "verificacion_estado" "verificacion_estado" DEFAULT 'pendiente' NOT NULL,
  "verificado_por" uuid,
  "verificado_en" timestamp with time zone,
  "verificacion_metodo" "verificacion_metodo",
  "credito_habilitado" boolean DEFAULT false NOT NULL,
  "credito_limite" numeric(12, 2),
  "activo" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- RN-CLI-15. Va en la base y no solo en el servicio porque cubre los DOS
  -- caminos: habilitar credito sin verificar, y desverificar a alguien que ya
  -- lo tiene. Un guard en "habilitar" solo atrapa el primero.
  CONSTRAINT "clientes_credito_exige_verificacion"
    CHECK (NOT "credito_habilitado" OR "verificacion_estado" = 'verificado'),

  -- Los cuatro campos van juntos o los cuatro nulos. Media verificacion no
  -- significa nada, y quien la lea despues no sabria si fue un bug o un dato.
  CONSTRAINT "clientes_verificacion_completa"
    CHECK (
      ("verificacion_estado" = 'pendiente'
        AND "verificado_por" IS NULL
        AND "verificado_en" IS NULL
        AND "verificacion_metodo" IS NULL)
      OR
      ("verificacion_estado" = 'verificado'
        AND "verificado_en" IS NOT NULL
        AND "verificacion_metodo" IS NOT NULL)
    ),

  CONSTRAINT "clientes_limite_positivo"
    CHECK ("credito_limite" IS NULL OR "credito_limite" > 0)
);--> statement-breakpoint

CREATE TABLE "direcciones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cliente_id" uuid NOT NULL,
  "etiqueta" text NOT NULL,
  "direccion" text NOT NULL,
  "indicaciones" text,
  "activa" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "clientes" ADD CONSTRAINT "clientes_verificado_por_users_id_fk"
  FOREIGN KEY ("verificado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint

-- `restrict` y no `cascade`: borrar un cliente con direcciones tendria que ser
-- imposible, no silencioso. De todos modos el DELETE sobre clientes esta
-- revocado mas abajo — esto es el cinturon del tirante.
ALTER TABLE "direcciones" ADD CONSTRAINT "direcciones_cliente_id_clientes_id_fk"
  FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE restrict;--> statement-breakpoint

-- RN-CLI-08. Sobre el PAR y no sobre el numero: el NIT de una persona natural
-- se basa en su cedula, asi que `CC 79123456` y `NIT 79123456` son la misma
-- persona escrita de dos formas y prohibir ese cruce haria imposible un caso
-- legitimo. El duplicado REAL —mismo tipo, mismo numero— sigue sin poder entrar.
CREATE UNIQUE INDEX "clientes_documento_idx"
  ON "clientes" USING btree ("tipo_documento", "numero_documento");--> statement-breakpoint
CREATE INDEX "clientes_activo_idx" ON "clientes" USING btree ("activo");--> statement-breakpoint
CREATE INDEX "direcciones_cliente_idx" ON "direcciones" USING btree ("cliente_id");--> statement-breakpoint

-- ============================================================================
-- Permisos
--
-- RECORDATORIO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Las dos tablas de
-- acá YA NACIERON con esos cuatro privilegios. Lo que no deban tener hay que
-- REVOCARLO, no omitirlo. Ver ADR-0006.
-- ============================================================================

-- `clientes` CONSERVA el UPDATE: un cliente se edita —cambia de tipo, se
-- verifica, se le habilita credito—. Pierde el DELETE: RN-CLI-02 dice que no se
-- borra, se desactiva. Borrarlo dejaria ventas y botellones apuntando a un
-- cliente inexistente, y la deuda sin dueno.
REVOKE DELETE ON clientes FROM aquazaku_app;
--> statement-breakpoint

-- Lo mismo con las direcciones: una base prestada se asigna a una direccion
-- concreta (RN-CLI-07). Borrarla dejaria el prestamo sin lugar a donde ir a
-- buscarlo, que es exactamente lo que esa regla viene a evitar.
REVOKE DELETE ON direcciones FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0007_ventas.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TYPE "medio_de_pago" AS ENUM('efectivo', 'transferencia', 'credito');--> statement-breakpoint
CREATE TYPE "estado_de_venta" AS ENUM('confirmada', 'anulada');--> statement-breakpoint
CREATE TYPE "canal_de_venta" AS ENUM('mostrador', 'whatsapp', 'ruta');--> statement-breakpoint
CREATE TYPE "tipo_de_descuento" AS ENUM('porcentaje', 'monto_fijo');--> statement-breakpoint

CREATE TABLE "codigos_de_descuento" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "codigo" text NOT NULL,
  "tipo" "tipo_de_descuento" NOT NULL,
  "valor" numeric(12, 2) NOT NULL,
  "vigencia_desde" date NOT NULL,
  "vigencia_hasta" date NOT NULL,
  "usos_maximos" integer,
  "usos_realizados" integer DEFAULT 0 NOT NULL,
  "activo" boolean DEFAULT true NOT NULL,
  "creado_por" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "codigos_vigencia_ordenada" CHECK ("vigencia_hasta" >= "vigencia_desde"),
  CONSTRAINT "codigos_valor_positivo" CHECK ("valor" > 0),
  CONSTRAINT "codigos_usos_maximos" CHECK ("usos_maximos" IS NULL OR "usos_maximos" > 0)
);--> statement-breakpoint

CREATE TABLE "ventas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cliente_id" uuid,
  "tipo_cliente_al_momento" "tipo_cliente",
  "medio_de_pago" "medio_de_pago" NOT NULL,
  "canal" "canal_de_venta" DEFAULT 'mostrador' NOT NULL,
  "estado" "estado_de_venta" DEFAULT 'confirmada' NOT NULL,
  "total" numeric(12, 2) NOT NULL,
  "codigo_descuento_id" uuid,
  "requiere_factura_electronica" boolean DEFAULT false NOT NULL,
  "registrado_por" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "anulada_por" uuid,
  "anulada_en" timestamp with time zone,
  "motivo_anulacion" text,

  -- Una venta a credito sin cliente es una deuda sin dueno: nadie a quien
  -- cobrarle y nada que sumar en la cartera.
  CONSTRAINT "ventas_credito_exige_cliente"
    CHECK ("medio_de_pago" <> 'credito' OR "cliente_id" IS NOT NULL),

  -- Media anulacion —motivo sin responsable— no explica nada en tres meses.
  CONSTRAINT "ventas_anulacion_completa" CHECK (
    ("estado" = 'confirmada' AND "anulada_en" IS NULL AND "motivo_anulacion" IS NULL)
    OR
    ("estado" = 'anulada' AND "anulada_en" IS NOT NULL AND "motivo_anulacion" IS NOT NULL)
  ),

  CONSTRAINT "ventas_total_no_negativo" CHECK ("total" >= 0)
);--> statement-breakpoint

CREATE TABLE "lineas_de_venta" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "venta_id" uuid NOT NULL,
  "producto_id" uuid NOT NULL,
  "lote_id" uuid NOT NULL,
  "cantidad" integer NOT NULL,
  "precio_lista_aplicado" numeric(12, 2) NOT NULL,
  "descuento_monto" numeric(12, 2) DEFAULT '0.00' NOT NULL,
  "precio_minimo_aplicado" numeric(12, 2) NOT NULL,
  "precio_final" numeric(12, 2) NOT NULL,

  -- RN-VEN-13. Con el minimo congelado en la linea, el invariante queda entre
  -- dos columnas de la MISMA fila: no hay que ir a buscar el producto, y cubre
  -- tambien el script de migracion y la correccion por consola.
  CONSTRAINT "lineas_respetan_el_piso" CHECK ("precio_final" >= "precio_minimo_aplicado"),

  -- La identidad que hace verificable el comprobante.
  CONSTRAINT "lineas_precio_cuadra"
    CHECK ("precio_final" = "precio_lista_aplicado" - "descuento_monto"),

  CONSTRAINT "lineas_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "lineas_descuento_no_negativo" CHECK ("descuento_monto" >= 0)
);--> statement-breakpoint

CREATE TABLE "cobros" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cliente_id" uuid NOT NULL,
  "monto" numeric(12, 2) NOT NULL,
  "medio_de_pago" "medio_de_pago" NOT NULL,
  "observaciones" text,
  "registrado_por" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "cobros_monto_positivo" CHECK ("monto" > 0),
  -- `credito` no es un medio de PAGO: pagar una deuda con deuda no la reduce.
  CONSTRAINT "cobros_no_se_pagan_a_credito" CHECK ("medio_de_pago" <> 'credito')
);--> statement-breakpoint

ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_codigo_descuento_id_fk" FOREIGN KEY ("codigo_descuento_id") REFERENCES "codigos_de_descuento"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_anulada_por_users_id_fk" FOREIGN KEY ("anulada_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "codigos_de_descuento" ADD CONSTRAINT "codigos_creado_por_users_id_fk" FOREIGN KEY ("creado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "lineas_de_venta" ADD CONSTRAINT "lineas_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "lineas_de_venta" ADD CONSTRAINT "lineas_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "lineas_de_venta" ADD CONSTRAINT "lineas_lote_id_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "lotes"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "cobros" ADD CONSTRAINT "cobros_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "cobros" ADD CONSTRAINT "cobros_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint

CREATE UNIQUE INDEX "codigos_descuento_codigo_idx" ON "codigos_de_descuento" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ventas_cliente_idx" ON "ventas" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "ventas_fecha_idx" ON "ventas" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ventas_autor_idx" ON "ventas" USING btree ("registrado_por");--> statement-breakpoint
CREATE INDEX "lineas_venta_idx" ON "lineas_de_venta" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX "lineas_lote_idx" ON "lineas_de_venta" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "cobros_cliente_idx" ON "cobros" USING btree ("cliente_id");--> statement-breakpoint

-- ============================================================================
-- Permisos
--
-- RECORDATORIO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Las cuatro tablas de
-- acá YA NACIERON con esos cuatro privilegios. Lo que no deban tener hay que
-- REVOCARLO, no omitirlo. Ver ADR-0006.
-- ============================================================================

-- Una venta confirmada NO SE EDITA — RN-VEN-02. Es la regla que mas se pide
-- romper por comodidad y la que mas caro sale romper: si el monto de ayer puede
-- cambiar hoy, ningun arqueo ni rendicion es confiable.
--
-- `ventas` conserva el UPDATE porque anular cambia el estado. El trigger de
-- abajo acota ESE update a lo unico que corresponde.
REVOKE DELETE ON ventas FROM aquazaku_app;
--> statement-breakpoint

-- Las lineas no se tocan NUNCA: ni para anular. Anular cambia el estado de la
-- venta y escribe movimientos que devuelven el producto — las lineas quedan
-- como testimonio de que se vendio eso a ese precio.
REVOKE UPDATE, DELETE ON lineas_de_venta FROM aquazaku_app;
--> statement-breakpoint

-- Un cobro tampoco se edita: se corrige con otro documento, igual que todo lo
-- demas en este sistema.
REVOKE UPDATE, DELETE ON cobros FROM aquazaku_app;
--> statement-breakpoint

-- Los codigos se desactivan, no se borran: una venta pasada los referencia.
REVOKE DELETE ON codigos_de_descuento FROM aquazaku_app;
--> statement-breakpoint

-- ============================================================================
-- El UPDATE de `ventas` solo puede llevar a `anulada`
--
-- Revocar el UPDATE entero haria imposible anular. Dejarlo abierto haria
-- editable el monto de ayer. El trigger deja pasar exactamente la transicion
-- que RN-VEN-02 permite, y nada mas.
--
-- Es la misma forma que el append-only de `audit_log` en la migracion 0001.
-- ============================================================================
CREATE OR REPLACE FUNCTION solo_anulacion_en_ventas() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.estado <> 'confirmada' THEN
    RAISE EXCEPTION 'una venta ya anulada no se vuelve a tocar';
  END IF;

  IF NEW.estado <> 'anulada' THEN
    RAISE EXCEPTION 'una venta confirmada solo puede pasar a anulada — RN-VEN-02';
  END IF;

  -- Todo lo demas tiene que quedar como estaba. Si el monto de ayer puede
  -- cambiar hoy, ningun arqueo es confiable.
  IF NEW.total IS DISTINCT FROM OLD.total
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
     OR NEW.medio_de_pago IS DISTINCT FROM OLD.medio_de_pago
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por THEN
    RAISE EXCEPTION 'anular no edita la venta: solo cambia su estado — RN-VEN-02';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER ventas_solo_anulacion
  BEFORE UPDATE ON ventas
  FOR EACH ROW EXECUTE FUNCTION solo_anulacion_en_ventas();

SET search_path TO preview, public;

-- ═══ 0008_devoluciones.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TYPE "estado_devuelto" AS ENUM('sano', 'danado', 'vencido');--> statement-breakpoint

CREATE TABLE "devoluciones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "venta_origen_id" uuid NOT NULL,
  "linea_id" uuid NOT NULL,
  "cantidad" integer NOT NULL,
  "estado_producto" "estado_devuelto" NOT NULL,
  "motivo" text NOT NULL,
  "monto_acreditado" numeric(12, 2) DEFAULT '0.00' NOT NULL,
  "registrado_por" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "devoluciones_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "devoluciones_monto_no_negativo" CHECK ("monto_acreditado" >= 0)
);--> statement-breakpoint

ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_venta_origen_id_fk" FOREIGN KEY ("venta_origen_id") REFERENCES "ventas"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_linea_id_fk" FOREIGN KEY ("linea_id") REFERENCES "lineas_de_venta"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_registrado_por_fk" FOREIGN KEY ("registrado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint

CREATE INDEX "devoluciones_venta_idx" ON "devoluciones" USING btree ("venta_origen_id");--> statement-breakpoint
CREATE INDEX "devoluciones_linea_idx" ON "devoluciones" USING btree ("linea_id");--> statement-breakpoint

-- ============================================================================
-- Permisos — ver ADR-0006. La migracion 0001 concede los cuatro privilegios
-- sobre toda tabla nueva; lo que no corresponda hay que REVOCARLO.
-- ============================================================================

-- Una devolucion es un hecho registrado: el cliente trajo el producto tal dia.
-- No se edita ni se borra — si esta mal, se registra otra en sentido contrario.
REVOKE UPDATE, DELETE ON devoluciones FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0009_retornables.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TYPE "tipo_de_venta" AS ENUM('producto', 'dano_base');--> statement-breakpoint
CREATE TYPE "tipo_movimiento_botellon" AS ENUM('compra', 'entrega', 'retorno', 'descarte', 'ajuste');--> statement-breakpoint
CREATE TYPE "estado_de_base" AS ENUM('sana', 'danada');--> statement-breakpoint
CREATE TYPE "tipo_movimiento_base" AS ENUM('alta', 'prestamo', 'retorno', 'dano', 'descarte');--> statement-breakpoint

-- Las ventas que ya existen son de producto: es el unico tipo que habia.
ALTER TABLE "ventas" ADD COLUMN "tipo" "tipo_de_venta" DEFAULT 'producto' NOT NULL;--> statement-breakpoint

CREATE TABLE "movimientos_botellon" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "cliente_id" uuid,
  "cantidad" integer NOT NULL,
  "tipo" "tipo_movimiento_botellon" NOT NULL,
  "motivo" text,
  "documento_id" uuid,
  "registrado_por" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- Un movimiento de cero no movio nada.
  CONSTRAINT "movimientos_botellon_cantidad" CHECK ("cantidad" <> 0),

  -- `compra` siempre suma y `descarte` siempre resta: son los dos unicos que
  -- cambian el TOTAL del parque, asi que un signo invertido aca rompe la ley de
  -- conservacion sin que ninguna otra fila se vea rara.
  CONSTRAINT "movimientos_botellon_signos" CHECK (
    ("tipo" = 'compra' AND "cantidad" > 0)
    OR ("tipo" = 'descarte' AND "cantidad" < 0)
    OR "tipo" NOT IN ('compra', 'descarte')
  )
);--> statement-breakpoint

CREATE TABLE "bases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "id_sticker" text NOT NULL,
  "estado" "estado_de_base" DEFAULT 'sana' NOT NULL,
  "direccion_id" uuid,
  "danada_por" uuid,
  "danada_en" timestamp with time zone,
  "recargo_venta_id" uuid,
  "activa" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- Media evidencia de dano —estado sin fecha— no sirve para cobrarle a nadie.
  CONSTRAINT "bases_dano_completo" CHECK (
    ("estado" = 'sana' AND "danada_por" IS NULL AND "danada_en" IS NULL)
    OR ("estado" = 'danada' AND "danada_en" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE TABLE "movimientos_base" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "base_id" uuid NOT NULL,
  "tipo" "tipo_movimiento_base" NOT NULL,
  "direccion_id" uuid,
  "motivo" text,
  "registrado_por" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "movimientos_botellon" ADD CONSTRAINT "mov_botellon_cliente_fk" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "movimientos_botellon" ADD CONSTRAINT "mov_botellon_documento_fk" FOREIGN KEY ("documento_id") REFERENCES "ventas"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "movimientos_botellon" ADD CONSTRAINT "mov_botellon_usuario_fk" FOREIGN KEY ("registrado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_direccion_fk" FOREIGN KEY ("direccion_id") REFERENCES "direcciones"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_danada_por_fk" FOREIGN KEY ("danada_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_recargo_fk" FOREIGN KEY ("recargo_venta_id") REFERENCES "ventas"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "movimientos_base" ADD CONSTRAINT "mov_base_base_fk" FOREIGN KEY ("base_id") REFERENCES "bases"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "movimientos_base" ADD CONSTRAINT "mov_base_direccion_fk" FOREIGN KEY ("direccion_id") REFERENCES "direcciones"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "movimientos_base" ADD CONSTRAINT "mov_base_usuario_fk" FOREIGN KEY ("registrado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint

CREATE UNIQUE INDEX "bases_sticker_idx" ON "bases" USING btree ("id_sticker");--> statement-breakpoint
CREATE INDEX "movimientos_botellon_cliente_idx" ON "movimientos_botellon" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "movimientos_botellon_fecha_idx" ON "movimientos_botellon" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bases_direccion_idx" ON "bases" USING btree ("direccion_id");--> statement-breakpoint
CREATE INDEX "movimientos_base_base_idx" ON "movimientos_base" USING btree ("base_id");--> statement-breakpoint

-- ============================================================================
-- El invariante que CRUZA DOS TABLAS
--
-- Una venta de producto tiene lineas —es producto que salio de un lote—. Un
-- recargo por dano NO: no hay lote del que salga una base rota.
--
-- Las dos direcciones importan y se defienden distinto:
--
--  · «un `dano_base` con lineas» se puede frenar al insertar la linea, porque
--    ahi ya se sabe de que venta es.
--
--  · «un `producto` SIN lineas» no se puede frenar al insertar la venta: las
--    lineas llegan despues. Necesita un CONSTRAINT TRIGGER DIFERIDO, que corre
--    al COMMIT — cuando la transaccion ya escribio todo lo que iba a escribir.
--
-- Sin el segundo, una venta de producto sin lineas quedaria con un total que no
-- tiene de donde salir, y nadie lo notaria hasta el arqueo.
-- ============================================================================

CREATE OR REPLACE FUNCTION dano_base_sin_lineas() RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT tipo FROM ventas WHERE id = NEW.venta_id) = 'dano_base' THEN
    RAISE EXCEPTION 'un recargo por dano no lleva lineas: no hay lote del que salga una base rota';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER lineas_no_van_en_dano_base
  BEFORE INSERT ON lineas_de_venta
  FOR EACH ROW EXECUTE FUNCTION dano_base_sin_lineas();--> statement-breakpoint

CREATE OR REPLACE FUNCTION venta_de_producto_tiene_lineas() RETURNS TRIGGER AS $$
BEGIN
  -- Solo aplica a las de producto. Las de dano nacen sin lineas a proposito.
  IF NEW.tipo <> 'producto' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM lineas_de_venta WHERE venta_id = NEW.id) THEN
    RAISE EXCEPTION 'una venta de producto sin lineas tiene un total que no sale de ningun lado';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- DEFERRABLE INITIALLY DEFERRED: corre al COMMIT, no al INSERT. Es la unica
-- forma de exigir algo que la propia transaccion todavia no termino de escribir.
CREATE CONSTRAINT TRIGGER ventas_producto_con_lineas
  AFTER INSERT ON ventas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION venta_de_producto_tiene_lineas();--> statement-breakpoint

-- ============================================================================
-- Permisos — ver ADR-0006.
-- ============================================================================

-- Los dos libros son append-only, como todos los del sistema. Un libro editable
-- no es un libro, y aca es peor: sin ID individual, el libro de botellones es lo
-- UNICO que sostiene la ley de conservacion.
REVOKE UPDATE, DELETE ON movimientos_botellon FROM aquazaku_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON movimientos_base FROM aquazaku_app;
--> statement-breakpoint

-- `bases` CONSERVA el UPDATE: una base cambia de lugar y de estado. Pierde el
-- DELETE — se desactiva, porque su historial la referencia.
REVOKE DELETE ON bases FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0010_botellon_con_responsable.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- Ningún botellón sale del parque sin un responsable — RN-ENV-09.
--
-- ── Por qué esto vive en la base y no solo en el servicio ────────────────────
--
-- Un botellón que sale sin quedar anotado a nombre de alguien no genera una fila
-- rota: genera una fila que FALTA. Y esa es la peor forma del problema, porque
-- la ley de conservación de RN-ENV-02 **no la detecta**.
--
-- Si el `pos` se olvida, no se escribe nada: `registrados` no cambia,
-- `enPoderDeAlguien` no cambia, y la ley sigue diciendo `cuadra: true` mientras
-- el botellón está en la casa del cliente y el sistema lo cree en la bodega.
-- Solo aparece cuando alguien cuenta físicamente, meses después, sin saber a
-- quién reclamarle.
--
-- La ley detecta filas que faltan RESPECTO DE SÍ MISMA. No detecta que la
-- realidad se fue por otro lado. Este CHECK cubre ese hueco por el otro lado:
-- la fila del cliente no puede existir sin cliente.
--
-- ── Cada movimiento son DOS filas, y solo una es del cliente ────────────────
--
--   entrega   bodega  −n  (cliente_id NULL)   cliente  +n  (cliente_id)
--   retorno   cliente −n  (cliente_id)        bodega   +n  (cliente_id NULL)
--
-- La fila del cliente cambia de signo según la dirección, y la de la bodega
-- SIEMPRE va con `cliente_id` en NULL — la bodega no es un cliente. Por eso el
-- CHECK cruza tipo y signo en vez de mirar solo uno: pedirle cliente a toda
-- fila positiva rompería el retorno, que ingresa a la bodega.
--
-- ── Qué NO toca ─────────────────────────────────────────────────────────────
--
-- Compras, descartes y ajustes de bodega son movimientos del parque contra sí
-- mismo, sin tenedor del otro lado. Quedan afuera por construcción: ninguno es
-- `entrega` ni `retorno`.
--
-- Y una venta sin cliente sigue siendo válida: quien compra una paca de bolsas
-- en el mostrador no se lleva ningún activo retornable. La regla es «ningún
-- BOTELLÓN sale sin responsable», no «toda venta necesita cliente».

ALTER TABLE "movimientos_botellon"
  ADD CONSTRAINT "movimientos_botellon_con_responsable"
  CHECK (
    -- Lo que sale hacia alguien tiene que decir hacia quién.
    NOT ("tipo" = 'entrega' AND "cantidad" > 0 AND "cliente_id" IS NULL)
    -- Y lo que vuelve tiene que decir a quién se le descuenta.
    AND NOT ("tipo" = 'retorno' AND "cantidad" < 0 AND "cliente_id" IS NULL)
  );

SET search_path TO preview, public;

-- ═══ 0011_proveedores.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- Proveedores y compras — M9, RN-PRO-01 a 07.
--
-- ── Qué NO hay acá ──────────────────────────────────────────────────────────
--
-- No hay saldo por proveedor, ni pagos parciales, ni cartera por antigüedad.
-- Hoy Aquazaku paga TODO de contado o por transferencia: ningún proveedor fía
-- (RN-PRO-06). Diseñar plazos, autorizaciones y qué pasa con un atraso sería
-- inventar reglas que el negocio nunca ejerció.
--
-- Lo que sí está es la columna `medio_de_pago` con `credito` entre sus valores
-- y la fecha de vencimiento: el día que un proveedor fíe, el dato entra sin
-- migrar nada ni reinterpretar las compras viejas.

CREATE TYPE "estado_compra" AS ENUM ('recibida', 'anulada');

CREATE TABLE "proveedores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nombre" text NOT NULL,

  -- Opcionales a propósito: un proveedor puede ser el señor que trae las tapas
  -- en su camioneta. Exigirle NIT llevaría a inventar uno.
  "nit" text,
  "contacto" text,

  -- RN-PRO-01: un proveedor con historial de compras se desactiva, no se
  -- elimina. Mismo criterio que los clientes.
  "activo" boolean DEFAULT true NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "proveedores_nombre_no_vacio" CHECK (length(btrim("nombre")) > 0)
);--> statement-breakpoint

-- El NIT es único cuando está. Dos proveedores con el mismo NIT son el mismo
-- proveedor cargado dos veces, y el historial queda partido entre los dos.
CREATE UNIQUE INDEX "proveedores_nit_idx" ON "proveedores" ("nit") WHERE "nit" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "compras" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  "proveedor_id" uuid NOT NULL REFERENCES "proveedores"("id") ON DELETE restrict,

  "medio_de_pago" "medio_de_pago" NOT NULL,

  -- Obligatoria SOLO cuando es a crédito — RN-PRO-07. No se estima con un plazo
  -- por defecto: la dice el proveedor.
  "vence_el" date,

  -- RN-PRO-07: pendiente o pagada, y nada más. Sin pagos parciales, porque no
  -- existe todavía una compra a crédito que los necesite.
  "pagada" boolean DEFAULT false NOT NULL,

  -- RN-PRO-04: el costo se congela acá. Sin costo histórico no hay margen real
  -- de un período — igual que el precio de venta en RN-VEN-04.
  "total" numeric(12, 2) NOT NULL,

  "estado" "estado_compra" DEFAULT 'recibida' NOT NULL,
  "motivo_anulacion" text,

  "registrado_por" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "compras_total_no_negativo" CHECK ("total" >= 0),

  -- La fecha y el crédito viajan juntos, en los dos sentidos. Una compra de
  -- contado con vencimiento no significa nada; una a crédito sin vencimiento no
  -- se puede reclamar ni avisar.
  CONSTRAINT "compras_vencimiento_solo_a_credito"
    CHECK (("medio_de_pago" = 'credito') = ("vence_el" IS NOT NULL)),

  -- Lo que se pagó de contado nace pagado: no hay nada que cobrar después.
  CONSTRAINT "compras_contado_nace_pagada"
    CHECK ("medio_de_pago" = 'credito' OR "pagada"),

  CONSTRAINT "compras_anulacion_con_motivo"
    CHECK (("estado" = 'anulada') = ("motivo_anulacion" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "lineas_de_compra" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "compra_id" uuid NOT NULL REFERENCES "compras"("id") ON DELETE restrict,

  -- Qué entró. Los tres son los únicos que se compran (RN-PRO: Aquazaku
  -- produce, no revende — una línea de producto terminado es un error de
  -- registro).
  "insumo_id" uuid REFERENCES "insumos"("id") ON DELETE restrict,
  "botellones" integer,
  "bases" integer,

  -- RN-PRO-03: lo RECIBIDO, no lo pedido. Cerrar con las cantidades del pedido
  -- mete el faltante del proveedor en el inventario propio.
  "cantidad" numeric(12, 3) NOT NULL,

  -- RN-PRO-04: congelado. `costo_unitario * cantidad` es el total de la línea, y
  -- no se recalcula con compras posteriores.
  "costo_unitario" numeric(12, 2) NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "lineas_compra_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "lineas_compra_costo_no_negativo" CHECK ("costo_unitario" >= 0),

  -- EXACTAMENTE una cosa por línea. Una línea que sea insumo y botellón a la vez
  -- no se puede convertir en un movimiento de inventario sin adivinar cuál.
  CONSTRAINT "lineas_compra_una_sola_cosa" CHECK (
    (("insumo_id" IS NOT NULL)::int + ("botellones" IS NOT NULL)::int + ("bases" IS NOT NULL)::int) = 1
  ),

  -- Botellones y bases se cuentan de a unidades enteras: no existe media base.
  CONSTRAINT "lineas_compra_botellones_positivos" CHECK ("botellones" IS NULL OR "botellones" > 0),
  CONSTRAINT "lineas_compra_bases_positivas" CHECK ("bases" IS NULL OR "bases" > 0)
);--> statement-breakpoint

CREATE INDEX "lineas_compra_por_compra_idx" ON "lineas_de_compra" ("compra_id");--> statement-breakpoint
CREATE INDEX "compras_por_proveedor_idx" ON "compras" ("proveedor_id");--> statement-breakpoint

-- Para el aviso de vencidos: solo las que pueden vencer.
CREATE INDEX "compras_vencimiento_idx" ON "compras" ("vence_el")
  WHERE "vence_el" IS NOT NULL AND NOT "pagada";--> statement-breakpoint

-- ── Una compra recibida no se edita — el mismo criterio que RN-VEN-02 ────────
--
-- Una compra registró mercadería que entró y plata que salió. Corregirla en
-- caliente reescribiría el costo histórico con el que se calcula el margen, y
-- ese es justamente el número que RN-PRO-04 protege.
--
-- Se permiten DOS transiciones y nada más: anularla (con motivo), y marcarla
-- pagada. La segunda es la única razón por la que `pagada` no está en la lista
-- de columnas congeladas.
CREATE OR REPLACE FUNCTION solo_anulacion_o_pago_en_compras() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.estado = 'anulada' THEN
    RAISE EXCEPTION 'una compra anulada no se modifica';
  END IF;

  IF NEW.proveedor_id IS DISTINCT FROM OLD.proveedor_id
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.medio_de_pago IS DISTINCT FROM OLD.medio_de_pago
     OR NEW.vence_el IS DISTINCT FROM OLD.vence_el
     OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'una compra recibida no se edita: solo se anula con motivo, o se marca pagada';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER compras_solo_anulacion_o_pago
  BEFORE UPDATE ON "compras"
  FOR EACH ROW EXECUTE FUNCTION solo_anulacion_o_pago_en_compras();--> statement-breakpoint

-- Las líneas no se tocan nunca: son el detalle congelado de lo que llegó.
CREATE OR REPLACE FUNCTION lineas_de_compra_inmutables() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'las líneas de una compra no se editan ni se borran: anule la compra';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER lineas_de_compra_append_only
  BEFORE UPDATE OR DELETE ON "lineas_de_compra"
  FOR EACH ROW EXECUTE FUNCTION lineas_de_compra_inmutables();--> statement-breakpoint

-- La otra mitad de la garantía: el rol de la aplicación no puede reescribir el
-- detalle ni borrarlo. Los triggers protegen de un bug; esto, de un `psql`.
REVOKE UPDATE, DELETE ON "lineas_de_compra" FROM aquazaku_app;--> statement-breakpoint
REVOKE DELETE ON "compras" FROM aquazaku_app;--> statement-breakpoint
REVOKE DELETE ON "proveedores" FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0012_parametros.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- M12 · Alertas — los umbrales dejan de estar cableados
-- ============================================================================
--
-- RN-STK-11 lo pide explícitamente: «tiene que poder ajustarse desde la
-- administración sin tocar código». Hoy vive en dos constantes:
--
--   DIAS_DE_AVISO_DE_VENCIMIENTO = 7   web/src/components/ui/estado.tsx
--   DIAS_DE_ENTREGA = 7                api/src/modules/retornables/bases.ts
--
-- Un umbral que avisa tarde no sirve; uno que avisa demasiado pronto entrena a
-- ignorar el aviso, que es peor. El número correcto depende de la rotación real
-- y esa todavía no se midió — así que moverlo no puede exigir un despliegue.
--
-- ── Por qué NO hay una columna «actualizado_por» ───────────────────────────
--
-- El primer diseño la tenía, con su FK a `users`. Dos problemas:
--
--   1. Duplica lo que `audit_log` ya guarda —quién, cuándo, de cuánto a cuánto—
--      y ese es el registro autoritativo (ADR-0004).
--   2. La FK hace que un `TRUNCATE users CASCADE` se lleve la configuración
--      entera. Lo descubrieron los tests.
--
-- «Quién movió este umbral» se responde en la bitácora, que además dice de qué
-- valor a cuál. Acá alcanza con cuándo.
--
-- ── Por qué los límites viven en la tabla y no en el formulario ─────────────
--
-- Un umbral en 0 apaga la alerta sin decirlo, y uno en 9999 la deja siempre
-- encendida: las dos formas de romperla se ven igual desde afuera —nadie
-- reacciona— y ninguna avisa. Es una invariante, y las invariantes viven en la
-- base (ADR-0006).

CREATE TABLE "parametros" (
  "clave" text PRIMARY KEY,
  "valor" integer NOT NULL,
  "minimo" integer NOT NULL,
  "maximo" integer NOT NULL,
  -- La etiqueta y la ayuda viajan con el dato para que la pantalla no las
  -- copie: un parámetro nuevo aparece en la administración sin tocar `web`.
  "etiqueta" text NOT NULL,
  "ayuda" text NOT NULL,
  "unidad" text NOT NULL,
  "actualizado_en" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "parametros_valor_en_rango" CHECK ("valor" BETWEEN "minimo" AND "maximo"),
  CONSTRAINT "parametros_rango_util" CHECK ("minimo" < "maximo"),
  CONSTRAINT "parametros_minimo_positivo" CHECK ("minimo" >= 1)
);
--> statement-breakpoint

-- ============================================================================
-- Los valores iniciales
-- ============================================================================
--
-- Van en la MIGRACIÓN y no en el seed: el código los lee sin alternativa, así
-- que tienen que existir siempre. RN-STK-11 dice que la constante «se va», no
-- que quede como default — que es como nacen los dos lugares donde configurar
-- lo mismo, y como se descubre meses después que discrepan.

INSERT INTO "parametros" ("clave", "valor", "minimo", "maximo", "etiqueta", "ayuda", "unidad") VALUES
  (
    'dias_aviso_vencimiento', 7, 1, 30,
    'Aviso de vencimiento',
    'Con cuántos días de anticipación se marca un lote como «vence pronto». La vida útil son 30 días, así que 7 deja una cuarta parte para reaccionar.',
    'días'
  ),
  (
    'dias_entrega_bases', 7, 1, 90,
    'Demora del proveedor de bases',
    'Cuánto tarda el proveedor en entregar bases nuevas. Con esto se calcula cuándo hay que comprar antes de quedarse sin.',
    'días'
  );
--> statement-breakpoint

-- La aplicación lee y actualiza. NO borra: un parámetro que desaparece deja al
-- código sin valor y sin manera de saber cuál era.
GRANT SELECT, UPDATE ON "parametros" TO aquazaku_app;
--> statement-breakpoint

-- Cambiar un umbral es una decisión, no un dato: la clave nunca cambia, y una
-- fila nueva solo puede nacer de una migración.
REVOKE INSERT, DELETE ON "parametros" FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0013_ver_migraciones.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- Que la aplicación sepa si le falta una migración
-- ============================================================================
--
-- El 7-sep-2026 se desplegó código que leía una tabla que la migración todavía
-- no había creado. Nada lo impidió: el servidor arrancó sano, el healthcheck dio
-- verde, y los dos módulos afectados fallaron recién cuando alguien los abrió
-- —en una demo con el cliente—.
--
-- El proceso no puede aplicar migraciones (no es dueño de nada, a propósito),
-- pero sí puede DARSE CUENTA. Para eso necesita leer el registro que lleva
-- Drizzle, que vive en su propio esquema.
--
-- Es solo lectura sobre una tabla de hashes y fechas: no hay nada que proteger
-- ahí, y sí mucho que ganar en que el sistema pueda decir «me falta la 0012».

-- ============================================================================
-- Schema-agnostic desde 8-sep-2026: los GRANTs apuntan al journal del schema
-- activo, no al de `public`.
-- ============================================================================
--
-- Dónde vive el journal depende de con qué `--schema` se haya corrido
-- `db:migrate` (ver `drizzle/migrate.ts`):
--
--   * `public` (default): `drizzle.__drizzle_migrations` — la convención
--     histórica de Drizzle cuando no se le pasa `migrationsSchema`.
--   * Cualquier otro schema (`preview`, `preview_test`, etc.):
--     `<schema>.__drizzle_migrations_<schema>`. Así un `DROP SCHEMA preview
--     CASCADE` se lleva el journal también, y dos ambientes no comparten
--     registro.
--
-- El DO block elige uno u otro leyendo `current_schema()`, que devuelve el
-- primer schema del `search_path` activo. En `public` el runner no toca el
-- path; en cualquier otro lo setea a `<schema>, public` antes de empezar.
--
-- Antes este archivo tenía `GRANT ... ON "drizzle"."__drizzle_migrations"`,
-- que rompía en `preview` porque `drizzle.__drizzle_migrations` no existía
-- ahí: el migrador fallaba con `relation does not exist`. Modificar el
-- contenido cambia el hash en `drizzle.__drizzle_migrations` y Drizzle
-- rechaza re-aplicarla si el hash no coincide; el `UPDATE` de una sola fila
-- que el runbook de despliegue tiene que correr manualmente va en la
-- descripción del PR que introdujo este cambio.
DO $$
DECLARE
  v_schema text := current_schema();
  v_journal_schema text;
  v_journal_table text;
BEGIN
  IF v_schema = 'public' THEN
    v_journal_schema := 'drizzle';
    v_journal_table  := '__drizzle_migrations';
  ELSE
    v_journal_schema := v_schema;
    v_journal_table  := '__drizzle_migrations_' || v_schema;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO aquazaku_app', v_journal_schema);
  EXECUTE format('GRANT SELECT ON %I.%I TO aquazaku_app', v_journal_schema, v_journal_table);
END $$;

SET search_path TO preview, public;

-- ═══ 0014_clientes_ubicables.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- Direcciones estructuradas y teléfonos — M14
-- ============================================================================
--
-- Salió de la primera demo con el cliente. Dos huecos que el sistema tenía y
-- nadie había mirado de frente:
--
--   1. La dirección era UN campo de texto. Sin estructura no hay ruta, sin
--      municipio no se distingue «Calle 5 # 3-24» de Campo de la Cruz de la de
--      Suan, y sin coordenadas M8 (rutas) no se puede construir.
--
--   2. No había NINGÚN dato de contacto. Se construyó la cartera por edad para
--      saber a quién llamar primero, y no había a qué número llamar.
--
-- ── Ningún campo es obligatorio, y eso es una decisión ─────────────────────
--
-- Aquazaku reparte en Campo de la Cruz y en pueblos vecinos. La nomenclatura
-- `CL 45 A # 12 B - 34` es urbana: en un municipio pequeño hay direcciones que
-- son «Vereda La Peña, casa de tabla azul» y no se dejan descomponer.
--
-- Un formulario que exige la estructura bloquea el registro de un cliente REAL,
-- y el operador termina inventando `CL 1 # 1-1` para poder guardar. Ahí se
-- perdió el dato y además se ensució la base.

ALTER TABLE "direcciones"
  -- La vía: CL 45 A
  ADD COLUMN "via_tipo" text,
  ADD COLUMN "via_numero" text,
  ADD COLUMN "via_letra" text,
  -- La placa: # 12 B - 34 C
  ADD COLUMN "placa_numero" text,
  ADD COLUMN "placa_letra" text,
  ADD COLUMN "placa_segundo" text,
  ADD COLUMN "placa_letra_final" text,
  -- «Apto 302», «Torre B», «local 4»
  ADD COLUMN "complemento" text,
  -- Sin esto, la misma dirección en dos pueblos se ve idéntica.
  ADD COLUMN "municipio" text,
  -- Campo de la Cruz está cerca del límite con Bolívar y Magdalena: un
  -- municipio vecino puede ser de otro departamento, y ahí el dato distingue.
  ADD COLUMN "departamento" text,
  -- El pin que alguien arrastró en el mapa. Es lo único que M8 puede usar para
  -- ordenar un recorrido: geocodificar una dirección de municipio pequeño en
  -- Colombia no funciona, y una ruta calculada sobre una posición inventada es
  -- peor que ninguna.
  ADD COLUMN "latitud" numeric(9, 6),
  ADD COLUMN "longitud" numeric(9, 6);
--> statement-breakpoint

-- La línea libre deja de ser obligatoria: ahora es una más de las formas de
-- decir dónde queda, no LA forma.
ALTER TABLE "direcciones" ALTER COLUMN "direccion" DROP NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- La invariante: una dirección tiene que poder ubicarse por ALGO
-- ============================================================================
--
-- Si ningún campo es obligatorio por separado, nada impide guardar una fila
-- entera en blanco: una dirección a la que no se le puede entregar nada, que
-- ocupa lugar en la lista y que alguien va a tratar de usar.
--
-- La regla no es «tal campo es obligatorio». Es que el conjunto diga algo.

ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_ubicable" CHECK (
    "via_tipo" IS NOT NULL
    OR "via_numero" IS NOT NULL
    OR "placa_numero" IS NOT NULL
    OR "direccion" IS NOT NULL
    OR "indicaciones" IS NOT NULL
    OR "latitud" IS NOT NULL
  );
--> statement-breakpoint

-- Las coordenadas van de a dos o no van: media coordenada no ubica nada.
ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_coordenada_completa" CHECK (
    ("latitud" IS NULL) = ("longitud" IS NULL)
  );
--> statement-breakpoint

-- Rangos reales del planeta. Un dedazo en el formulario que mande el pin al
-- océano Índico se ve igual que una dirección buena hasta que alguien maneja.
ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_coordenada_valida" CHECK (
    "latitud" IS NULL
    OR ("latitud" BETWEEN -90 AND 90 AND "longitud" BETWEEN -180 AND 180)
  );
--> statement-breakpoint

-- ============================================================================
-- Teléfonos — uno o varios por cliente
-- ============================================================================
--
-- Tabla aparte y no una columna, por lo mismo que `direcciones`: un cliente
-- comercial tiene el celular del dueño y el fijo del local, y en una casa el
-- número puede ser el del vecino. Cuál es cuál lo dice la etiqueta.

CREATE TABLE "telefonos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cliente_id" uuid NOT NULL REFERENCES "clientes"("id") ON DELETE RESTRICT,
  "numero" text NOT NULL,
  -- «celular del dueño», «el local», «la señora del frente»
  "etiqueta" text,
  "activo" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "telefonos_numero_no_vacio" CHECK (length(btrim("numero")) >= 7)
);
--> statement-breakpoint

CREATE INDEX "telefonos_cliente_idx" ON "telefonos" ("cliente_id");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "telefonos" TO aquazaku_app;
--> statement-breakpoint

-- Un teléfono no se borra: se desactiva. El historial de a quién se llamó y
-- cuándo pierde sentido si el número desaparece de la base.
REVOKE DELETE ON "telefonos" FROM aquazaku_app;

SET search_path TO preview, public;

-- ═══ 0015_audit_revoke.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
-- ============================================================================
-- audit_log: REVOKE explícito para que la inmutabilidad no dependa solo del
-- trigger. Defensa en profundidad — si alguien desactiva el trigger, los
-- GRANTs siguen protegiendo.
--
-- Por qué existe este archivo separado y no una línea en `0001_audit_append_only.sql`:
-- modificar esa migration cambiaría su hash en `drizzle.__drizzle_migrations`
-- y los deploys ya aplicados en `public` abortarían al re-migrar (Drizzle
-- detecta el cambio y rechaza la migración). El REVOKE acá es idempotente:
-- en un ambiente donde los GRANTs ya están bien, Postgres lo trata como no-op.
--
-- El REVOKE va SIN calificador de schema — la misma forma que usan 0002, 0003,
-- 0004, 0005, 0007, 0009, etc. Resuelve al `audit_log` del schema activo del
-- runner de migraciones: `public` por default, `preview` cuando se invoca
-- `db:migrate --schema=preview` (que setea `search_path = preview,public`).
-- ============================================================================

REVOKE UPDATE, DELETE ON audit_log FROM aquazaku_app;

SET search_path TO preview, public;
