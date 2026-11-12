-- Gastos y tesorería — M17.
--
-- ── Lo que trae ─────────────────────────────────────────────────────────────
--
-- Dos tablas: las cuentas donde vive la plata, y EL LIBRO por el que pasa todo
-- peso que entra o sale. No hay una tabla de egresos: un gasto no tiene líneas
-- —si moviera inventario sería una compra, M9— así que una tabla aparte solo
-- agregaría una segunda copia del monto que habría que mantener de acuerdo con
-- la del libro.
--
-- ── Lo que NO trae, y por qué el doble conteo es imposible ──────────────────
--
-- `tipo_de_egreso` no tiene `insumo`, ni `base`, ni `botellon`. Esos tres ya
-- entran por una compra a proveedor, que escribe el documento y mueve el
-- inventario en la misma transacción. Si se pudieran registrar también como
-- egreso, el mes se contaría dos veces — y no por descuido: sería la forma
-- natural de hacerlo. Al no existir el valor, no hay dónde escribir el duplicado.
--
-- ── Lo que NO trae todavía ──────────────────────────────────────────────────
--
-- No hay tabla `arqueos` ni rutas de traslado: son el tramo 2. Pero los cuatro
-- valores del enum que van a usar (`traslado_*`, `*_de_arqueo`) se declaran
-- ACÁ, porque `efecto` es una columna GENERATED cuya expresión enumera los
-- tipos negativos, y agregarle un valor después obliga a reconstruir la columna
-- sobre una tabla con historia. Cuatro renglones hoy dejan el tramo 2 puramente
-- aditivo — el mismo argumento por el que `medio_de_pago` nació con `credito`.

CREATE TYPE "tipo_de_cuenta_de_dinero" AS ENUM ('caja_menor', 'caja_mayor', 'banco');--> statement-breakpoint
CREATE TYPE "tipo_de_cuenta_bancaria" AS ENUM ('ahorros', 'corriente');--> statement-breakpoint

-- El signo lo da el tipo, no una columna. Por eso un faltante de arqueo es un
-- tipo distinto de un sobrante, en vez de un `ajuste` con monto negativo: así
-- `efecto` se genera desde el tipo y es imposible que una fila diga «entra» y
-- reste.
CREATE TYPE "tipo_movimiento_dinero" AS ENUM (
  'saldo_inicial',
  'ingreso',
  'egreso',
  'traslado_salida',
  'traslado_entrada',
  'sobrante_de_arqueo',
  'faltante_de_arqueo'
);--> statement-breakpoint

-- Qué se pagó: un HECHO, no una clasificación contable. Estos valores contestan
-- «qué compré», que es lo que sabe quien registra. «Es costo, gasto o activo
-- fijo» lo contesta una contadora, cambia con el umbral de capitalización, y
-- grabarlo en un enum lo congelaría — vive en `clasificacion`, que nace NULL.
CREATE TYPE "tipo_de_egreso" AS ENUM (
  'recibo_publico',
  'arriendo',
  'nomina',
  'software',
  'servicio',
  'repuesto',
  'mantenimiento',
  'litografia',
  'impuesto',
  'equipo',
  'mueble',
  'transporte',
  -- Cuota de manejo, 4x1000, costo de transferencia. Tipo propio y no `otro`
  -- porque es la razón número uno por la que una cuenta bancaria no cuadra
  -- contra el extracto: son débitos que el banco hace solo y que nadie registra.
  'comision_bancaria',
  -- Queda para revisión del admin, igual que `causa_descarte.otro`. Existe
  -- porque la alternativa es peor: sin un lugar donde caiga lo que no encaja, el
  -- gasto no se registra, y entonces la caja deja de cuadrar contra la plata
  -- física. Un gasto mal clasificado se corrige; uno que falta no se descubre.
  'otro'
);--> statement-breakpoint

CREATE TYPE "tipo_de_ingreso" AS ENUM (
  'aporte_socio',
  'prestamo',
  -- El efectivo de las ventas cuando se mete a la caja. Es un registro de
  -- tesorería y NO toca M6: la venta ya quedó escrita cuando ocurrió, y esto
  -- dice en qué cuenta aterrizó la plata — un hecho distinto y posterior.
  'recaudo_de_ventas',
  'devolucion_de_proveedor',
  'otro'
);--> statement-breakpoint

