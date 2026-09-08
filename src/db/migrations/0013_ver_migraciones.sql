-- ============================================================================
-- Que la aplicación sepa si le falta una migración
-- ============================================================================
--
-- El 7-sep-2026 se desplegó código que leía una tabla que la migración todavía
-- no había creado. Nada lo impidió: el servidor arrancó sano, el healthcheck dio
-- verde, y los dos módulos afectados fallaron recién cuando alguien los abrió
-- —en una demo con el cliente—.
--
-- El proceso no puede aplicar migraciones (no es dueño de nada, a propósito),
-- pero sí puede DARSE CUENTA. Para eso necesita leer el registro que lleva
-- Drizzle, que vive en su propio esquema.
--
-- Es solo lectura sobre una tabla de hashes y fechas: no hay nada que proteger
-- ahí, y sí mucho que ganar en que el sistema pueda decir «me falta la 0012».

-- ============================================================================
-- Schema-agnostic desde 8-sep-2026: los GRANTs apuntan al journal del schema
-- activo, no al de `public`.
-- ============================================================================
--
-- Dónde vive el journal depende de con qué `--schema` se haya corrido
-- `db:migrate` (ver `drizzle/migrate.ts`):
--
--   * `public` (default): `drizzle.__drizzle_migrations` — la convención
--     histórica de Drizzle cuando no se le pasa `migrationsSchema`.
--   * Cualquier otro schema (`preview`, `preview_test`, etc.):
--     `<schema>.__drizzle_migrations_<schema>`. Así un `DROP SCHEMA preview
--     CASCADE` se lleva el journal también, y dos ambientes no comparten
--     registro.
--
-- El DO block elige uno u otro leyendo `current_schema()`, que devuelve el
-- primer schema del `search_path` activo. En `public` el runner no toca el
-- path; en cualquier otro lo setea a `<schema>, public` antes de empezar.
--
-- Antes este archivo tenía `GRANT ... ON "drizzle"."__drizzle_migrations"`,
-- que rompía en `preview` porque `drizzle.__drizzle_migrations` no existía
-- ahí: el migrador fallaba con `relation does not exist`. Modificar el
-- contenido cambia el hash en `drizzle.__drizzle_migrations` y Drizzle
-- rechaza re-aplicarla si el hash no coincide; el `UPDATE` de una sola fila
-- que el runbook de despliegue tiene que correr manualmente va en la
-- descripción del PR que introdujo este cambio.
DO $$
DECLARE
  v_schema text := current_schema();
  v_journal_schema text;
  v_journal_table text;
BEGIN
  IF v_schema = 'public' THEN
    v_journal_schema := 'drizzle';
    v_journal_table  := '__drizzle_migrations';
  ELSE
    v_journal_schema := v_schema;
    v_journal_table  := '__drizzle_migrations_' || v_schema;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO aquazaku_app', v_journal_schema);
  EXECUTE format('GRANT SELECT ON %I.%I TO aquazaku_app', v_journal_schema, v_journal_table);
END $$;
