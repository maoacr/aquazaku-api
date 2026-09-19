-- ============================================================================
-- Corregir una venta registrada — RN-VEN-16
-- ============================================================================
--
-- RN-VEN-02 sigue en pie y no se toca: una venta confirmada NO se edita. El
-- monto de ayer no puede cambiar hoy, y ningun UPDATE de esta migracion lo
-- permite.
--
-- Lo que faltaba era la otra mitad de esa regla. RN-VEN-02 ya decia cual es la
-- salida cuando una venta esta mal — «se anula y se registra una nueva»— pero
-- el sistema la dejaba en manos del operador: dos actos separados, en dos
-- pantallas, sin nada que los una. En la practica eso significa tres cosas:
--
--   · Nadie sabe que la venta #7 existe PORQUE la #3 estaba mal.
--   · Entre un acto y el otro, el stock y la deuda quedan en un estado que no
--     corresponde a ninguna realidad.
--   · Si el segundo acto se olvida, la venta simplemente desaparecio.
--
-- Esta migracion convierte esos dos actos en UNO, atomico y enlazado. Desde la
-- pantalla se siente «editar la venta». Abajo sigue siendo anular y rehacer,
-- que es exactamente lo que RN-VEN-02 manda.
--
-- ── Por que un estado propio y no reusar `anulada` ──────────────────────────
--
-- «Cuantas ventas anulamos este mes» es una alarma operativa: mide errores de
-- mostrador y plata que se devolvio. Si las correcciones entraran ahi, la
-- alarma subiria cada vez que alguien arregla un tipeo, y en un mes dejaria de
-- mirarse. Son dos hechos distintos y merecen dos nombres distintos.
--
-- Todo filtro `estado = 'confirmada'` —la deuda, la cartera, los reportes del
-- contador— sigue siendo correcto sin tocar una linea: una venta corregida
-- tampoco esta confirmada.
--
-- ── Por que ningun DDL de aca nombra 'corregida' ────────────────────────────
--
-- Postgres no deja USAR un valor de enum recien agregado dentro de la misma
-- transaccion en la que se agrego, salvo que el tipo tambien se haya creado
-- ahi. Drizzle corre todas las migraciones en una sola transaccion, asi que
-- sobre una base NUEVA el tipo nace y crece junto y el literal funcionaria —
-- pero sobre la base de PRODUCCION, donde el tipo ya existe hace meses, el
-- mismo SQL revienta.
--
-- Seria el peor tipo de bug: verde en los tests, rojo en el despliegue. Por eso
-- los CHECK de abajo dicen `<> 'confirmada'` en vez de enumerar los estados
-- malos. Ademas de seguro, es lo que de verdad se quiere decir: «si no esta
-- confirmada, tiene que constar quien y por que».
-- ============================================================================

ALTER TYPE "estado_de_venta" ADD VALUE IF NOT EXISTS 'corregida' AFTER 'anulada';--> statement-breakpoint

-- ============================================================================
-- El enlace entre la venta vieja y la que la reemplaza
--
-- Las dos puntas, y a proposito. Con solo `corrige_a_id` se puede ir de la
-- nueva a la vieja, pero la pregunta que se hace parado en la lista es la
-- contraria: «esta venta esta anulada... ¿a donde fue a parar?». Resolverla con
-- un scan inverso sobre cien mil filas para dibujar una tarjeta no es un
-- indice: es la columna que falta.
--
-- `ON DELETE RESTRICT` porque una venta no se borra nunca. Es el mismo criterio
-- que ya rige entre `lineas_de_venta` y `ventas`.
-- ============================================================================
ALTER TABLE "ventas"
  ADD COLUMN "corrige_a_id" uuid REFERENCES "ventas"("id") ON DELETE RESTRICT,
  ADD COLUMN "corregida_por_id" uuid REFERENCES "ventas"("id") ON DELETE RESTRICT;--> statement-breakpoint

COMMENT ON COLUMN "ventas"."corrige_a_id" IS
  'RN-VEN-16: la venta que esta reemplaza porque estaba mal. Se escribe al INSERT y no cambia mas.';--> statement-breakpoint

