-- ============================================================================
-- Un cliente se registra solo con el nombre — RN-CLI-20
-- ============================================================================
--
-- ── El problema que esto viene a resolver ───────────────────────────────────
--
-- El documento era obligatorio (RN-CLI-13), y en el mostrador mucha gente no
-- lo quiere dar. La salida que encontró la planta fue crear un cliente llamado
-- «POS Aquazaku» y colgarle TODAS esas ventas.
--
-- Eso no es un cliente: es un tacho. Adentro conviven cientos de personas
-- distintas, así que su cartera no le pertenece a nadie, su historial no dice
-- nada, y el panel de «clientes para llamar» lo ve como una sola persona que
-- compra todos los días — es decir, nunca lo muestra.
--
-- Registrar a alguien con el nombre y el teléfono que sí quiso dar es
-- estrictamente mejor que eso, incluso sin documento: al menos hay a quién
-- llamar y un historial que es de esa persona.
--
-- ── Lo que se pierde, y se pierde a sabiendas ──────────────────────────────
--
-- Sin documento no hay identificador estable. Dos «Juan Pérez» sin documento
-- son indistinguibles para el sistema, y el aviso de duplicado que hoy frena
-- el alta se queda sin ancla.
--
-- La alternativa era seguir empujando a esa gente al tacho, donde TAMBIÉN son
-- indistinguibles y además pierden nombre, teléfono e historial. Se cambia un
-- dato ausente por un dato ausente y tres datos presentes.
--
-- El nombre sigue siendo obligatorio: `clientes.nombre` es una columna
-- generada `NOT NULL` que sale de las partes o de `nombre_libre`. Un cliente
-- sin nombre no es un cliente — es una fila.

ALTER TABLE "clientes" ALTER COLUMN "tipo_documento" DROP NOT NULL;
ALTER TABLE "clientes" ALTER COLUMN "numero_documento" DROP NOT NULL;

-- Los dos viajan juntos o no viaja ninguno. Un número sin tipo no se puede
-- leer —79123456 es una cédula o un NIT, y no son lo mismo (RN-CLI-08)— y un
-- tipo sin número no identifica nada.
--
-- El índice único `clientes_documento_idx` sigue en pie sobre el par. Postgres
-- trata los NULL como distintos entre sí, así que muchos clientes sin
-- documento conviven sin chocar, y dos con el MISMO documento siguen siendo
-- imposibles.
ALTER TABLE "clientes"
  ADD CONSTRAINT "clientes_documento_completo"
  CHECK (("tipo_documento" IS NULL) = ("numero_documento" IS NULL));

-- ── Verificar exige que haya algo que verificar ─────────────────────────────
--
-- Verificar significa que alguien tuvo el documento A LA VISTA y lo afirma con
-- su nombre (RN-CLI-14). Sobre un cliente sin documento cargado eso no es una
-- afirmación floja: es una afirmación sobre nada, y arrastra el crédito —que
-- exige verificación (RN-CLI-15)—.
--
-- Se valida entera porque hoy no hay ninguna fila que la viole: hasta esta
-- migración el documento era obligatorio.
ALTER TABLE "clientes"
  ADD CONSTRAINT "clientes_verificar_exige_documento"
  CHECK ("verificacion_estado" = 'pendiente' OR "numero_documento" IS NOT NULL);

-- ============================================================================
-- La dirección en la venta, ahora condicionada — RN-VEN-18 corregida
-- ============================================================================
--
-- `0022` exigía dirección en TODA venta con cliente. Con clientes que se
-- registran solo con nombre eso traba el mostrador justo en el caso que esta
-- migración viene a habilitar: sin dirección cargada, no se les puede vender.
--
-- La regla correcta es más angosta y dice lo mismo donde importa:
--
--   **si el cliente TIENE direcciones, hay que decir a cuál se entrega.**
--
-- Quien tiene tres locales sigue sin poder registrar una venta sin decir a
-- cuál va —que era todo el punto— y quien no tiene ninguna no queda bloqueado.
-- El día que le carguen una dirección, la regla empieza a aplicarle sola.
ALTER TABLE "ventas" DROP CONSTRAINT "ventas_con_cliente_exige_direccion";

-- Lo que sigue siendo imposible sin mirar otra tabla: una dirección sin
-- cliente. Una dirección cuelga de un cliente (RN-CLI-07), así que suelta en
-- una venta anónima es un dato que no le pertenece a nadie.
ALTER TABLE "ventas"
  ADD CONSTRAINT "ventas_direccion_exige_cliente"
  CHECK ("direccion_id" IS NULL OR "cliente_id" IS NOT NULL);

/*
 * ── Por qué un trigger y no un CHECK ────────────────────────────────────────
 *
 * «Tiene direcciones» vive en OTRA tabla, y un CHECK solo puede mirar su
 * propia fila. Es el mismo caso que `recompra_aviso_antes_que_urgente`, que
 * también cruza filas.
 *
 * Va como `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` a propósito:
 * el alta de un cliente puede insertar cliente, teléfono y dirección en la
 * MISMA transacción, y una venta cargada ahí adentro vería un estado a medio
 * armar. Diferido, se evalúa al cerrar — cuando la transacción ya dice la
 * verdad.
 *
 * Solo direcciones ACTIVAS: una dada de baja no es un destino al que se pueda
 * entregar, y exigir elegir entre ellas sería pedir que se despache a una
 * dirección que ya no existe.
 */
CREATE OR REPLACE FUNCTION venta_dice_a_donde_se_entrega() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."cliente_id" IS NULL OR NEW."direccion_id" IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- El recargo por base dañada no se entrega en ningún lado: es un cobro.
  IF NEW."tipo" = 'dano_base' THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "direcciones"
    WHERE "cliente_id" = NEW."cliente_id" AND "activa"
  ) THEN
    RAISE EXCEPTION
      'la venta % es de un cliente con direcciones cargadas y no dice a cuál se entrega',
      NEW."id"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ventas_direccion_cuando_el_cliente_tiene';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ventas_direccion_cuando_el_cliente_tiene"
  AFTER INSERT OR UPDATE OF "cliente_id", "direccion_id" ON "ventas"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION venta_dice_a_donde_se_entrega();
