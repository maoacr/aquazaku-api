-- ============================================================================
-- Los clientes a llamar — M15
-- ============================================================================
--
-- El botellón de 20 L de una casa dura alrededor de una semana. Pasada esa
-- semana el cliente no «está por pedir»: ya se le acabó, y o llama a otra
-- planta o se aguanta. En los dos casos Aquazaku se enteró tarde.
--
-- El dato para verlo venir ya existe —la fecha de la última venta— y no se
-- estaba mirando. Esto no agrega información: agrega la pregunta.
--
-- ── Dos umbrales, porque son dos conversaciones ──────────────────────────────
--
-- A los cinco días la llamada es una oferta: «¿le mandamos uno?». A los ocho es
-- una recuperación: ya compró en otro lado o está sin agua. Quien atiende el
-- teléfono no las hace igual, y una lista sola no deja priorizar.
--
-- Los valores son un SUPUESTO —pregunta 48 al dueño— y por eso son parámetros
-- y no constantes. El día que la operación diga otros números, se cambian desde
-- la pantalla de administración.

INSERT INTO "parametros" ("clave", "valor", "minimo", "maximo", "etiqueta", "ayuda", "unidad") VALUES
  (
    'dias_recompra_aviso', 5, 1, 60,
    'Aviso de recompra',
    'A partir de cuántos días sin comprar un cliente aparece en «para llamar». Un botellón de casa dura alrededor de una semana, así que 5 da margen para ofrecer antes de que se acabe.',
    'días'
  ),
  (
    'dias_recompra_urgente', 8, 1, 90,
    'Recompra urgente',
    'A partir de cuántos días sin comprar la llamada deja de ser una oferta y pasa a ser una recuperación: a esa altura el cliente ya compró en otro lado o está sin agua.',
    'días'
  );
--> statement-breakpoint

-- ============================================================================
-- El aviso va ANTES que lo urgente, y la base lo sostiene
-- ============================================================================
--
-- Con `aviso >= urgente` la franja «bajo» queda vacía y el panel miente sin
-- romperse: muestra a todo el mundo como urgente, o a nadie. Un error de
-- configuración que se ve como un sistema que dejó de avisar.
--
-- No se puede expresar con un CHECK: la regla cruza DOS filas de una tabla
-- clave-valor, y un CHECK solo ve la suya. De ahí el trigger.
--
-- Y va en la base, no solo en el servicio, por lo que dice ADR-0006: un `psql`
-- a las once de la noche no pasa por el servicio. La app solo tiene UPDATE
-- sobre esta tabla, así que este trigger es la única barrera que cubre los dos
-- caminos.
CREATE OR REPLACE FUNCTION recompra_aviso_antes_que_urgente() RETURNS TRIGGER AS $$
DECLARE
  aviso integer;
  urgente integer;
BEGIN
  IF NEW.clave NOT IN ('dias_recompra_aviso', 'dias_recompra_urgente') THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(MAX(CASE WHEN clave = 'dias_recompra_aviso' THEN valor END), NEW.valor),
    COALESCE(MAX(CASE WHEN clave = 'dias_recompra_urgente' THEN valor END), NEW.valor)
  INTO aviso, urgente
  FROM "parametros"
  WHERE clave IN ('dias_recompra_aviso', 'dias_recompra_urgente')
    AND clave <> NEW.clave;

  IF NEW.clave = 'dias_recompra_aviso' THEN
    aviso := NEW.valor;
  ELSE
    urgente := NEW.valor;
  END IF;

  IF aviso >= urgente THEN
    RAISE EXCEPTION
      'el aviso de recompra (%) tiene que ser MENOR que el urgente (%): si no, no queda ninguna franja «por llamar» y el panel solo muestra urgencias',
      aviso, urgente;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER parametros_recompra_ordenados
  BEFORE UPDATE ON "parametros"
  FOR EACH ROW EXECUTE FUNCTION recompra_aviso_antes_que_urgente();--> statement-breakpoint

-- ============================================================================
-- El índice que hace barata la pregunta
-- ============================================================================
--
-- «La última venta de cada cliente» recorre `ventas` agrupando por cliente. Sin
-- índice es un scan completo cada vez que alguien abre el panel — y el panel se
-- abre todo el día.
--
-- Parcial, porque la pregunta solo mira ventas CONFIRMADAS de producto con
-- cliente: una anulada no es una compra, y una venta de mostrador sin cliente
-- no tiene a quién llamar.
CREATE INDEX "ventas_ultima_por_cliente_idx"
  ON "ventas" ("cliente_id", "created_at" DESC)
  WHERE "cliente_id" IS NOT NULL
    AND "estado" = 'confirmada'
    AND "tipo" = 'producto';
