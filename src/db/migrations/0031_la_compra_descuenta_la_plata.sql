-- La compra a proveedor descuenta de una cuenta — RN-GAS-11.
--
-- ── El hueco que cierra ─────────────────────────────────────────────────────
--
-- M9 movía el inventario y congelaba el costo, pero no tocaba ninguna caja: la
-- plata salía del cajón de verdad y el saldo del sistema seguía igual. Con eso,
-- el saldo que muestra el módulo de gastos es MAYOR que la plata real por el
-- total de lo que se le compre a proveedores — y la diferencia no la explica
-- ningún movimiento.
--
-- ── Por qué no es un `tipo_de_egreso` más ───────────────────────────────────
--
-- Un pago a proveedor no es una categoría de gasto: QUÉ se compró ya está en
-- las líneas de la compra, con cantidad y costo unitario. Un tipo
-- `pago_a_proveedor` sería una segunda clasificación del mismo hecho, y las dos
-- podrían discrepar.
--
-- Un egreso lleva `tipo_de_egreso` O `compra_relacionada`, exactamente uno. Y
-- como el desplegable de gastos solo ofrece tipos, el pago de una compra no se
-- puede registrar «suelto»: RN-GAS-07 sigue valiendo y la única puerta es la
-- compra misma.

ALTER TABLE "movimientos_de_dinero"
  ADD COLUMN "compra_relacionada" uuid REFERENCES "compras"("id") ON DELETE restrict;--> statement-breakpoint

-- Un egreso dice QUÉ fue: una categoría de gasto, o la compra que paga.
ALTER TABLE "movimientos_de_dinero"
  DROP CONSTRAINT "movimientos_dinero_egreso_con_su_tipo";--> statement-breakpoint

ALTER TABLE "movimientos_de_dinero"
  ADD CONSTRAINT "movimientos_dinero_egreso_con_su_tipo" CHECK (
    ("tipo" = 'egreso') = ("tipo_de_egreso" IS NOT NULL OR "compra_relacionada" IS NOT NULL)
  );--> statement-breakpoint

-- Nunca los dos. Un pago de compra con categoría propia dejaría que el reporte
-- «en qué se gastó» cuente la compra como un gasto más, encima de lo que ya
-- cuenta el extracto del contador.
ALTER TABLE "movimientos_de_dinero"
  ADD CONSTRAINT "movimientos_dinero_pago_de_compra_sin_categoria" CHECK (
    NOT ("tipo_de_egreso" IS NOT NULL AND "compra_relacionada" IS NOT NULL)
  );--> statement-breakpoint

-- Una compra se paga UNA sola vez. Sin esto, reintentar el formulario sacaría
-- la plata dos veces por la misma factura, y el libro tendría dos salidas
-- legítimas contra un único documento.
--
-- `WHERE NOT anulado` deja rehacerlo si el pago se cargó en la cuenta
-- equivocada: se anula y se vuelve a registrar.
CREATE UNIQUE INDEX "movimientos_dinero_una_compra_un_pago"
  ON "movimientos_de_dinero" ("compra_relacionada")
  WHERE "compra_relacionada" IS NOT NULL AND NOT "anulado";
