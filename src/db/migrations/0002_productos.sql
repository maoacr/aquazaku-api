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

CREATE TYPE "public"."presentacion" AS ENUM('paca', 'botellon');--> statement-breakpoint
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
