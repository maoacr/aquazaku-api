-- ============================================================================
-- El nombre del cliente, partido — M15
-- ============================================================================
--
-- Salió de la primera demo. El registro pedía UN campo «nombre» y ahí entraba
-- todo: «Rosa Elena Padilla Gómez», «rosa padilla», «Doña Rosa», «Rosa (la de
-- la esquina)». Cuatro formas de escribir a la misma persona, y ninguna se
-- puede ordenar por apellido ni buscar por él.
--
-- ── Por qué `nombre` pasa a ser GENERADO y no calculado en el servicio ──────
--
-- Porque el invariante es que **el nombre que se muestra siempre concuerde con
-- sus partes**. Si lo compusiera el servicio, un `UPDATE` a mano —una
-- corrección, una migración de datos, un script— podría dejar `nombre` diciendo
-- «Rosa Padilla» mientras `apellidos` dice «Gómez». Y eso no falla: se ve bien
-- en un lado y mal en el otro, y nadie sabe cuál creer.
--
-- ADR-0006: el invariante vive en la base; el servicio explica.
--
-- ── Y por qué sigue existiendo un nombre libre ─────────────────────────────
--
-- Porque «Panadería del Centro» no tiene primer nombre ni apellidos. Un negocio
-- tiene razón social, no nombre de pila. Obligarlo a llenar «apellidos» sería
-- inventar un dato.
--
-- Así que hay dos caminos hacia el mismo `nombre`, y la base acepta los dos:
-- las partes, o el nombre libre. Lo que NO acepta es que no haya ninguno.

-- ── 1 · Lo que había pasa a ser el nombre libre ────────────────────────────
--
-- Ni una fila cambia de valor: al no tener partes, la expresión generada cae en
-- el `coalesce` y devuelve exactamente lo que ya decía.

ALTER TABLE "clientes" RENAME COLUMN "nombre" TO "nombre_libre";
--> statement-breakpoint

ALTER TABLE "clientes" ALTER COLUMN "nombre_libre" DROP NOT NULL;
--> statement-breakpoint

-- ── 2 · Las partes ─────────────────────────────────────────────────────────
--
-- Los nombres colombianos son «primer nombre + segundo nombre + dos apellidos».
-- El segundo nombre falta seguido y no pasa nada; los apellidos van juntos en
-- un solo campo porque partirlos en paterno y materno obliga a decidir el orden
-- —que no siempre se sabe— y no habilita ninguna consulta que importe acá.
--
-- El apodo es el campo que pidió la planta, y no es folklore: en Campo de la
-- Cruz a la gente se la ubica por el apodo. Quien atiende el mostrador escucha
-- «vengo de parte de la Cuca» mucho antes que un apellido.

ALTER TABLE "clientes"
  ADD COLUMN "primer_nombre" text,
  ADD COLUMN "segundo_nombre" text,
  ADD COLUMN "apellidos" text,
  ADD COLUMN "apodo" text;
--> statement-breakpoint

-- ── 3 · El nombre que se muestra, derivado ─────────────────────────────────
--
-- `concat_ws` NO sirve acá: Postgres la considera no inmutable y rechaza la
-- columna con «generation expression is not immutable». Se comprobó. Los
-- operadores de texto sí son inmutables, y el `regexp_replace` colapsa el hueco
-- que deja un segundo nombre ausente.

ALTER TABLE "clientes"
  ADD COLUMN "nombre" text
  GENERATED ALWAYS AS (
    COALESCE(
      NULLIF(
        btrim(
          regexp_replace(
            COALESCE("primer_nombre", '') || ' ' ||
            COALESCE("segundo_nombre", '') || ' ' ||
            COALESCE("apellidos", ''),
            '\s+', ' ', 'g'
          )
        ),
        ''
      ),
      "nombre_libre"
    )
  ) STORED NOT NULL;
--> statement-breakpoint

-- ── 4 · Los invariantes ────────────────────────────────────────────────────
--
-- «Todo cliente tiene un nombre» NO lleva CHECK propio, y eso se comprobó
-- intentándolo: un CHECK `nombre_libre IS NOT NULL OR primer_nombre IS NOT
-- NULL` nunca llega a dispararse, porque el `NOT NULL` de la columna generada
-- muerde primero. Una restricción que no puede fallar es ruido.
--
-- El precio es que el error crudo dice «null value in column "nombre"», que no
-- le sirve a nadie. Eso lo cubre el servicio con su propio mensaje: la base
-- garantiza el invariante, el servicio explica qué hacer — ADR-0006.

-- Un apellido suelto no es un nombre, y un nombre de pila sin apellido tampoco
-- identifica a nadie en un pueblo donde hay cuatro Rosas. Van los dos o
-- ninguno.
ALTER TABLE "clientes"
  ADD CONSTRAINT "clientes_nombre_partido_completo" CHECK (
    ("primer_nombre" IS NULL) = ("apellidos" IS NULL)
  );
--> statement-breakpoint

-- No se puede tener segundo nombre sin tener primero. Es la clase de fila que
-- solo aparece por un bug de formulario, y después nadie entiende qué pasó.
ALTER TABLE "clientes"
  ADD CONSTRAINT "clientes_segundo_nombre_necesita_primero" CHECK (
    "segundo_nombre" IS NULL OR "primer_nombre" IS NOT NULL
  );
--> statement-breakpoint

-- Un cliente se nombra de UNA forma: partido, o libre. Nunca las dos.
--
-- Sin esto, editar «Panadería del Centro» para partirle el nombre dejaría la
-- razón social vieja colgando en `nombre_libre`: un dato que ya no se muestra
-- en ningún lado y que el próximo que lea la tabla va a creer vigente.
--
-- El `coalesce` de la columna generada ya prefiere las partes, así que el dato
-- muerto no rompería nada visible — y por eso mismo nadie lo encontraría.
ALTER TABLE "clientes"
  ADD CONSTRAINT "clientes_una_sola_forma_de_nombre" CHECK (
    NOT ("primer_nombre" IS NOT NULL AND "nombre_libre" IS NOT NULL)
  );
--> statement-breakpoint

-- Cadenas vacías disfrazadas de dato. Un formulario que manda `''` en vez de
-- omitir el campo produce «apellidos» vacíos que pasan todos los CHECK de
-- arriba y rompen el nombre generado.
ALTER TABLE "clientes"
  ADD CONSTRAINT "clientes_partes_sin_vacios" CHECK (
    ("nombre_libre"    IS NULL OR length(btrim("nombre_libre"))    > 0) AND
    ("primer_nombre"   IS NULL OR length(btrim("primer_nombre"))   > 0) AND
    ("segundo_nombre"  IS NULL OR length(btrim("segundo_nombre"))  > 0) AND
    ("apellidos"       IS NULL OR length(btrim("apellidos"))       > 0) AND
    ("apodo"           IS NULL OR length(btrim("apodo"))           > 0)
  );
--> statement-breakpoint

-- ── 5 · Buscar por apellido ────────────────────────────────────────────────
--
-- La búsqueda del mostrador es por documento (M15) porque eso es lo que se
-- dicta. Pero el apellido es como se busca cuando NO hay documento a mano, que
-- es justo el caso de RN-CLI-01: en venta a hogares muchas veces no lo hay.
CREATE INDEX "clientes_apellidos_idx" ON "clientes" (lower("apellidos"));
--> statement-breakpoint

CREATE INDEX "clientes_apodo_idx" ON "clientes" (lower("apodo"));
