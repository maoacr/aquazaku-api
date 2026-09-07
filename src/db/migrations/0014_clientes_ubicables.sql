-- ============================================================================
-- Direcciones estructuradas y teléfonos — M14
-- ============================================================================
--
-- Salió de la primera demo con el cliente. Dos huecos que el sistema tenía y
-- nadie había mirado de frente:
--
--   1. La dirección era UN campo de texto. Sin estructura no hay ruta, sin
--      municipio no se distingue «Calle 5 # 3-24» de Campo de la Cruz de la de
--      Suan, y sin coordenadas M8 (rutas) no se puede construir.
--
--   2. No había NINGÚN dato de contacto. Se construyó la cartera por edad para
--      saber a quién llamar primero, y no había a qué número llamar.
--
-- ── Ningún campo es obligatorio, y eso es una decisión ─────────────────────
--
-- Aquazaku reparte en Campo de la Cruz y en pueblos vecinos. La nomenclatura
-- `CL 45 A # 12 B - 34` es urbana: en un municipio pequeño hay direcciones que
-- son «Vereda La Peña, casa de tabla azul» y no se dejan descomponer.
--
-- Un formulario que exige la estructura bloquea el registro de un cliente REAL,
-- y el operador termina inventando `CL 1 # 1-1` para poder guardar. Ahí se
-- perdió el dato y además se ensució la base.

ALTER TABLE "direcciones"
  -- La vía: CL 45 A
  ADD COLUMN "via_tipo" text,
  ADD COLUMN "via_numero" text,
  ADD COLUMN "via_letra" text,
  -- La placa: # 12 B - 34 C
  ADD COLUMN "placa_numero" text,
  ADD COLUMN "placa_letra" text,
  ADD COLUMN "placa_segundo" text,
  ADD COLUMN "placa_letra_final" text,
  -- «Apto 302», «Torre B», «local 4»
  ADD COLUMN "complemento" text,
  -- Sin esto, la misma dirección en dos pueblos se ve idéntica.
  ADD COLUMN "municipio" text,
  -- Campo de la Cruz está cerca del límite con Bolívar y Magdalena: un
  -- municipio vecino puede ser de otro departamento, y ahí el dato distingue.
  ADD COLUMN "departamento" text,
  -- El pin que alguien arrastró en el mapa. Es lo único que M8 puede usar para
  -- ordenar un recorrido: geocodificar una dirección de municipio pequeño en
  -- Colombia no funciona, y una ruta calculada sobre una posición inventada es
  -- peor que ninguna.
  ADD COLUMN "latitud" numeric(9, 6),
  ADD COLUMN "longitud" numeric(9, 6);
--> statement-breakpoint

-- La línea libre deja de ser obligatoria: ahora es una más de las formas de
-- decir dónde queda, no LA forma.
ALTER TABLE "direcciones" ALTER COLUMN "direccion" DROP NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- La invariante: una dirección tiene que poder ubicarse por ALGO
-- ============================================================================
--
-- Si ningún campo es obligatorio por separado, nada impide guardar una fila
-- entera en blanco: una dirección a la que no se le puede entregar nada, que
-- ocupa lugar en la lista y que alguien va a tratar de usar.
--
-- La regla no es «tal campo es obligatorio». Es que el conjunto diga algo.

ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_ubicable" CHECK (
    "via_tipo" IS NOT NULL
    OR "via_numero" IS NOT NULL
    OR "placa_numero" IS NOT NULL
    OR "direccion" IS NOT NULL
    OR "indicaciones" IS NOT NULL
    OR "latitud" IS NOT NULL
  );
--> statement-breakpoint

-- Las coordenadas van de a dos o no van: media coordenada no ubica nada.
ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_coordenada_completa" CHECK (
    ("latitud" IS NULL) = ("longitud" IS NULL)
  );
--> statement-breakpoint

-- Rangos reales del planeta. Un dedazo en el formulario que mande el pin al
-- océano Índico se ve igual que una dirección buena hasta que alguien maneja.
ALTER TABLE "direcciones"
  ADD CONSTRAINT "direcciones_coordenada_valida" CHECK (
    "latitud" IS NULL
    OR ("latitud" BETWEEN -90 AND 90 AND "longitud" BETWEEN -180 AND 180)
  );
--> statement-breakpoint

-- ============================================================================
-- Teléfonos — uno o varios por cliente
-- ============================================================================
--
-- Tabla aparte y no una columna, por lo mismo que `direcciones`: un cliente
-- comercial tiene el celular del dueño y el fijo del local, y en una casa el
-- número puede ser el del vecino. Cuál es cuál lo dice la etiqueta.

CREATE TABLE "telefonos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cliente_id" uuid NOT NULL REFERENCES "clientes"("id") ON DELETE RESTRICT,
  "numero" text NOT NULL,
  -- «celular del dueño», «el local», «la señora del frente»
  "etiqueta" text,
  "activo" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "telefonos_numero_no_vacio" CHECK (length(btrim("numero")) >= 7)
);
--> statement-breakpoint

CREATE INDEX "telefonos_cliente_idx" ON "telefonos" ("cliente_id");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "telefonos" TO aquazaku_app;
--> statement-breakpoint

-- Un teléfono no se borra: se desactiva. El historial de a quién se llamó y
-- cuándo pierde sentido si el número desaparece de la base.
REVOKE DELETE ON "telefonos" FROM aquazaku_app;
