-- ============================================================================
-- `primer_registro_en` desde la RAÍZ de la corrección — RN-VEN-16
-- ============================================================================
--
-- Refina el backfill de 0025. No cambia ninguna estructura: solo corrige, hacia
-- atrás, filas que 0025 no pudo fechar bien con lo que miraba.
--
-- ── Qué se le escapó a 0025 ─────────────────────────────────────────────────
--
-- 0025 saca el instante real de registro del `audit_log`, buscando la fila cuyo
-- `payload->>'resourceId'` es el id de la venta. El problema es qué venta nombra
-- ese campo cuando la acción es `ventas:corregir`: nombra la venta **NUEVA**, no
-- la que se reemplazó (`routes.ts` escribe `resourceId: resultado.venta.id` y
-- deja la vieja en `reemplaza`).
--
-- Entonces, para una venta que nació del mostrador y después se corrigió, la
-- fila que 0025 encuentra es la de la CORRECCIÓN. Y `primer_registro_en` termina
-- con la hora en que alguien arregló un tipeo, que es justo lo que la columna
-- promete NO ser: su contrato es «cuándo entró este hecho al sistema por primera
-- vez».
--
-- La historia completa sí está escrita, solo que repartida: el primer registro
-- vive en la fila `ventas:crear` de la venta ORIGINAL, y la original se alcanza
-- siguiendo `corrige_a_id` hacia atrás. Esta migración recorre esa cadena y se
-- queda con el instante más viejo de todos sus eslabones.
--
-- ── Por qué solo mueve hacia ATRÁS ──────────────────────────────────────────
--
-- `WHERE raiz < primer_registro_en` no es una optimización: es lo que acota la
-- migración a su objetivo.
--
-- El defecto de 0025 siempre apunta en la misma dirección —guardó un instante
-- POSTERIOR al que correspondía— así que corregirlo es siempre adelantar la
-- fecha. Cualquier fila a la que la cadena le propusiera un instante más nuevo
-- no es una fila mal fechada: es una fila que ya está bien, y se la deja en paz.
--
-- Eso es lo que hace que esto no toque las ventas nacidas DESPUÉS de 0025, que
-- ya tienen el valor correcto y no hay que reescribir:
--
--   · Una venta normal lleva el `defaultNow()` del INSERT, y su fila de
--     auditoría se escribe un instante después. La cadena propone algo más
--     nuevo ⇒ no se toca.
--   · Una corrección heredó el `primer_registro_en` de la original, que es el
--     `defaultNow()` del insert de aquella —también anterior a su auditoría—.
--     La cadena propone algo más nuevo ⇒ no se toca.
--
-- Por lo mismo es idempotente: correrla dos veces no mueve nada la segunda vez.
--
-- ── Medido ──────────────────────────────────────────────────────────────────
--
-- En `aquazaku_dev` mueve 0 filas, y está bien que sea así: las 7 ventas
-- corregidas que hay tienen originales de semilla, cargadas por fuera de la API,
-- que nunca dejaron fila de auditoría. Sin `ventas:crear` de la original, la
-- cadena no tiene nada más viejo que ofrecer y `created_at` sigue siendo la mejor
-- evidencia disponible.
--
-- Donde esto trabaja de verdad es en producción, donde las originales SÍ pasaron
-- por la API. Verificado a mano reconstruyendo el caso: una venta creada por la
-- API, corregida por la API, y con `primer_registro_en` puesto a la hora de la
-- corrección como lo habría dejado 0025 — esta migración la devuelve a la hora
-- del `ventas:crear` de la original.
--
-- ── El tope de hondura ──────────────────────────────────────────────────────
--
-- `corrige_a_id` no puede ciclar: se escribe cuando la fila nace, apunta a una
-- fila que ya existía, y `ventas_correccion_no_es_circular` descarta el
-- autoapunte. El `hondura < 50` igual va, porque un `WITH RECURSIVE` sobre un
-- ciclo no falla: gira para siempre, y una migración colgada en producción es un
-- precio muy alto por confiar en un invariante que vive en otro archivo.
--
-- ── Y el trigger, otra vez ──────────────────────────────────────────────────
--
-- `ventas_solo_anulacion` rechaza todo `UPDATE` que no sea el cambio de estado
-- de salida, y desde 0025 congela además esta misma columna. Se apaga para la
-- sentencia y se vuelve a prender — igual que en 0025.
--
-- Rollback: ninguno. No hay estructura que revertir, y los valores que esto
-- escribe son más correctos que los que reemplaza. Si hubiera que volver atrás,
-- el backfill de 0025 se reconstruye entero desde `audit_log` y `created_at`.
-- ============================================================================

ALTER TABLE ventas DISABLE TRIGGER ventas_solo_anulacion;--> statement-breakpoint

WITH RECURSIVE cadena AS (
  -- Cada venta arranca siendo su propio eslabón.
  SELECT id AS venta_id, id AS eslabon, corrige_a_id, 1 AS hondura
  FROM ventas
  UNION ALL
  -- Y se sigue `corrige_a_id` hacia atrás, hasta la original.
  SELECT c.venta_id, v.id, v.corrige_a_id, c.hondura + 1
  FROM cadena c
  JOIN ventas v ON v.id = c.corrige_a_id
  WHERE c.hondura < 50
), auditoria AS (
  SELECT (a.payload->>'resourceId')::uuid AS venta_id,
         MIN(a.created_at)                AS reg
  FROM audit_log a
  WHERE a.resource = 'ventas'
    AND a.action IN ('ventas:crear', 'ventas:crear_retroactiva', 'ventas:corregir')
    AND a.payload->>'resourceId' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  GROUP BY 1
), raiz AS (
  -- El instante más viejo de toda la cadena: el del primer registro de verdad.
  SELECT c.venta_id, MIN(au.reg) AS primera
  FROM cadena c
  JOIN auditoria au ON au.venta_id = c.eslabon
  GROUP BY 1
)
UPDATE ventas v
SET primer_registro_en = r.primera
FROM raiz r
WHERE r.venta_id = v.id
  AND r.primera < v.primer_registro_en;--> statement-breakpoint

ALTER TABLE ventas ENABLE TRIGGER ventas_solo_anulacion;
