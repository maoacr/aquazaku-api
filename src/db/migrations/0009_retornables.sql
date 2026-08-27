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
