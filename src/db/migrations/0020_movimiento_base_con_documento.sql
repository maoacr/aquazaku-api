-- ============================================================================
-- De que venta salio esta base — RN-BAS-03 y RN-VEN-16
-- ============================================================================
--
-- `movimientos_botellon` guarda `documento_id` desde M7, y el comentario que lo
-- acompana explica por que: «apunta a la venta que lo origino, asi que el
-- movimiento se puede explicar sin preguntarle a nadie».
--
-- `movimientos_base` nunca lo tuvo. Una base que sale con una venta deja una
-- fila que dice que la base fue a una direccion, y nada mas — ni de que venta,
-- ni con cual cobro. La asimetria no fue una decision: los dos caminos se
-- escribieron en momentos distintos.
--
-- ── Lo que la falta rompia en concreto ───────────────────────────────────────
--
-- Corregir una venta (RN-VEN-16) no re-emite los activos fisicos: el envase
-- salio UNA vez y sigue afuera. Por eso la correccion rechaza cambiar el cliente
-- cuando la venta despacho un activo, que si no quedaria la venta a nombre de
-- una persona y el activo a cargo de otra.
--
-- Esa guarda podia mirar los botellones —tienen `documento_id`— y NO las bases.
-- Una venta que presto una base podia cambiar de cliente, y la base se quedaba
-- en la direccion del cliente viejo sin que nada protestara.
--
-- Nullable, porque la mayoria de los movimientos de base no vienen de una venta:
-- un prestamo desde Retornables, un retorno, un descarte. `NULL` significa «no
-- salio de ningun documento», que es verdad, y no «se perdio el dato».
-- ============================================================================

ALTER TABLE "movimientos_base"
  ADD COLUMN "documento_id" uuid;--> statement-breakpoint

COMMENT ON COLUMN "movimientos_base"."documento_id" IS
  'La venta que origino este movimiento, si vino de una. NULL es un movimiento propio de Retornables.';--> statement-breakpoint

CREATE INDEX "movimientos_base_documento_idx"
  ON "movimientos_base" ("documento_id");