COMMENT ON COLUMN "ventas"."corregida_por_id" IS
  'RN-VEN-16: la venta que reemplaza a esta. Se escribe en el mismo UPDATE que la pasa a corregida.';--> statement-breakpoint

CREATE INDEX "ventas_corrige_a_idx" ON "ventas" ("corrige_a_id");--> statement-breakpoint
CREATE INDEX "ventas_corregida_por_idx" ON "ventas" ("corregida_por_id");--> statement-breakpoint

-- ============================================================================
-- Quien y por que, para CUALQUIER estado que no sea confirmada
--
-- El CHECK viejo enumeraba `estado = 'anulada'`, asi que una venta corregida
-- —con su responsable y su motivo cargados— lo violaba. Reescribirlo por la
-- negativa arregla eso y ademas deja de ser una lista que hay que acordarse de
-- ampliar cada vez que aparece un estado nuevo.
--
-- La intencion no cambio ni un poco: media anulacion, motivo sin responsable o
-- estado sin explicacion siguen siendo imposibles.
-- ============================================================================
ALTER TABLE "ventas" DROP CONSTRAINT "ventas_anulacion_completa";--> statement-breakpoint

ALTER TABLE "ventas" ADD CONSTRAINT "ventas_anulacion_completa" CHECK (
  ("estado" = 'confirmada'
     AND "anulada_en" IS NULL
     AND "motivo_anulacion" IS NULL)
  OR ("estado" <> 'confirmada'
     AND "anulada_en" IS NOT NULL
     AND "motivo_anulacion" IS NOT NULL)
);--> statement-breakpoint

-- Una venta no se corrige a si misma. Sin esto, un `UPDATE` con el id
-- equivocado deja una fila que se apunta sola y un historial que no termina.
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_correccion_no_es_circular" CHECK (
  ("corrige_a_id" IS NULL OR "corrige_a_id" <> "id")
  AND ("corregida_por_id" IS NULL OR "corregida_por_id" <> "id")
);--> statement-breakpoint

-- Una venta que tiene sucesora NO puede seguir confirmada: contaria dos veces
-- en la deuda y en los reportes, una por cada punta del reemplazo.
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_corregida_no_sigue_confirmada" CHECK (
  "corregida_por_id" IS NULL OR "estado" <> 'confirmada'
);--> statement-breakpoint

-- ============================================================================
-- El trigger, ampliado a la transicion que faltaba
--
-- Antes dejaba pasar UNA transicion: confirmada -> anulada. Ahora deja pasar
-- las dos salidas de confirmada, y sigue sin dejar pasar ninguna edicion.
--
-- Se escribe por la negativa —`NEW.estado = 'confirmada'` es lo que se rechaza—
-- por la misma razon que los CHECK de arriba: nombrar el valor nuevo aca lo
-- haria fallar contra la base de produccion.
--
-- `corregida_por_id` es lo UNICO que se suma a lo que el UPDATE puede escribir,
-- y solo puede ir de NULL a un valor: apuntar a otra sucesora despues seria
-- reescribir la historia del reemplazo. `corrige_a_id` entra a la lista de lo
-- inmutable: se escribe cuando la fila nace y no se toca nunca mas.
-- ============================================================================
CREATE OR REPLACE FUNCTION solo_anulacion_en_ventas() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.estado <> 'confirmada' THEN
    RAISE EXCEPTION 'una venta que ya salio de confirmada no se vuelve a tocar';
  END IF;

  IF NEW.estado = 'confirmada' THEN
    RAISE EXCEPTION 'una venta confirmada solo puede pasar a anulada o corregida — RN-VEN-02';
  END IF;

  -- Todo lo demas tiene que quedar como estaba. Si el monto de ayer puede
  -- cambiar hoy, ningun arqueo es confiable.
  IF NEW.total IS DISTINCT FROM OLD.total
     OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
     OR NEW.medio_de_pago IS DISTINCT FROM OLD.medio_de_pago
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.corrige_a_id IS DISTINCT FROM OLD.corrige_a_id THEN
    RAISE EXCEPTION 'anular no edita la venta: solo cambia su estado — RN-VEN-02';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
