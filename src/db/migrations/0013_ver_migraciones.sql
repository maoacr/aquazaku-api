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

GRANT USAGE ON SCHEMA "drizzle" TO aquazaku_app;
--> statement-breakpoint

GRANT SELECT ON "drizzle"."__drizzle_migrations" TO aquazaku_app;
