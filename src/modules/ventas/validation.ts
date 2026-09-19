import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas de ventas — M6.
 *
 * Validan **forma**, no reglas de negocio. Que el crédito exija verificación,
 * que un descuento no perfore el piso o que no se pueda cobrar de más lo decide
 * el servicio: una regla, un código de error, un lugar.
 */

/** Como `'10000'` o `'10000.50'`. La misma forma que usa el catálogo. */
const dinero = z.string().regex(/^\d+(\.\d{1,2})?$/, 'debe ser un monto como 10000 o 10000.50')

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como AAAA-MM-DD')

const motivo = z
  .string()
  .trim()
  .min(
    LARGO_MINIMO_MOTIVO,
    `necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: tiene que servir para entender el registro dentro de tres meses`,
  )

export const esquemaDeVenta = z.object({
  clienteId: z.string().uuid().optional(),
  medioDePago: z.enum(['efectivo', 'transferencia', 'credito']),
  canal: z.enum(['mostrador', 'whatsapp', 'ruta']).optional(),

  items: z
    .array(
      z.object({
        productoId: z.string().uuid(),
        cantidad: z.number().int().positive('una línea vende al menos una unidad'),

        /**
         * El precio que de verdad se cobró, escrito a mano — RN-VEN-15.
         *
         * Ausente es el caso normal: se cobra la lista del catálogo. Presente
         * significa que quien registra afirma haber cobrado OTRO número, y ese
         * número gana sobre la lista y sobre el piso de su línea.
         *
         * Usa el mismo `dinero` que el resto del sistema, y eso ya cierra la
         * puerta al negativo: `^\d+(\.\d{1,2})?$` no tiene signo. Que el
         * mostrador solo deje escribir pesos enteros es cosa de la pantalla —
         * ahí el riesgo es que alguien teclee «3.5» leyendo el «$10.000» de la
         * card y registre $3,50 sin enterarse.
         *
         * Un `'0'` se acepta. No es un descuido: bloquearlo sería teatro, porque
         * quien quisiera abusar escribe `'1'` y consigue lo mismo. Lo que acota
         * el riesgo es la fila de bitácora con el precio de lista al lado.
         */
        precioManual: dinero.optional(),
      }),
    )
    .min(1, 'una venta sin productos no es una venta'),

  codigoDescuento: z.string().trim().min(1).optional(),
  requiereFacturaElectronica: z.boolean().optional(),

  /**
   * Cuándo ocurrió la venta de verdad — RN-VEN-14.
   *
   * Opcional: ausente es hoy, que es el caso normal del mostrador. Se acepta
   * para las ventas que se cargan tarde, que hasta ahora entraban con la fecha
   * del día en que alguien se acordó — y ahí el reporte de agosto quedaba corto
   * y el de septiembre inflado.
   *
   * Va en `AAAA-MM-DD` como el resto de las fechas del sistema
   * (`vigenciaDesde`, `vigenciaHasta`): ordena bien y no es ambiguo. Lo que ve
   * quien la escribe es `DD-MM-AAAA`, que es cosa de la pantalla.
   *
   * Que no sea futura y que no pase de 90 días lo decide el servicio: son
   * reglas de negocio con su propio mensaje, no forma.
   */
  ocurrioEn: fecha.optional(),

  /*
   * Cuántos botellones salen SIN vacío de contrapartida — RN-ENV-03.
   *
   * El default es 0 porque la recarga normal es un intercambio: entra un vacío,
   * sale uno lleno, y el saldo del cliente no cambia. Que el caso común no
   * requiera escribir nada es lo que hace que este campo no estorbe.
   *
   * Que no pueda exceder los botellones vendidos, y que exija cliente, lo
   * decide el servicio: son reglas de negocio, no de forma.
   */
  botellonesSinVacio: z
    .number()
    .int()
    .nonnegative('los botellones que salen sin vacío no pueden ser negativos')
    .optional(),

  /*
   * Una base que sale con la venta — RN-BAS-03.
   *
   * El sticker es el número pegado en la base: en el mostrador nadie conoce el
   * UUID. La dirección va aparte porque la base se presta a una DIRECCIÓN, no a
   * un cliente — un comercial con tres locales tiene una en cada uno.
   *
   * Que la base exista, que no figure prestada en otro lado, que no esté dañada
   * y que el cliente esté verificado lo decide el servicio: son cuatro reglas
   * de negocio con su propio mensaje, y ya viven en `prestarBase`.
   */
  base: z
    .object({
      sticker: z.string().trim().min(1, 'falta el código de la base'),
      direccionId: z.string().uuid('esa dirección no es válida'),
    })
    .optional(),
})

