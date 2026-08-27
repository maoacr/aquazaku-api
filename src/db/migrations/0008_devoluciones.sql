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
