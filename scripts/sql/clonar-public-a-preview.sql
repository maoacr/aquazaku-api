-- Clona el schema `public` de Aquazaku a `preview` (entorno staging).
-- Pegar y correr en el SQL Editor de Supabase con rol `postgres`.
-- Generado automáticamente: verificar la salida antes de ejecutar.
--
-- Por qué `SET search_path` antes Y después de cada migración: las
-- migraciones originales asumen que el runner de Drizzle setea
-- `search_path = preview, public` antes de cada CREATE/ALTER. El SQL
-- Editor de Supabase no garantiza mantener ese path entre statements
-- (puede partir el bloque), así que lo seteamos antes Y después de cada
-- migración. Es idempotente.

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
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"result" "preview"."audit_result" NOT NULL,
	"resource" text,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_key" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" uuid,
	"active_organization_id" uuid,
	"created_by_ip" text,
	CONSTRAINT "sessions_token_key" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" citext NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"status" "preview"."user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "preview"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "preview"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_issuer_account_id_key" ON "accounts" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_result_idx" ON "audit_log" USING btree ("result");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");
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
CREATE TRIGGER reject_audit_update BEFORE UPDATE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();--> statement-breakpoint
CREATE TRIGGER reject_audit_delete BEFORE DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();--> statement-breakpoint
GRANT USAGE ON SCHEMA preview TO aquazaku_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA preview TO aquazaku_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA preview
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aquazaku_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA preview
GRANT USAGE, SELECT ON SEQUENCES TO aquazaku_app;
SET search_path TO preview, public;

-- ═══ 0002_productos.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "productos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"nombre" text NOT NULL,
	"categoria" text NOT NULL,
	"unidad" text NOT NULL,
	"contenido" numeric(10, 2) NOT NULL,
	"unidad_contenido" text NOT NULL,
	"precio_venta" numeric(12, 2) NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "productos_sku_key" UNIQUE("sku")
);
--> statement-breakpoint
ALTER TABLE "productos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "productos_categoria_idx" ON "productos" USING btree ("categoria");--> statement-breakpoint
CREATE INDEX "productos_activo_idx" ON "productos" USING btree ("activo");
SET search_path TO preview, public;

-- ═══ 0003_stock.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "lotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producto_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"fecha_vencimiento" date NOT NULL,
	"costo_unitario" numeric(12, 2) NOT NULL,
	"cantidad_inicial" numeric(12, 2) NOT NULL,
	"cantidad_actual" numeric(12, 2) NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lotes_codigo_key" UNIQUE("codigo")
);
--> statement-breakpoint
ALTER TABLE "lotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "movimientos_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lote_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"cantidad" numeric(12, 2) NOT NULL,
	"motivo" text,
	"usuario_id" uuid NOT NULL,
	"referencia_tipo" text,
	"referencia_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "movimientos_stock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "preview"."productos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_lote_id_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "preview"."lotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "preview"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lotes_producto_idx" ON "lotes" USING btree ("producto_id");--> statement-breakpoint
CREATE INDEX "lotes_vencimiento_idx" ON "lotes" USING btree ("fecha_vencimiento");--> statement-breakpoint
CREATE INDEX "lotes_activo_idx" ON "lotes" USING btree ("activo");--> statement-breakpoint
CREATE INDEX "movimientos_stock_lote_idx" ON "movimientos_stock" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "movimientos_stock_tipo_idx" ON "movimientos_stock" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "movimientos_stock_referencia_idx" ON "movimientos_stock" USING btree ("referencia_tipo","referencia_id");
SET search_path TO preview, public;

-- ═══ 0004_insumos.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "insumos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"nombre" text NOT NULL,
	"unidad" text NOT NULL,
	"costo_promedio" numeric(12, 2) NOT NULL,
	"stock_minimo" numeric(12, 2) DEFAULT 0 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "insumos_sku_key" UNIQUE("sku")
);
--> statement-breakpoint
ALTER TABLE "insumos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lotes_insumos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"insumo_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"fecha_vencimiento" date,
	"costo_unitario" numeric(12, 2) NOT NULL,
	"cantidad_inicial" numeric(12, 2) NOT NULL,
	"cantidad_actual" numeric(12, 2) NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lotes_insumos_codigo_key" UNIQUE("codigo")
);
--> statement-breakpoint
ALTER TABLE "lotes_insumos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lotes_insumos" ADD CONSTRAINT "lotes_insumos_insumo_id_insumos_id_fk" FOREIGN KEY ("insumo_id") REFERENCES "preview"."insumos"("id") ON DELETE restrict ON UPDATE no action;
SET search_path TO preview, public;