/**
 * La anulación NO acepta un autor por parámetro.
 *
 * Quién anula sale de la sesión, y quién puede hacerlo lo decide el alcance de
 * la matriz sobre el autor original. Si el autor viniera en el cuerpo, cualquiera
 * podría afirmar ser quien registró la venta.
 */
export const esquemaDeAnulacion = z.object({ motivo })

/**
 * Corregir una venta registrada — RN-VEN-16.
 *
 * Es la venta ENTERA otra vez, no un parche de los campos que cambiaron. No es
 * comodidad: un `PATCH` con `{ cantidad: 5 }` obliga a fusionar lo nuevo con lo
 * viejo para saber qué venta queda, y esa fusión es la edición que RN-VEN-02
 * prohíbe, escrita en el servidor en vez de en la base.
 *
 * Mandando la venta completa, lo que llega es lo que se registra: pasa por el
 * mismo `registrarVentaEn` que el mostrador, con las mismas validaciones de
 * stock, piso, crédito y vigencia. No hay un segundo camino con sus propias
 * reglas.
 *
 * ── `ocurrioEn` opcional, dentro del piso de RN-VEN-14 ──────────────────────
 *
 * Por **default** la corrección hereda el instante exacto de la venta que
 * reemplaza: omitirlo es la regla normal, y no esquiva nada.
 *
 * Cuando viene, es porque la venta se cargó con la fecha equivocada en primer
 * lugar y la corrección es la única oportunidad de encuadrar la plata en el día
 * real del hecho. No es un permiso nuevo: pasa por el mismo piso de 90 días y
 * el mismo rechazo de futuro que
 * [RN-VEN-14](#rn-ven-14--una-venta-se-registra-con-la-fecha-del-día-en-que-ocurrió)
 * le pone a una venta nueva. La validación corre del lado del servicio —
 * `exigirFechaRegistrable` — antes de abrir la transacción, así un 422
 * corto-circuita sin tocar la fila vieja.
 */
export const esquemaDeCorreccion = esquemaDeVenta
  .omit({ ocurrioEn: true })
  .extend({
    motivo,
    /**
     * Override de la fecha del hecho — RN-VEN-14 + RN-VEN-16.
     *
     * Opcional: ausente hereda el instante exacto. Presente y válido le gana
     * a la herencia; presente e inválido cae con 422 desde `exigirFechaRegistrable`.
     */
    ocurrioEn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como AAAA-MM-DD')
      .optional(),
  })
  /*
   * ── `.strict()` porque `.omit()` DESCARTA, no rechaza ─────────────────────
   *
   * Un `z.object` en modo `strip` —el default— saca las claves que no conoce y
   * sigue. Sin `.strict()`, un cuerpo con cualquier clave extra devolvía 201 y
   * se ignoraba en silencio: quien la mandó se queda creyendo que pidió algo.
   *
   * Con `.strict()` el 400 dice qué clave sobra. Esa puerta queda porque
   * `ocurrioEn` ya está manejada por el `.extend` de arriba.
   */
  .strict()

export const esquemaDeCobro = z.object({
  clienteId: z.string().uuid(),
  monto: dinero,
  /** `credito` no está: pagar una deuda con deuda no la reduce. */
  medioDePago: z.enum(['efectivo', 'transferencia']),
  observaciones: z.string().trim().optional(),
})

export const esquemaDeDevolucion = z.object({
  lineaId: z.string().uuid(),
  cantidad: z.number().int().positive(),
  estadoProducto: z.enum(['sano', 'danado', 'vencido']),
  motivo,
})

export const esquemaDeCodigo = z
  .object({
    codigo: z.string().trim().min(1, 'el código necesita un nombre'),
    tipo: z.enum(['porcentaje', 'monto_fijo']),
    valor: dinero,
    vigenciaDesde: fecha,
    vigenciaHasta: fecha,
    /** `null` es ilimitado, y es el default. */
    usosMaximos: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => d.vigenciaHasta >= d.vigenciaDesde, {
    message: 'la fecha de fin es anterior a la de inicio',
    path: ['vigenciaHasta'],
  })
