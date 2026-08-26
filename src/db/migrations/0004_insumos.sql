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

CREATE TYPE "public"."unidad_insumo" AS ENUM('unidad');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento_insumo" AS ENUM('compra', 'ajuste', 'descarte', 'produccion');--> statement-breakpoint

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

ALTER TABLE "movimientos_insumo" ADD CONSTRAINT "movimientos_insumo_insumo_id_insumos_id_fk" FOREIGN KEY ("insumo_id") REFERENCES "public"."insumos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_insumo" ADD CONSTRAINT "movimientos_insumo_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

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