CREATE TYPE "clasificacion_de_egreso" AS ENUM ('costo', 'gasto', 'activo_fijo');--> statement-breakpoint

CREATE TABLE "cuentas_de_dinero" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nombre" text NOT NULL,
  "tipo" "tipo_de_cuenta_de_dinero" NOT NULL,

  -- Los tres van juntos y solo en las bancarias.
  "banco" text,
  "numero" text,
  "tipo_de_cuenta_bancaria" "tipo_de_cuenta_bancaria",

  -- No se borra: se desactiva. Su historial de movimientos sigue apuntándole, y
  -- borrarla dejaría el libro sin explicar de dónde salió un peso.
  "activa" boolean DEFAULT true NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "cuentas_dinero_nombre_no_vacio" CHECK (length(btrim("nombre")) > 0),

  -- Los datos del banco viajan juntos, en los dos sentidos. Una cuenta bancaria
  -- sin número no se puede cotejar con el extracto; una caja con banco es un
  -- dato que miente sobre dónde está la plata.
  CONSTRAINT "cuentas_dinero_banco_con_sus_datos" CHECK (
    ("tipo" = 'banco') = ("banco" IS NOT NULL AND "numero" IS NOT NULL AND "tipo_de_cuenta_bancaria" IS NOT NULL)
  )
);--> statement-breakpoint

-- Una sola caja menor y una sola caja mayor activas. Dos cajas menores no son
-- dos cajas: son la misma registrada dos veces, y el efectivo queda partido
-- entre las dos sin que nadie sepa cuál mirar. Los bancos no tienen tope.
CREATE UNIQUE INDEX "cuentas_dinero_una_sola_caja_por_tipo" ON "cuentas_de_dinero" ("tipo")
  WHERE "tipo" IN ('caja_menor', 'caja_mayor') AND "activa";--> statement-breakpoint

-- Dos cuentas con el mismo nombre parten el historial entre las dos.
CREATE UNIQUE INDEX "cuentas_dinero_nombre_idx" ON "cuentas_de_dinero" (lower(btrim("nombre")))
  WHERE "activa";--> statement-breakpoint

