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