-- ═══ 0005_produccion.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "ordenes_produccion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producto_id" uuid NOT NULL,
	"lote_resultado_id" uuid,
	"cantidad" numeric(12, 2) NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"usuario_id" uuid NOT NULL,
	"observaciones" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "ordenes_produccion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orden_produccion_insumos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orden_id" uuid NOT NULL,
	"lote_insumo_id" uuid NOT NULL,
	"cantidad_usada" numeric(12, 2) NOT NULL,
	"costo_unitario" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orden_produccion_insumos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ordenes_produccion" ADD CONSTRAINT "ordenes_produccion_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "preview"."productos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordenes_produccion" ADD CONSTRAINT "ordenes_produccion_lote_resultado_id_lotes_id_fk" FOREIGN KEY ("lote_resultado_id") REFERENCES "preview"."lotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordenes_produccion" ADD CONSTRAINT "ordenes_produccion_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "preview"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orden_produccion_insumos" ADD CONSTRAINT "orden_produccion_insumos_orden_id_ordenes_produccion_id_fk" FOREIGN KEY ("orden_id") REFERENCES "preview"."ordenes_produccion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orden_produccion_insumos" ADD CONSTRAINT "orden_produccion_insumos_lote_insumo_id_lotes_insumos_id_fk" FOREIGN KEY ("lote_insumo_id") REFERENCES "preview"."lotes_insumos"("id") ON DELETE restrict ON UPDATE no action;
SET search_path TO preview, public;

-- ═══ 0006_clientes.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"tipo_documento" text NOT NULL,
	"documento" text,
	"telefono" text,
	"email" citext,
	"direccion" text,
	"municipio" text,
	"departamento" text,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clientes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "clientes_documento_key" ON "clientes" USING btree ("documento");--> statement-breakpoint
CREATE INDEX "clientes_nombre_idx" ON "clientes" USING btree ("nombre");--> statement-breakpoint
CREATE INDEX "clientes_telefono_idx" ON "clientes" USING btree ("telefono");
SET search_path TO preview, public;

-- ═══ 0007_ventas.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "ventas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fecha" timestamp DEFAULT now() NOT NULL,
	"cliente_id" uuid,
	"usuario_id" uuid NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"descuento" numeric(12, 2) DEFAULT 0 NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"estado" text DEFAULT 'completada' NOT NULL,
	"observaciones" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ventas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "venta_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venta_id" uuid NOT NULL,
	"lote_id" uuid NOT NULL,
	"cantidad" numeric(12, 2) NOT NULL,
	"precio_unitario" numeric(12, 2) NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venta_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pagos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venta_id" uuid NOT NULL,
	"metodo" text NOT NULL,
	"monto" numeric(12, 2) NOT NULL,
	"referencia" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pagos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "preview"."clientes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "preview"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "preview"."ventas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_lote_id_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "preview"."lotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "preview"."ventas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ventas_fecha_idx" ON "ventas" USING btree ("fecha");--> statement-breakpoint
CREATE INDEX "ventas_cliente_idx" ON "ventas" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "ventas_usuario_idx" ON "ventas" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "ventas_estado_idx" ON "ventas" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "venta_items_venta_idx" ON "venta_items" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX "venta_items_lote_idx" ON "venta_items" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "pagos_venta_idx" ON "pagos" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX "pagos_metodo_idx" ON "pagos" USING btree ("metodo");
SET search_path TO preview, public;

