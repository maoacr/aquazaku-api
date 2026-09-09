-- ============================================================================
-- Que la aplicación sepa si le falta una migración — schema-agnostic
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
--
-- Schema-agnostic: en `public`, el journal vive en `drizzle.__drizzle_migrations`.
-- En cualquier otro schema (`preview`, tests, etc.) vive en
-- `<schema>.__drizzle_migrations_<schema>`. Detectamos con `current_schema()`.
--
-- Defensivo: si la tabla del journal NO existe todavía (porque Drizzle aún
-- no corrió su `migrate()` contra este schema), no hacemos nada. El GRANT
-- se aplica automáticamente la próxima vez que Drizzle cree el journal y
-- vuelva a correr este mismo bloque. Idempotente.
-- ============================================================================

DO $$
DECLARE
  v_schema text := current_schema();
  v_journal_schema text;
  v_journal_table text;
BEGIN
  IF v_schema = 'public' THEN
    v_journal_schema := 'drizzle';
    v_journal_table := '__drizzle_migrations';
  ELSE
    v_journal_schema := v_schema;
    v_journal_table := '__drizzle_migrations_' || v_schema;
  END IF;

  -- Si la tabla del journal no existe todavía, no aplicamos el GRANT.
  -- Se aplicará solo cuando Drizzle haya corrido su migrate() y la haya creado.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = v_journal_schema
      AND table_name = v_journal_table
  ) THEN
    RAISE NOTICE '0013: journal table %.% no existe todavía, GRANT diferido',
      v_journal_schema, v_journal_table;
    RETURN;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO aquazaku_app', v_journal_schema);
  EXECUTE format('GRANT SELECT ON %I.%I TO aquazaku_app', v_journal_schema, v_journal_table);
END $$;
