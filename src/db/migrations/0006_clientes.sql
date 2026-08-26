CREATE TYPE "tipo_cliente" AS ENUM('residencial', 'comercial');--> statement-breakpoint
CREATE TYPE "tipo_documento" AS ENUM('CC', 'NIT');--> statement-breakpoint
CREATE TYPE "verificacion_estado" AS ENUM('pendiente', 'verificado');--> statement-breakpoint
CREATE TYPE "verificacion_metodo" AS ENUM('seller_manual', 'pos_manual', 'admin_oficial');--> statement-breakpoint

CREATE TABLE "clientes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nombre" text NOT NULL,
  "tipo" "tipo_cliente" DEFAULT 'residencial' NOT NULL,
  "tipo_documento" "tipo_documento" NOT NULL,
  "numero_documento" text NOT NULL,
  "verificacion_estado" "verificacion_estado" DEFAULT 'pendiente' NOT NULL,
  "verificado_por" uuid,
  "verificado_en" timestamp with time zone,
  "verificacion_metodo" "verificacion_metodo",
  "credito_habilitado" boolean DEFAULT false NOT NULL,
  "credito_limite" numeric(12, 2),
  "activo" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- RN-CLI-15. Va en la base y no solo en el servicio porque cubre los DOS
  -- caminos: habilitar credito sin verificar, y desverificar a alguien que ya
  -- lo tiene. Un guard en "habilitar" solo atrapa el primero.
  CONSTRAINT "clientes_credito_exige_verificacion"
    CHECK (NOT "credito_habilitado" OR "verificacion_estado" = 'verificado'),

  -- Los cuatro campos van juntos o los cuatro nulos. Media verificacion no
  -- significa nada, y quien la lea despues no sabria si fue un bug o un dato.
  CONSTRAINT "clientes_verificacion_completa"
    CHECK (
      ("verificacion_estado" = 'pendiente'
        AND "verificado_por" IS NULL
        AND "verificado_en" IS NULL
        AND "verificacion_metodo" IS NULL)
      OR
      ("verificacion_estado" = 'verificado'
        AND "verificado_en" IS NOT NULL
        AND "verificacion_metodo" IS NOT NULL)
    ),

  CONSTRAINT "clientes_limite_positivo"
    CHECK ("credito_limite" IS NULL OR "credito_limite" > 0)
);--> statement-breakpoint

CREATE TABLE "direcciones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cliente_id" uuid NOT NULL,
  "etiqueta" text NOT NULL,
  "direccion" text NOT NULL,
  "indicaciones" text,
  "activa" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "clientes" ADD CONSTRAINT "clientes_verificado_por_users_id_fk"
  FOREIGN KEY ("verificado_por") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint

-- `restrict` y no `cascade`: borrar un cliente con direcciones tendria que ser
-- imposible, no silencioso. De todos modos el DELETE sobre clientes esta
-- revocado mas abajo — esto es el cinturon del tirante.
ALTER TABLE "direcciones" ADD CONSTRAINT "direcciones_cliente_id_clientes_id_fk"
  FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE restrict;--> statement-breakpoint

-- RN-CLI-08. Sobre el PAR y no sobre el numero: el NIT de una persona natural
-- se basa en su cedula, asi que `CC 79123456` y `NIT 79123456` son la misma
-- persona escrita de dos formas y prohibir ese cruce haria imposible un caso
-- legitimo. El duplicado REAL —mismo tipo, mismo numero— sigue sin poder entrar.
CREATE UNIQUE INDEX "clientes_documento_idx"
  ON "clientes" USING btree ("tipo_documento", "numero_documento");--> statement-breakpoint
CREATE INDEX "clientes_activo_idx" ON "clientes" USING btree ("activo");--> statement-breakpoint
CREATE INDEX "direcciones_cliente_idx" ON "direcciones" USING btree ("cliente_id");--> statement-breakpoint

-- ============================================================================
-- Permisos
--
-- RECORDATORIO: la migración 0001 dejó un ALTER DEFAULT PRIVILEGES que concede
-- SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Las dos tablas de
-- acá YA NACIERON con esos cuatro privilegios. Lo que no deban tener hay que
-- REVOCARLO, no omitirlo. Ver ADR-0006.
-- ============================================================================

-- `clientes` CONSERVA el UPDATE: un cliente se edita —cambia de tipo, se
-- verifica, se le habilita credito—. Pierde el DELETE: RN-CLI-02 dice que no se
-- borra, se desactiva. Borrarlo dejaria ventas y botellones apuntando a un
-- cliente inexistente, y la deuda sin dueno.
REVOKE DELETE ON clientes FROM aquazaku_app;
--> statement-breakpoint

-- Lo mismo con las direcciones: una base prestada se asigna a una direccion
-- concreta (RN-CLI-07). Borrarla dejaria el prestamo sin lugar a donde ir a
-- buscarlo, que es exactamente lo que esa regla viene a evitar.
REVOKE DELETE ON direcciones FROM aquazaku_app;
