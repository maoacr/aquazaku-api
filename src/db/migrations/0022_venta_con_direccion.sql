-- ============================================================================
-- La venta se entrega en una dirección — RN-VEN-18
-- ============================================================================
--
-- Hasta hoy la dirección solo aparecía cuando la venta despachaba una BASE:
-- `base.direccionId` viajaba en el request porque una base se presta a una
-- dirección y no a un cliente (RN-BAS-03). Una venta de botellones sin base
-- no registraba dónde se entregaba.
--
-- El resultado es que el reparto no sale de la venta. Quien arma la ruta tiene
-- que abrir el cliente, mirar sus direcciones y adivinar a cuál iba ese pedido
-- — y un comercial con tres locales no tiene respuesta.
--
-- ── Por qué la columna es NULLABLE ──────────────────────────────────────────
--
-- Por la misma razón que `cliente_id` lo es: la venta de mostrador a alguien
-- que compra un botellón y se va no tiene cliente, y una dirección cuelga de
-- un cliente (RN-CLI-07). Sin cliente no hay dirección que asignar, y exigir
-- una obligaría a inventar un cliente — que es exactamente lo que el comentario
-- de `cliente_id` en el esquema viene evitando.
--
-- Lo que sí se exige es la COHERENCIA entre las dos, y de eso se encarga el
-- CHECK de más abajo.

ALTER TABLE "ventas"
  ADD COLUMN "direccion_id" uuid;

-- ── Que la dirección sea DE ESE cliente, y lo garantice la base ─────────────
--
-- Con dos claves foráneas sueltas —una a `clientes`, otra a `direcciones`— la
-- base aceptaría una venta a Rosa entregada en la casa de Pedro. Nada en el
-- esquema lo impediría, y el error solo se vería el día que el repartidor
-- golpea la puerta equivocada.
--
-- La clave foránea COMPUESTA lo vuelve imposible: el par (dirección, cliente)
-- de la venta tiene que existir tal cual en `direcciones`. No hace falta un
-- trigger ni una comprobación en el servicio — es el mismo criterio de
-- ADR-0006: el invariante vive en la base, el servicio lo explica.
--
-- Requiere que `direcciones` exponga ese par como único. `id` ya es la clave
-- primaria, así que la restricción no cambia qué filas son válidas: solo hace
-- el par referenciable.
ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_id_cliente_key" UNIQUE ("id", "cliente_id");

ALTER TABLE "ventas"
  ADD CONSTRAINT "ventas_direccion_del_cliente_fk"
  FOREIGN KEY ("direccion_id", "cliente_id")
  REFERENCES "direcciones" ("id", "cliente_id")
  ON DELETE RESTRICT;

-- ── Con cliente hay dirección; sin cliente, ninguna ─────────────────────────
--
-- El `MATCH SIMPLE` que Postgres usa por defecto NO comprueba una clave
-- foránea compuesta cuando alguna de sus columnas es NULL. Sin este CHECK, una
-- venta con cliente y sin dirección pasaría de largo sin que nada la mire, que
-- es justo el caso que esta migración viene a cerrar.
--
-- La igualdad cubre las dos direcciones a la vez:
--
--   · cliente sin dirección  → la venta no dice dónde se entrega
--   · dirección sin cliente  → una dirección que no es de nadie
--
-- ── `NOT VALID`, y no es pereza ─────────────────────────────────────────────
--
-- Las ventas que ya están registradas tienen cliente y no tienen dirección:
-- cuando se cargaron, la columna no existía. Con la restricción validada, esta
-- migración no correría.
--
-- La alternativa sería rellenarlas, y rellenar es INVENTAR: a un cliente con
-- una sola dirección se le podría poner esa, pero a uno con tres no hay forma
-- de saber a cuál fue ese pedido. Escribir una suposición en un registro
-- histórico lo vuelve indistinguible de un dato real.
--
-- `NOT VALID` dice la verdad: de acá en adelante se exige, y lo viejo queda
-- como está — visiblemente sin dirección, que es lo que efectivamente pasó.
-- La restricción se aplica a cada INSERT y UPDATE igual que cualquier otra.
--
-- ── El recargo por daño queda afuera, y no es una excepción de comodidad ────
--
-- `tipo = 'dano_base'` también vive en `ventas`, pero no es una entrega: es el
-- cobro de una base rota. Tiene cliente —hay a quién cobrarle— y no tiene a
-- dónde ir, porque no va a ningún lado.
--
-- Y muchas veces no PODRÍA tenerla: una base se puede romper estando en bodega,
-- ya devuelta, y entonces no hay ninguna dirección asociada. Exigírsela
-- obligaría a inventar uno.
--
-- La regla real es sobre lo que se ENTREGA. El recargo se exime de aportar
-- dirección, pero no de la otra punta: sin cliente tampoco puede tener una.
ALTER TABLE "ventas"
  ADD CONSTRAINT "ventas_con_cliente_exige_direccion"
  CHECK (
    ("cliente_id" IS NULL) = ("direccion_id" IS NULL)
    OR ("tipo" = 'dano_base' AND "direccion_id" IS NULL)
  )
  NOT VALID;

-- El reparto pregunta «qué se entrega en esta dirección», y sin índice eso es
-- un recorrido completo de la tabla de ventas.
CREATE INDEX "ventas_direccion_idx" ON "ventas" ("direccion_id")
  WHERE "direccion_id" IS NOT NULL;
