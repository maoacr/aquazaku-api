-- Ningún botellón sale del parque sin un responsable — RN-ENV-09.
--
-- ── Por qué esto vive en la base y no solo en el servicio ────────────────────
--
-- Un botellón que sale sin quedar anotado a nombre de alguien no genera una fila
-- rota: genera una fila que FALTA. Y esa es la peor forma del problema, porque
-- la ley de conservación de RN-ENV-02 **no la detecta**.
--
-- Si el `pos` se olvida, no se escribe nada: `registrados` no cambia,
-- `enPoderDeAlguien` no cambia, y la ley sigue diciendo `cuadra: true` mientras
-- el botellón está en la casa del cliente y el sistema lo cree en la bodega.
-- Solo aparece cuando alguien cuenta físicamente, meses después, sin saber a
-- quién reclamarle.
--
-- La ley detecta filas que faltan RESPECTO DE SÍ MISMA. No detecta que la
-- realidad se fue por otro lado. Este CHECK cubre ese hueco por el otro lado:
-- la fila del cliente no puede existir sin cliente.
--
-- ── Cada movimiento son DOS filas, y solo una es del cliente ────────────────
--
--   entrega   bodega  −n  (cliente_id NULL)   cliente  +n  (cliente_id)
--   retorno   cliente −n  (cliente_id)        bodega   +n  (cliente_id NULL)
--
-- La fila del cliente cambia de signo según la dirección, y la de la bodega
-- SIEMPRE va con `cliente_id` en NULL — la bodega no es un cliente. Por eso el
-- CHECK cruza tipo y signo en vez de mirar solo uno: pedirle cliente a toda
-- fila positiva rompería el retorno, que ingresa a la bodega.
--
-- ── Qué NO toca ─────────────────────────────────────────────────────────────
--
-- Compras, descartes y ajustes de bodega son movimientos del parque contra sí
-- mismo, sin tenedor del otro lado. Quedan afuera por construcción: ninguno es
-- `entrega` ni `retorno`.
--
-- Y una venta sin cliente sigue siendo válida: quien compra una paca de bolsas
-- en el mostrador no se lleva ningún activo retornable. La regla es «ningún
-- BOTELLÓN sale sin responsable», no «toda venta necesita cliente».

ALTER TABLE "movimientos_botellon"
  ADD CONSTRAINT "movimientos_botellon_con_responsable"
  CHECK (
    -- Lo que sale hacia alguien tiene que decir hacia quién.
    NOT ("tipo" = 'entrega' AND "cantidad" > 0 AND "cliente_id" IS NULL)
    -- Y lo que vuelve tiene que decir a quién se le descuenta.
    AND NOT ("tipo" = 'retorno' AND "cantidad" < 0 AND "cliente_id" IS NULL)
  );
