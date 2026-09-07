-- ============================================================================
-- M12 · Alertas — los umbrales dejan de estar cableados
-- ============================================================================
--
-- RN-STK-11 lo pide explícitamente: «tiene que poder ajustarse desde la
-- administración sin tocar código». Hoy vive en dos constantes:
--
--   DIAS_DE_AVISO_DE_VENCIMIENTO = 7   web/src/components/ui/estado.tsx
--   DIAS_DE_ENTREGA = 7                api/src/modules/retornables/bases.ts
--
-- Un umbral que avisa tarde no sirve; uno que avisa demasiado pronto entrena a
-- ignorar el aviso, que es peor. El número correcto depende de la rotación real
-- y esa todavía no se midió — así que moverlo no puede exigir un despliegue.
--
-- ── Por qué NO hay una columna «actualizado_por» ───────────────────────────
--
-- El primer diseño la tenía, con su FK a `users`. Dos problemas:
--
--   1. Duplica lo que `audit_log` ya guarda —quién, cuándo, de cuánto a cuánto—
--      y ese es el registro autoritativo (ADR-0004).
--   2. La FK hace que un `TRUNCATE users CASCADE` se lleve la configuración
--      entera. Lo descubrieron los tests.
--
-- «Quién movió este umbral» se responde en la bitácora, que además dice de qué
-- valor a cuál. Acá alcanza con cuándo.
--
-- ── Por qué los límites viven en la tabla y no en el formulario ─────────────
--
-- Un umbral en 0 apaga la alerta sin decirlo, y uno en 9999 la deja siempre
-- encendida: las dos formas de romperla se ven igual desde afuera —nadie
-- reacciona— y ninguna avisa. Es una invariante, y las invariantes viven en la
-- base (ADR-0006).

CREATE TABLE "parametros" (
  "clave" text PRIMARY KEY,
  "valor" integer NOT NULL,
  "minimo" integer NOT NULL,
  "maximo" integer NOT NULL,
  -- La etiqueta y la ayuda viajan con el dato para que la pantalla no las
  -- copie: un parámetro nuevo aparece en la administración sin tocar `web`.
  "etiqueta" text NOT NULL,
  "ayuda" text NOT NULL,
  "unidad" text NOT NULL,
  "actualizado_en" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "parametros_valor_en_rango" CHECK ("valor" BETWEEN "minimo" AND "maximo"),
  CONSTRAINT "parametros_rango_util" CHECK ("minimo" < "maximo"),
  CONSTRAINT "parametros_minimo_positivo" CHECK ("minimo" >= 1)
);
--> statement-breakpoint

-- ============================================================================
-- Los valores iniciales
-- ============================================================================
--
-- Van en la MIGRACIÓN y no en el seed: el código los lee sin alternativa, así
-- que tienen que existir siempre. RN-STK-11 dice que la constante «se va», no
-- que quede como default — que es como nacen los dos lugares donde configurar
-- lo mismo, y como se descubre meses después que discrepan.

INSERT INTO "parametros" ("clave", "valor", "minimo", "maximo", "etiqueta", "ayuda", "unidad") VALUES
  (
    'dias_aviso_vencimiento', 7, 1, 30,
    'Aviso de vencimiento',
    'Con cuántos días de anticipación se marca un lote como «vence pronto». La vida útil son 30 días, así que 7 deja una cuarta parte para reaccionar.',
    'días'
  ),
  (
    'dias_entrega_bases', 7, 1, 90,
    'Demora del proveedor de bases',
    'Cuánto tarda el proveedor en entregar bases nuevas. Con esto se calcula cuándo hay que comprar antes de quedarse sin.',
    'días'
  );
--> statement-breakpoint

-- La aplicación lee y actualiza. NO borra: un parámetro que desaparece deja al
-- código sin valor y sin manera de saber cuál era.
GRANT SELECT, UPDATE ON "parametros" TO aquazaku_app;
--> statement-breakpoint

-- Cambiar un umbral es una decisión, no un dato: la clave nunca cambia, y una
-- fila nueva solo puede nacer de una migración.
REVOKE INSERT, DELETE ON "parametros" FROM aquazaku_app;
