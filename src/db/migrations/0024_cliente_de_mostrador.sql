-- ============================================================================
-- El tacho se marca como tacho — RN-CLI-21
-- ============================================================================
--
-- ── Qué es este cliente ─────────────────────────────────────────────────────
--
-- La migración 0023 ya lo describió: «POS Aquazaku» no es un cliente, es un
-- TACHO. Adentro conviven cientos de personas distintas que no quisieron
-- registrarse, así que su cartera no le pertenece a nadie y su historial no
-- dice nada de ninguna de ellas.
--
-- Aquella migración quitó el motivo por el que el tacho existe —ahora un
-- cliente se registra solo con el nombre— pero el tacho sigue ahí, con más de
-- doscientas ventas colgando.
--
-- ── Por qué hace falta una COLUMNA y no un nombre en el código ──────────────
--
-- Seguimientos lo muestra primero en las dos listas, porque es el que más
-- ventas tiene y las más viejas. Es la fila que más se mira ocupada por la
-- única fila a la que NO se puede llamar: no hay a quién.
--
-- La tentación es filtrarlo por nombre. En una sola conversación con la
-- operación apareció escrito «Pos Acuazaku», «Pos Aquazaku» y «POS aquazaku»:
-- filtrar por texto es poner el ruido a una renombrada de distancia, y cuando
-- vuelva no va a fallar nada — simplemente va a reaparecer, y nadie va a
-- relacionar la fila nueva con una regla escrita meses antes.
--
-- `parametros` tampoco sirve: su `valor` es un `integer` con mínimo y máximo,
-- hecho para umbrales, y meterle un uuid deformaría la tabla para todos.
--
-- Una columna dice lo que la cosa ES, sobrevive a los renombres, y la regla
-- vive en la base y no en una pantalla — que es [ADR-0006].
--
-- ── Por qué `es_mostrador` y no `en_seguimientos` ───────────────────────────
--
-- Lo segundo describe DÓNDE se usa hoy, y sería una decisión de una pantalla
-- metida en el esquema. Lo primero describe QUÉ ES, y de ahí se deduce todo lo
-- demás: que no se le llama, que su cartera no es de nadie, que su historial no
-- sirve para predecir nada. El día que haya que sacarlo también de cartera o de
-- reportes, la columna ya explica por qué.
--
-- ── El default es `false`, y eso importa ────────────────────────────────────
--
-- Marcar un cliente como tacho es una decisión rara y deliberada. Si el default
-- fuera `true` o la columna fuera nullable con semántica ambigua, un alta mal
-- hecha podría esconder a un cliente real de la lista de llamadas — que es
-- exactamente el fallo silencioso que Seguimientos existe para evitar.
--
-- Esta migración NO marca a nadie: el `UPDATE` sobre el tacho de producción lo
-- corre la operación a mano, porque su id es de esa base y de ninguna otra.
-- ============================================================================

ALTER TABLE "clientes"
  ADD COLUMN "es_mostrador" boolean NOT NULL DEFAULT false;

-- Un índice parcial y no uno común: las filas marcadas van a ser una o dos
-- sobre miles, y lo que la consulta pregunta es «cuáles hay», no «cuál es el
-- valor de cada una».
CREATE INDEX "clientes_es_mostrador_idx" ON "clientes" ("id") WHERE "es_mostrador";

COMMENT ON COLUMN "clientes"."es_mostrador" IS
  'Este cliente representa ventas a gente que no quiso registrarse. No es una persona: no se le llama, su cartera no le pertenece a nadie y su historial no predice nada. Ver RN-CLI-21.';

-- ── El tacho de producción, marcado acá y no a mano ─────────────────────────
--
-- El id es de la base de producción y de ninguna otra: en desarrollo, en la de
-- tests y en la de Bruno este `UPDATE` afecta CERO filas y no falla. Eso es
-- justamente lo que lo hace seguro de versionar.
--
-- Va acá y no en una instrucción para que alguien la corra a mano porque un
-- paso manual se olvida, se tipea mal, y seis meses después nadie puede decir
-- por qué esa fila está marcada. Acá queda el qué, el cuándo y el porqué en el
-- mismo lugar.
UPDATE "clientes"
  SET "es_mostrador" = true
  WHERE "id" = 'ba8681c9-a6f9-4704-82fe-02afe9bb9eec';
