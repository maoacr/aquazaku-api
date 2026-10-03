-- ============================================================================
-- El desempate del orden de ventas — RN-VEN-14 + RN-VEN-16
-- ============================================================================
--
-- La ficha del cliente promete por escrito «de la más reciente a la más vieja».
-- No lo estaba cumpliendo, y la causa son dos cosas que se suman:
--
--   1. `exigirFechaRegistrable` ancla toda venta cargada con `ocurrioEn` al
--      MEDIODÍA de la planta (`<fecha>T12:00:00-05:00`). Dos ventas cargadas con
--      la misma fecha pasada quedan con el mismo instante al microsegundo.
--
--   2. El listado ordenaba con `created_at DESC` y nada más. Sobre filas
--      empatadas, `ORDER BY` no define ningún orden.
--
-- ── Rompe en las dos direcciones, según el plan ──────────────────────────────
--
-- Esto no es teórico y no es estable, que es lo peor de las dos cosas. Medido:
--
--   · En `aquazaku_dev` el planner elegía seq scan y devolvía orden de heap: una
--     venta recién cargada aparecía DEBAJO de dos más viejas del mismo día.
--   · En una base limpia elegía recorrer el índice hacia atrás, y entonces una
--     CORRECCIÓN —que nace con el TID más alto— saltaba al TOPE de la lista.
--
-- El mismo dato, dos listas distintas. Un `ORDER BY` incompleto no se cae: se
-- pone de acuerdo con el planner, y cambia de opinión cuando la tabla crece.
--
-- Y con `LIMIT 100` encima, una fila empatada en el borde del corte puede
-- aparecer dos veces o ninguna entre dos recargas de la misma pantalla.
--
-- ── Qué agrega esta migración ───────────────────────────────────────────────
--
-- `primer_registro_en`: el instante en que el hecho entró al sistema por
-- primera vez. `created_at` sigue contestando «¿cuándo compró?» y es la que
-- mandan las pantallas y los reportes; esta solo desempata, y conserva lo que
-- el anclaje al mediodía borra.
--
-- La corrección la HEREDA de la venta que reemplaza, igual que ya heredaba
-- `created_at`. Sin esa herencia, arreglar un tipeo movería la venta de lugar.
--
-- ── El backfill sale del `audit_log`, no de una suposición ───────────────────
--
-- `DEFAULT now()` sirve para las filas nuevas, pero en las que ya existen
-- pondría la hora de la MIGRACIÓN y las dejaría todas empatadas entre sí:
-- cambiar un empate por otro peor.
--
-- El instante real de registro de las ventas históricas existe y está escrito:
-- `audit_log` guarda una fila por venta creada o corregida, con el id de la
-- venta en `payload->>'resourceId'` y su `created_at` real. Es dato medido, no
-- inventado.
--
-- Medido en `aquazaku_dev` antes de escribir esto: 15 de 46 ventas tienen fila
-- de auditoría, y son EXACTAMENTE las que estaban empatadas. Tras el backfill no
-- queda un solo empate. Las 31 restantes son semilla y carga directa, nunca
-- pasaron por la API; para ellas `created_at` es la mejor evidencia que hay, y
-- al no estar empatadas alcanza.
--
-- `resourceId` se filtra contra la forma de un UUID a propósito: algunas filas
-- viejas de auditoría lo traen como el texto `(nuevo)`, y un cast directo
-- revienta la migración entera.
--
-- ── Por qué hay que apagar el trigger para el backfill ───────────────────────
--
-- `ventas_solo_anulacion` rechaza TODO `UPDATE` sobre una venta que no sea
-- cambiarle el estado de salida (RN-VEN-02). Eso incluye este backfill, y está
-- bien que lo incluya: es la misma protección que impide que el monto de ayer
-- cambie hoy.
--
-- Así que se apaga para las dos sentencias y se vuelve a prender. Que llenar una
-- columna cueste este ritual es la señal de que la protección sirve — el mismo
-- criterio con el que `resetDb` apaga los triggers de `audit_log`.
--
-- ── Y `primer_registro_en` entra a lo inmutable ──────────────────────────────
--
-- La columna se suma a la lista que el trigger congela, al lado de `created_at`.
-- Por el mismo motivo: si la clave con la que se ordena puede cambiar después,
-- el orden de una lista vieja no se puede reconstruir, y volvemos a tener dos
-- listas posibles para el mismo dato.
--
-- ── Aplicación en caliente ──────────────────────────────────────────────────
--
-- `ADD COLUMN ... DEFAULT now()` no reescribe la tabla en Postgres 17 (el
-- default se guarda como metadato), así que toma un lock breve y nada más. El
-- backfill sí reescribe las filas, pero son decenas, no millones.
--
-- El índice `ventas_fecha_idx` pasa de `(created_at)` a
-- `(created_at, primer_registro_en)`. `created_at` queda adelante, así que todo
-- lo que filtra por rango de fecha —extracto, cartera, `a-llamar`— lo sigue
-- usando igual; lo que gana es que el listado recorra el índice ya ordenado en
-- vez de ordenar en memoria.
--
-- Rollback:
--   DROP INDEX ventas_fecha_idx;
--   CREATE INDEX ventas_fecha_idx ON ventas (created_at);
--   ALTER TABLE ventas DROP COLUMN primer_registro_en;
--   (y volver a poner la versión de 0019 de `solo_anulacion_en_ventas`)
-- ============================================================================

ALTER TABLE ventas
  ADD COLUMN primer_registro_en TIMESTAMPTZ NOT NULL DEFAULT now();--> statement-breakpoint

ALTER TABLE ventas DISABLE TRIGGER ventas_solo_anulacion;--> statement-breakpoint

-- Paso 1: el piso para TODAS, que es lo mejor que se sabe sin auditoría.
UPDATE ventas SET primer_registro_en = created_at;--> statement-breakpoint

-- Paso 2: el instante REAL encima, para las que pasaron por la API. Va segundo a
-- propósito: así ninguno de los dos pasos depende de comparar la hora de la
-- migración contra la de la venta.
WITH primero AS (
  SELECT (a.payload->>'resourceId')::uuid AS venta_id,
         MIN(a.created_at)                AS registrado_real
  FROM audit_log a
  WHERE a.resource = 'ventas'
    AND a.action IN ('ventas:crear', 'ventas:crear_retroactiva', 'ventas:corregir')
    AND a.payload->>'resourceId' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  GROUP BY 1
)
UPDATE ventas v
SET primer_registro_en = p.registrado_real
FROM primero p
WHERE p.venta_id = v.id;--> statement-breakpoint

ALTER TABLE ventas ENABLE TRIGGER ventas_solo_anulacion;--> statement-breakpoint

-- ============================================================================
-- El trigger, con la clave del orden sumada a lo inmutable
--
-- Igual que `created_at`: se escribe cuando la fila nace y no se toca nunca mas.
-- Es lo unico que cambia respecto de la version de 0019.
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
     OR NEW.primer_registro_en IS DISTINCT FROM OLD.primer_registro_en
     OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.corrige_a_id IS DISTINCT FROM OLD.corrige_a_id THEN
    RAISE EXCEPTION 'anular no edita la venta: solo cambia su estado — RN-VEN-02';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP INDEX IF EXISTS ventas_fecha_idx;--> statement-breakpoint
CREATE INDEX ventas_fecha_idx ON ventas (created_at, primer_registro_en);
