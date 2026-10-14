-- ============================================================================
-- Dos tipos de base: `estructura` y `dispensador` — RN-BAS-14
-- ============================================================================
--
-- Aquazaku compró un segundo tipo de base: el dispensador de agua fría y
-- caliente. Hasta hoy existía uno solo, la estructura metálica, y por eso
-- RN-BAS-09 decía «una sola clase de base, sin SKU» — queda derogada.
--
-- ── Sin DEFAULT, y es la decisión que más importa ───────────────────────────
--
-- La columna es NOT NULL y **no tiene valor por omisión**. Un
-- `DEFAULT 'estructura'` convertiría en estructura toda base mal registrada, y
-- el tipo acompaña a la base hasta su descarte: el error quedaría escrito para
-- siempre y solo se descubriría yendo a mirar el objeto físico.
--
-- Sin default, el INSERT que no declara el tipo **falla**. Eso es lo que obliga
-- a los tres caminos de alta a pedirlo, y lo que hace que un camino olvidado se
-- caiga en los tests en vez de producir filas calladas.
--
-- ── El backfill no es un supuesto ───────────────────────────────────────────
--
-- Las bases que ya existen quedan `estructura`. Es un hecho histórico, no una
-- elección: cuando se registraron, el dispensador no existía como producto de
-- Aquazaku. Si alguna fuera dispensador, la fila habría sido imposible de
-- crear.
--
-- Va en tres pasos —agregar nullable, rellenar, exigir NOT NULL— porque una
-- columna NOT NULL sin default sobre una tabla con filas se rechaza de entrada.
-- El orden importa: entre el paso 2 y el 3 no hay ventana para un INSERT sin
-- tipo, porque los tres suceden en la misma transacción de la migración.
--
-- ── El espacio de IDs NO se parte ───────────────────────────────────────────
--
-- Esta migración **no toca `id_sticker` ni su índice único**. El consecutivo
-- sigue saliendo del máximo de todas las bases sin importar el tipo, y
-- `bases_sticker_idx` sigue siendo único entre todas: no hay dos listas
-- arrancando en 0001.
--
-- Fue un pedido explícito de Aquazaku, y además es lo correcto: el número
-- identifica, el tipo describe. Un rango reservado —los dispensadores del 9000
-- en adelante— sería un segundo lugar donde vive el tipo, y el día que
-- discrepara con esta columna nadie sabría cuál manda.
--
-- ── Medido ──────────────────────────────────────────────────────────────────
--
-- En `aquazaku_dev` el backfill toca las bases de semilla que haya; todas pasan
-- a `estructura`. El conteo exacto depende de la semilla y no se afirma acá: lo
-- verifica `0027-tipo-de-base.test.ts`, que comprueba que después de la
-- migración NO queda ninguna fila con tipo nulo.
--
-- Rollback:
--
--   ALTER TABLE bases DROP COLUMN tipo;
--   DROP TYPE tipo_de_base;
--
-- Revertir pierde el dato: qué bases eran dispensadores. Es irrecuperable desde
-- otra tabla —el tipo no se deriva de nada— así que antes de revertir conviene
-- guardarse `SELECT id_sticker, tipo FROM bases`.
-- ============================================================================

CREATE TYPE tipo_de_base AS ENUM ('estructura', 'dispensador');--> statement-breakpoint

ALTER TABLE bases ADD COLUMN tipo tipo_de_base;--> statement-breakpoint

UPDATE bases SET tipo = 'estructura' WHERE tipo IS NULL;--> statement-breakpoint

ALTER TABLE bases ALTER COLUMN tipo SET NOT NULL;
