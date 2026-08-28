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
