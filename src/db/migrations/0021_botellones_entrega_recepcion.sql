-- ============================================================================
-- Botellones entregados y recibidos — RN-VEN-17
-- ============================================================================
--
-- Hasta hoy, una venta que despachaba un botellón sin vacío de vuelta
-- registraba la cantidad en un único campo del request (`botellonesSinVacio`)
-- pero NO la persistía en la fila de la venta. La corrección no tenía forma
-- de saber qué se había despachado, y la anulación tampoco podía revertirlo:
-- el dato vivía solo en el cuerpo HTTP y se perdía en el siguiente request.
--
-- Esta migración convierte los dos casos reales del mostrador en columnas
-- propias de la venta:
--
--   · botellones_entregados: cuántos botellones se llevan (cliente recibe de
--     la planta). Default = 0.
--   · botellones_recibidos: cuántos botellones devuelve el cliente en esta
--     transacción. Default = 0.
--
-- Las dos columnas se persisten explícitamente para que la corrección pueda
-- leerlas y calcular el delta compensatorio (RN-VEN-16 + RN-ENV-09), y para
-- que la anulación pueda revertir lo que efectivamente salió y entró
-- (RN-ENV-09 + decisión D5/D8 del change `botellones-entrega-devolucion`).
--
-- ── Por qué `DEFAULT 0` y no `NULL` ─────────────────────────────────────────
--
-- El caso común del mostrador es una venta sin botellones: una paca de bolsas,
-- un repuesto, una recarga con vacío de vuelta. `NOT NULL DEFAULT 0` evita
-- que ese caso —la mayoría de las filas— tenga que pensar en el campo, y hace
-- que la suma `movimientos_botellon.cantidad WHERE clienteId = ?` siempre
-- cuadre contra `botellones_entregados - botellones_recibidos` para una venta
-- sin intercambio.
--
-- ── Backfill defensivo ──────────────────────────────────────────────────────
--
-- El `DEFAULT 0` ya llena las filas existentes, así que los `UPDATE` de abajo
-- no tocan nada en una corrida limpia. Quedan como salvaguarda: si la
-- migración se ejecuta dos veces (alguien la aplica a mano, CI la vuelve a
-- correr), el `ALTER TABLE` fallaría por columna duplicada, pero si por algún
-- motivo la columna existiera sin filas pobladas, el `UPDATE` las asegura.
--
-- ── Aplicación en caliente ──────────────────────────────────────────────────
--
-- `ALTER TABLE ... ADD COLUMN ... DEFAULT 0` en Postgres 17 toma un lock
-- breve sobre la tabla pero NO requiere downtime. La columna no es parte de
-- ningún índice, así que ningún `SELECT` existente se invalida.
--
-- Rollback: `ALTER TABLE ventas DROP COLUMN botellones_entregados,
-- DROP COLUMN botellones_recibidos`.
-- ============================================================================

ALTER TABLE ventas
  ADD COLUMN botellones_entregados INT NOT NULL DEFAULT 0,
  ADD COLUMN botellones_recibidos  INT NOT NULL DEFAULT 0;

UPDATE ventas
SET botellones_entregados = 0
WHERE botellones_entregados IS NULL;

UPDATE ventas
SET botellones_recibidos = 0
WHERE botellones_recibidos IS NULL;