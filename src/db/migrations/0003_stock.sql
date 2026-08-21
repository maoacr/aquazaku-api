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

CREATE TYPE "public"."causa_descarte" AS ENUM('falla_produccion', 'mal_manejo_cliente', 'vencido', 'otro');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento" AS ENUM('produccion', 'ajuste', 'descarte', 'venta', 'devolucion');--> statement-breakpoint
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
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_lote_id_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "public"."lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
