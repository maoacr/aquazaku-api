-- ============================================================================
-- El precio escrito a mano en la línea — RN-VEN-15
-- ============================================================================
--
-- Aquazaku vendió durante años antes de que este software existiera, a precios
-- que hoy no están en ninguna tabla: $3.800, $5.500, $9.600. RN-VEN-14 ya deja
-- fechar esas ventas hacia atrás, pero se cobrarían con la lista de HOY — y una
-- venta de agosto por $10.000 que en realidad fue por $3.800 es un reporte de
-- agosto inventado, con la autoridad de estar en la base.
--
-- ── Por qué esto es una columna y no un derivado ─────────────────────────────
--
-- Una línea con precio manual se escribe con `lista = mínimo = final`. Eso es
-- INDISTINGUIBLE de un producto cuyo piso iguala su precio de lista — que es,
-- exactamente, el estado del seed hoy (`precio_minimo = precio_residencial =
-- 10000`). Sin esta bandera, dentro de tres meses nadie puede separar «alguien
-- escribió este número» de «el catálogo estaba así».
--
-- RN-VEN-04 pide que la línea se explique sola. Cuatro números que pueden
-- significar dos cosas distintas no la explican.
--
-- ── Lo que esta migración NO hace ────────────────────────────────────────────
--
-- No toca `lineas_respetan_el_piso`, y es a propósito. El precio manual pasa a
-- ser el piso de SU línea, así que el CHECK se cumple por igualdad y el piso del
-- catálogo sigue cubriendo a las demás.
--
-- Borrarlo habría sido caro y silencioso: NO existe un `precio_final >= 0` en
-- esta tabla. La no-negatividad sale por transitividad de
-- `productos_precios_no_negativos`, y sin el piso un descuento `monto_fijo` mal
-- cargado escribe una línea en negativo sin que nada chille.
--
-- Aditiva y con default: las líneas que ya existen se cobraron con la lista, que
-- es lo que `false` dice.

ALTER TABLE "lineas_de_venta"
  ADD COLUMN "precio_manual" boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN "lineas_de_venta"."precio_manual" IS
  'RN-VEN-15: alguien escribió este precio a mano en vez de tomarlo del catálogo.';