-- ═══ 0008_devoluciones.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "devoluciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venta_id" uuid NOT NULL,
	"fecha" timestamp DEFAULT now() NOT NULL,
	"motivo" text,
	"usuario_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devoluciones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "devolucion_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"devolucion_id" uuid NOT NULL,
	"venta_item_id" uuid NOT NULL,
	"cantidad" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devolucion_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "preview"."ventas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "preview"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devolucion_items" ADD CONSTRAINT "devolucion_items_devolucion_id_devoluciones_id_fk" FOREIGN KEY ("devolucion_id") REFERENCES "preview"."devoluciones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devolucion_items" ADD CONSTRAINT "devolucion_items_venta_item_id_venta_items_id_fk" FOREIGN KEY ("venta_item_id") REFERENCES "preview"."venta_items"("id") ON DELETE restrict ON UPDATE no action;
SET search_path TO preview, public;

-- ═══ 0009_retornables.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "botellones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"estado" text DEFAULT 'disponible' NOT NULL,
	"cliente_id" uuid,
	"venta_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "botellones_codigo_key" UNIQUE("codigo")
);
--> statement-breakpoint
ALTER TABLE "botellones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "movimientos_botellones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"botellon_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"cliente_id" uuid,
	"venta_id" uuid,
	"usuario_id" uuid NOT NULL,
	"observaciones" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "movimientos_botellones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "botellones" ADD CONSTRAINT "botellones_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "preview"."clientes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "botellones" ADD CONSTRAINT "botellones_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "preview"."ventas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_botellones" ADD CONSTRAINT "movimientos_botellones_botellon_id_botellones_id_fk" FOREIGN KEY ("botellon_id") REFERENCES "preview"."botellones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_botellones" ADD CONSTRAINT "movimientos_botellones_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "preview"."clientes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_botellones" ADD CONSTRAINT "movimientos_botellones_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "preview"."ventas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_botellones" ADD CONSTRAINT "movimientos_botellones_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "preview"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "botellones_estado_idx" ON "botellones" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "botellones_cliente_idx" ON "botellones" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "movimientos_botellones_botellon_idx" ON "movimientos_botellones" USING btree ("botellon_id");--> statement-breakpoint
CREATE INDEX "movimientos_botellones_tipo_idx" ON "movimientos_botellones" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "movimientos_botellones_cliente_idx" ON "movimientos_botellones" USING btree ("cliente_id");
SET search_path TO preview, public;

-- ═══ 0010_botellon_con_responsable.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
ALTER TABLE "botellones" ADD COLUMN "responsable_actual_id" uuid;--> statement-breakpoint
ALTER TABLE "botellones" ADD CONSTRAINT "botellones_responsable_actual_id_clientes_id_fk" FOREIGN KEY ("responsable_actual_id") REFERENCES "preview"."clientes"("id") ON DELETE set null ON UPDATE no action;
SET search_path TO preview, public;

-- ═══ 0011_proveedores.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "proveedores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"tipo_documento" text NOT NULL,
	"documento" text NOT NULL,
	"telefono" text,
	"email" citext,
	"direccion" text,
	"municipio" text,
	"departamento" text,
	"contacto" text,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proveedores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ordenes_compra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proveedor_id" uuid NOT NULL,
	"fecha" timestamp DEFAULT now() NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"observaciones" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ordenes_compra" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_documento_key" UNIQUE("documento");--> statement-breakpoint
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "preview"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
SET search_path TO preview, public;

-- ═══ 0012_parametros.sql ════════════════════════════════════════════════════════
SET search_path TO preview, public;
CREATE TABLE "parametros" (
	"clave" text PRIMARY KEY NOT NULL,
	"valor" jsonb NOT NULL,
	"descripcion" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "parametros" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parametros" ADD CONSTRAINT "parametros_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "preview"."users"("id") ON DELETE set null ON UPDATE no action;
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
CREATE TABLE "cliente_telefonos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"telefono" text NOT NULL,
	"es_principal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cliente_telefonos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cliente_direcciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"departamento" text,
	"municipio" text,
	"direccion" text NOT NULL,
	"es_principal" boolean DEFAULT false NOT NULL,
	"latitud" numeric(9, 6),
	"longitud" numeric(9, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cliente_direcciones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cliente_telefonos" ADD CONSTRAINT "cliente_telefonos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "preview"."clientes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cliente_direcciones" ADD CONSTRAINT "cliente_direcciones_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "preview"."clientes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cliente_telefonos_cliente_idx" ON "cliente_telefonos" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "cliente_direcciones_cliente_idx" ON "cliente_direcciones" USING btree ("cliente_id");
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
