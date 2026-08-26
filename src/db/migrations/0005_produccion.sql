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

CREATE TYPE "public"."tanque" AS ENUM('crudo', 'procesado');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento_agua" AS ENUM('ingreso_red', 'procesamiento', 'envasado', 'lavado', 'ajuste');--> statement-breakpoint
CREATE TYPE "public"."nivel_tanque" AS ENUM('vacio', 'un_cuarto', 'medio', 'tres_cuartos', 'lleno');--> statement-breakpoint

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

ALTER TABLE "cierres_produccion" ADD CONSTRAINT "cierres_produccion_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_agua" ADD CONSTRAINT "movimientos_agua_cierre_id_cierres_produccion_id_fk" FOREIGN KEY ("cierre_id") REFERENCES "public"."cierres_produccion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_agua" ADD CONSTRAINT "movimientos_agua_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

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
