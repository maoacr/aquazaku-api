-- ============================================================================
-- Sacar una fila de la lista de seguimientos, a mano — RN-CLI-18
-- ============================================================================
--
-- La lista de seguimientos es el padrón completo de direcciones que alguna vez
-- compraron, ordenado por días sin recibir. No se puede filtrar: entra todo el
-- que compró, y eso es a propósito —antes filtraba por umbral y la única forma
-- de ver a un cliente era que estuviera atrasado—.
--
-- El costo de esa decisión es que aparecen filas que la operación sabe que no
-- hay que llamar: el que avisó que se muda, el que compró una vez para un
-- evento, el local que cerró. Hoy no hay forma de sacarlas, así que conviven
-- con las que sí importan y le quitan valor a recorrer la lista.
--
-- ── Qué NO hace ─────────────────────────────────────────────────────────────
--
-- No borra al cliente, no lo desactiva y no toca un dato suyo. Lo único que
-- dice esta tabla es «no me muestres esta fila en esta lista».
--
-- ── Por qué la clave son TRES columnas ──────────────────────────────────────
--
-- Porque una fila de seguimientos es una dirección en un canal. El agua se
-- entrega a una puerta, y un botellón de 20 L y una paca de 80 bolsas llevan
-- relojes distintos: un cliente con casa y local tiene cuatro filas posibles, y
-- ocultar una no dice nada de las otras tres.
--
-- `direccion_id` admite NULL a propósito: es la fila de las ventas anteriores a
-- la 0022, las que no registraron a qué dirección se entregaron. Son filas
-- reales —y de las más ruidosas— así que tienen que poder ocultarse.
--
-- ── Por qué una FECHA y no un booleano ──────────────────────────────────────
--
-- Acá está todo el diseño. La regla pedida es «si el cliente vuelve a comprar,
-- la fila reaparece». Con un booleano eso exige que alguien lo apague: un
-- trigger en `ventas`, o una tarea que barra la tabla. Las dos formas pueden
-- fallar en silencio y dejar a un cliente invisible para siempre — y un cliente
-- invisible en esta lista es un cliente al que nadie va a llamar nunca.
--
-- Con una fecha no hay nada que apagar. La fila se oculta SOLO si `ocultado_en`
-- es posterior a su última venta, así que una venta nueva la devuelve a la
-- lista por aritmética.
--
-- Corolario: el registro no se borra cuando la fila reaparece. Queda, y volver
-- a ocultar mueve la fecha — de ahí el UNIQUE, que convierte el segundo
-- ocultamiento en un UPSERT en vez de una fila duplicada.
--
-- ── NULLS NOT DISTINCT, y sin eso la tabla no sirve ─────────────────────────
--
-- Postgres trata cada NULL como distinto de todos los demás, así que un UNIQUE
-- normal dejaría ocultar veinte veces la misma fila sin dirección, y cada
-- UPSERT crearía una fila nueva en vez de mover la fecha. Requiere Postgres 15;
-- acá corre 17.
--
-- ── Permisos ────────────────────────────────────────────────────────────────
--
-- No hay GRANT. La 0001 dejó `ALTER DEFAULT PRIVILEGES`, así que las tablas
-- nuevas heredan SELECT/INSERT/UPDATE/DELETE para `aquazaku_app` solas. Los
-- cuatro hacen falta: leer la lista, ocultar, mover la fecha y volver a mostrar.
--
-- ── Esta migración se escribió A MANO, y hay que seguir haciéndolo ──────────
--
-- `pnpm db:generate` NO sirve en este repo: en `meta/` solo hay snapshots hasta
-- la 0021, así que drizzle-kit cree que el esquema está en ese estado y genera
-- el diff completo desde ahí. Medido al intentarlo para esta migración: produjo
-- un `DROP INDEX ventas_fecha_idx`, un `ADD COLUMN bases.tipo NOT NULL` que ya
-- existe desde la 0027 y cuatro columnas más ya aplicadas. Aplicar eso contra
-- producción la rompe.
--
-- Rollback:
--
--   DROP TABLE seguimientos_ocultos;
--   DROP TYPE canal_de_seguimiento;
--
-- Pierde qué filas estaban ocultas, y nada más: todas vuelven a la lista. No
-- toca ningún dato de clientes, direcciones ni ventas.
-- ============================================================================

CREATE TYPE "public"."canal_de_seguimiento" AS ENUM('botellones', 'otros');
--> statement-breakpoint

CREATE TABLE "seguimientos_ocultos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"direccion_id" uuid,
	"canal" "canal_de_seguimiento" NOT NULL,
	"ocultado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"ocultado_por" uuid,
	CONSTRAINT "seguimientos_ocultos_fila" UNIQUE NULLS NOT DISTINCT("cliente_id","direccion_id","canal")
);
--> statement-breakpoint

ALTER TABLE "seguimientos_ocultos" ADD CONSTRAINT "seguimientos_ocultos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "seguimientos_ocultos" ADD CONSTRAINT "seguimientos_ocultos_direccion_id_direcciones_id_fk" FOREIGN KEY ("direccion_id") REFERENCES "public"."direcciones"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "seguimientos_ocultos" ADD CONSTRAINT "seguimientos_ocultos_ocultado_por_users_id_fk" FOREIGN KEY ("ocultado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "seguimientos_ocultos_canal_idx" ON "seguimientos_ocultos" USING btree ("canal","cliente_id");