CREATE TABLE "movimientos_de_dinero" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  "cuenta_id" uuid NOT NULL REFERENCES "cuentas_de_dinero"("id") ON DELETE restrict,

  "tipo" "tipo_movimiento_dinero" NOT NULL,

  -- Siempre POSITIVO. El signo lo pone `efecto` desde el tipo.
  "monto" numeric(12, 2) NOT NULL,

  -- Cuánto mueve el saldo, con signo. Es el mecanismo del ADR-0006 para que un
  -- derivado no pueda desincronizarse: el signo no se guarda, se deduce, y no
  -- hay forma de escribir una fila donde los dos se contradigan.
  --
  -- `anulado` entra en la expresión a propósito: anular pone el efecto en cero,
  -- así que el movimiento sale del saldo por aritmética. Nada que revertir, nada
  -- que recordar, nada que pueda quedar a medias.
  "efecto" numeric(12, 2) GENERATED ALWAYS AS (
    CASE
      WHEN "anulado" THEN 0
      WHEN "tipo" IN ('egreso', 'traslado_salida', 'faltante_de_arqueo') THEN -"monto"
      ELSE "monto"
    END
  ) STORED,

  -- Cuándo OCURRIÓ, que no es cuándo se registró. Un recibo se paga el martes y
  -- se carga el viernes. El reporte del mes y el arqueo se leen por esta fecha;
  -- `created_at` dice cuándo entró al sistema y sirve para auditar, no para contar.
  "ocurrido_el" date NOT NULL,

  "concepto" text NOT NULL,

  -- Contexto del egreso.
  "tipo_de_egreso" "tipo_de_egreso",
  "proveedor_id" uuid REFERENCES "proveedores"("id") ON DELETE restrict,
  "beneficiario" text,
  -- El NÚMERO de la factura, no un archivo: el sistema no guarda archivos
  -- todavía. El número es lo que sirve para cotejar contra el papel y para que
  -- no se pague dos veces el mismo recibo.
  "numero_de_factura" text,
  -- Nace NULL. Registrar el hueco es lo correcto: clasificar no depende de quien
  -- registra el gasto, y el hecho sí.
  "clasificacion" "clasificacion_de_egreso",

  -- Contexto del ingreso.
  "tipo_de_ingreso" "tipo_de_ingreso",

  -- Contexto del traslado. Lo escribe el tramo 2.
  "traslado_id" uuid,
  "cuenta_contraparte_id" uuid REFERENCES "cuentas_de_dinero"("id") ON DELETE restrict,

  -- No se edita: se anula con motivo.
  "anulado" boolean DEFAULT false NOT NULL,
  "motivo_anulacion" text,

  "registrado_por" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- Un movimiento de cero no es un movimiento. El signo lo da el tipo.
  CONSTRAINT "movimientos_dinero_monto_positivo" CHECK ("monto" > 0),
  CONSTRAINT "movimientos_dinero_concepto_no_vacio" CHECK (length(btrim("concepto")) > 0),

  -- Cada tipo trae su contexto y solo el suyo. Un ingreso con `tipo_de_egreso`
  -- se contaría como gasto en el reporte por tipo mientras suma al saldo: dos
  -- lecturas contradictorias de la misma fila.
  CONSTRAINT "movimientos_dinero_egreso_con_su_tipo"
    CHECK (("tipo" = 'egreso') = ("tipo_de_egreso" IS NOT NULL)),
  CONSTRAINT "movimientos_dinero_ingreso_con_su_tipo"
    CHECK (("tipo" = 'ingreso') = ("tipo_de_ingreso" IS NOT NULL)),
  CONSTRAINT "movimientos_dinero_datos_de_egreso_solo_en_egresos" CHECK (
    "tipo" = 'egreso' OR (
      "proveedor_id" IS NULL AND "numero_de_factura" IS NULL
      AND "clasificacion" IS NULL AND "beneficiario" IS NULL
    )
  ),

  -- Las dos mitades del traslado viajan juntas: sin `traslado_id` las patas no
  -- se pueden emparejar, y sin la contraparte la fila no dice de dónde vino.
  CONSTRAINT "movimientos_dinero_traslado_con_sus_dos_datos" CHECK (
    ("tipo" IN ('traslado_salida', 'traslado_entrada'))
      = ("traslado_id" IS NOT NULL AND "cuenta_contraparte_id" IS NOT NULL)
  ),
  -- Trasladar plata a la misma cuenta no la mueve: es una fila que miente.
  CONSTRAINT "movimientos_dinero_traslado_a_otra_cuenta"
    CHECK ("cuenta_contraparte_id" IS NULL OR "cuenta_contraparte_id" <> "cuenta_id"),

  CONSTRAINT "movimientos_dinero_anulacion_con_motivo"
    CHECK ("anulado" = ("motivo_anulacion" IS NOT NULL))
);--> statement-breakpoint

-- El saldo se calcula por cuenta: es la consulta más caliente del módulo.
CREATE INDEX "movimientos_dinero_por_cuenta_idx" ON "movimientos_de_dinero" ("cuenta_id");--> statement-breakpoint
-- La lista y el reporte del mes se leen por la fecha del hecho.
CREATE INDEX "movimientos_dinero_por_fecha_idx" ON "movimientos_de_dinero" ("ocurrido_el");--> statement-breakpoint
CREATE INDEX "movimientos_dinero_por_tipo_egreso_idx"
  ON "movimientos_de_dinero" ("tipo_de_egreso", "ocurrido_el")
  WHERE "tipo_de_egreso" IS NOT NULL;--> statement-breakpoint

