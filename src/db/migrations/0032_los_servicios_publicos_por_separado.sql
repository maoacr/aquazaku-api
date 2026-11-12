-- Luz, agua, gas e internet dejan de ser «recibo público» — RN-GAS-06.
--
-- ── El defecto ──────────────────────────────────────────────────────────────
--
-- `recibo_publico` era el único valor del enum que agrupaba cosas distintas.
-- El resto nombra UN hecho —arriendo, nómina, transporte— y ese agrupaba
-- cuatro: cuatro empresas, cuatro facturas, cuatro ritmos. Con un solo valor,
-- la pregunta que de verdad se hace —«¿cuánto se me va en luz?»— no se podía
-- contestar: el reporte por tipo devolvía un total y nada más.
--
-- Lo encontró Aquazaku abriendo el modal, no un test: eligió «Recibo público» y
-- no tuvo dónde decir cuál.
--
-- `internet` sale de `software`, donde estaba por descarte. Hosting y licencias
-- se contratan y se dan de baja; el internet de la planta es un servicio fijo
-- del local, y se compara con la luz y el agua, no con una suscripción.
--
-- ── Por qué se RECREA el tipo en vez de agregar valores ─────────────────────
--
-- `ALTER TYPE … ADD VALUE` dejaría `recibo_publico` adentro para siempre: un
-- valor que nadie debe elegir pero que cualquier `INSERT` acepta. Recrear el
-- tipo lo saca de verdad, y se puede hacer porque el módulo todavía no está en
-- producción: lo único que se remapea son datos de prueba.

ALTER TYPE "tipo_de_egreso" RENAME TO "tipo_de_egreso_viejo";--> statement-breakpoint

CREATE TYPE "tipo_de_egreso" AS ENUM (
  -- Servicios públicos, uno por empresa que factura.
  'energia',
  'acueducto',
  'gas',
  'internet',
  -- Lo fijo del mes.
  'arriendo',
  'nomina',
  -- La operación.
  'transporte',
  'servicio',
  'mantenimiento',
  'repuesto',
  -- Administración.
  'software',
  'litografia',
  'impuesto',
  'comision_bancaria',
  -- Lo que se compra y lo que no encaja.
  'equipo',
  'mueble',
  'otro'
);--> statement-breakpoint

-- Lo viejo cae en `energia`: es el recibo que más se registra y el de mayor
-- monto. Son datos de prueba, así que no se está reinterpretando historia real.
ALTER TABLE "movimientos_de_dinero"
  ALTER COLUMN "tipo_de_egreso" TYPE "tipo_de_egreso"
  USING (
    CASE "tipo_de_egreso"::text
      WHEN 'recibo_publico' THEN 'energia'
      ELSE "tipo_de_egreso"::text
    END
  )::"tipo_de_egreso";--> statement-breakpoint

DROP TYPE "tipo_de_egreso_viejo";
