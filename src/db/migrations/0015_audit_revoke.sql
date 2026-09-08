-- ============================================================================
-- audit_log: REVOKE explícito para que la inmutabilidad no dependa solo del
-- trigger. Defensa en profundidad — si alguien desactiva el trigger, los
-- GRANTs siguen protegiendo.
--
-- Por qué existe este archivo separado y no una línea en `0001_audit_append_only.sql`:
-- modificar esa migration cambiaría su hash en `drizzle.__drizzle_migrations`
-- y los deploys ya aplicados en `public` abortarían al re-migrar (Drizzle
-- detecta el cambio y rechaza la migración). El REVOKE acá es idempotente:
-- en un ambiente donde los GRANTs ya están bien, Postgres lo trata como no-op.
--
-- El REVOKE va SIN calificador de schema — la misma forma que usan 0002, 0003,
-- 0004, 0005, 0007, 0009, etc. Resuelve al `audit_log` del schema activo del
-- runner de migraciones: `public` por default, `preview` cuando se invoca
-- `db:migrate --schema=preview` (que setea `search_path = preview,public`).
-- ============================================================================

REVOKE UPDATE, DELETE ON audit_log FROM aquazaku_app;