-- Un solo saldo inicial por cuenta. Cargarlo dos veces no es un duplicado
-- inofensivo: es la plata del negocio contada dos veces, y el consolidado queda
-- inflado sin un solo movimiento falso que lo delate — las dos filas son
-- legítimas por separado.
--
-- `WHERE NOT anulado` y no un índice seco: si el saldo inicial se cargó mal, se
-- anula y se vuelve a cargar. Lo que no se puede es tener dos vigentes.
CREATE UNIQUE INDEX "movimientos_dinero_un_solo_saldo_inicial"
  ON "movimientos_de_dinero" ("cuenta_id")
  WHERE "tipo" = 'saldo_inicial' AND NOT "anulado";--> statement-breakpoint

-- Una sola pata por cuenta en cada traslado. Sin esto, un reintento podría
-- escribir dos salidas del mismo traslado y la plata se iría dos veces.
CREATE UNIQUE INDEX "movimientos_dinero_una_pata_por_cuenta"
  ON "movimientos_de_dinero" ("traslado_id", "cuenta_id")
  WHERE "traslado_id" IS NOT NULL;--> statement-breakpoint

-- ── Un movimiento de dinero no se edita — el mismo criterio que RN-VEN-02 ────
--
-- La fila dice que entró o salió plata de una cuenta. Corregirle el monto en
-- caliente reescribiría el saldo de un período ya cerrado y arqueado, y el
-- arqueo guardó el saldo del libro de ese día: la diferencia registrada ayer
-- dejaría de explicarse.
--
-- Se permite UNA transición: anularlo con motivo. Y una sola vez — anular lo ya
-- anulado sería cambiar el motivo de algo que ya está fuera del saldo.
CREATE OR REPLACE FUNCTION solo_anulacion_en_movimientos_de_dinero() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.anulado THEN
    RAISE EXCEPTION 'un movimiento anulado no se modifica';
  END IF;

  IF NEW.cuenta_id IS DISTINCT FROM OLD.cuenta_id
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.monto IS DISTINCT FROM OLD.monto
     OR NEW.ocurrido_el IS DISTINCT FROM OLD.ocurrido_el
     OR NEW.concepto IS DISTINCT FROM OLD.concepto
     OR NEW.tipo_de_egreso IS DISTINCT FROM OLD.tipo_de_egreso
     OR NEW.tipo_de_ingreso IS DISTINCT FROM OLD.tipo_de_ingreso
     OR NEW.proveedor_id IS DISTINCT FROM OLD.proveedor_id
     OR NEW.beneficiario IS DISTINCT FROM OLD.beneficiario
     OR NEW.numero_de_factura IS DISTINCT FROM OLD.numero_de_factura
     OR NEW.traslado_id IS DISTINCT FROM OLD.traslado_id
     OR NEW.cuenta_contraparte_id IS DISTINCT FROM OLD.cuenta_contraparte_id
     OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'un movimiento de dinero no se edita: solo se anula con motivo';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER movimientos_de_dinero_solo_anulacion
  BEFORE UPDATE ON "movimientos_de_dinero"
  FOR EACH ROW EXECUTE FUNCTION solo_anulacion_en_movimientos_de_dinero();--> statement-breakpoint

-- La otra mitad de la garantía: el trigger protege de un bug, esto de un `psql`.
-- Borrar un movimiento cambiaría el saldo sin dejar rastro, que es exactamente
-- el descuadre imposible de rastrear meses después.
--
-- `clasificacion` queda fuera de la lista congelada del trigger a propósito: es
-- el único campo que se llena DESPUÉS, el día que alguien clasifique el gasto.
REVOKE DELETE ON "movimientos_de_dinero" FROM aquazaku_app;--> statement-breakpoint
REVOKE DELETE ON "cuentas_de_dinero" FROM aquazaku_app;--> statement-breakpoint

-- ── Las dos cajas nacen con el sistema ──────────────────────────────────────
--
-- No se crean desde la pantalla porque no son una preferencia: el negocio tiene
-- una caja menor y una caja mayor, y un módulo de tesorería sin ellas no puede
-- registrar nada. Nacen en cero — el saldo inicial lo carga quien cuente la
-- plata, y queda como un movimiento con su fecha, no como un número inventado
-- en una migración.
INSERT INTO "cuentas_de_dinero" ("nombre", "tipo") VALUES
  ('Caja menor', 'caja_menor'),
  ('Caja mayor', 'caja_mayor');
