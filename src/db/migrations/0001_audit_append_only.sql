-- ============================================================================
-- audit_log inmutable — RN-ACC-04
--
-- Dos mecanismos independientes, porque ninguno alcanza solo:
--
--   1. Triggers que rechazan UPDATE y DELETE. Aplican a TODO el mundo, incluido
--      el dueño de la tabla. Pero el dueño puede desactivarlos.
--   2. El rol de la aplicación no es dueño y solo tiene SELECT e INSERT. No
--      puede borrar filas ni desactivar el trigger. Pero por sí solo no frena a
--      quien se conecte con el rol dueño.
--
-- Juntos cubren el hueco del otro: para adulterar la bitácora hay que tener las
-- credenciales del rol dueño Y ejecutar un ALTER TABLE explícito. Nada de eso
-- puede pasar por accidente ni por una inyección en el código de la API.
-- ============================================================================

CREATE OR REPLACE FUNCTION reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only: % rechazado', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Los triggers son STATEMENT-level y no ROW-level a propósito: así un
-- `DELETE FROM audit_log` sin WHERE (que no matchea ninguna fila y por lo tanto
-- nunca dispararía un trigger FOR EACH ROW) también falla ruidosamente.
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

-- TRUNCATE no dispara triggers de UPDATE/DELETE: necesita el suyo.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

-- ============================================================================
-- Permisos del rol de aplicación
--
-- El rol lo crea el provisionamiento del entorno, no esta migración: es un
-- objeto de cluster, no de base. Ver /empezar/entorno-local/.
-- ============================================================================

GRANT USAGE ON SCHEMA public TO aquazaku_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, accounts, verifications, roles, user_roles
  TO aquazaku_app;
--> statement-breakpoint

-- audit_log: se escribe y se lee. NUNCA se modifica ni se borra.
GRANT SELECT, INSERT ON audit_log TO aquazaku_app;
--> statement-breakpoint

-- Necesario para que el bigserial de audit_log pueda avanzar al insertar.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aquazaku_app;
--> statement-breakpoint

-- Las tablas de los módulos siguientes (M1+) heredan estos permisos solas, para
-- que nadie tenga que acordarse de correr un GRANT después de cada migración.
-- audit_log queda excluida porque ya existe y este default no la toca.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aquazaku_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aquazaku_app;
