import { z } from 'zod'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'

/**
 * Esquemas de gastos y tesorería — M16.
 *
 * Validan **forma**. Que la cuenta exista y esté activa, que el saldo alcance,
 * que el saldo inicial no se cargue dos veces y que la fecha no sea futura lo
 * decide el servicio: una regla, un código de error, un lugar.
 */

const dinero = z.string().regex(/^\d+(\.\d{1,2})?$/, 'debe ser un monto como 80000 o 80000.50')

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como 2026-11-12')

/**
 * El concepto no es decorativo: es lo único que se lee en la lista.
 *
 * Un mínimo de 3 y no de 1 porque «x» no explica nada, y el día que haya que
 * conciliar el mes la fila tiene que decir qué fue sin abrir el papel.
 */
const concepto = z
  .string()
  .trim()
  .min(3, 'el concepto dice qué fue el movimiento: es lo que se lee en la lista')

export const TIPOS_DE_EGRESO = [
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
  'comision_bancaria',
  'otro',
] as const

export const TIPOS_DE_INGRESO = [
  'aporte_socio',
  'prestamo',
  'recaudo_de_ventas',
  'devolucion_de_proveedor',
  'otro',
] as const

export const esquemaDeEgreso = z.object({
  cuentaId: z.string().uuid(),
  tipoDeEgreso: z.enum(TIPOS_DE_EGRESO),
  monto: dinero,
  ocurridoEl: fecha,
  concepto,
  /*
   * Los tres opcionales. Exigir proveedor llevaría a dar de alta «EPM» como
   * proveedor para pagar la luz, y exigir factura dejaría sin registrar el
   * gasto que no la tiene — que es exactamente cuando la caja descuadra.
   */
  proveedorId: z.string().uuid().optional(),
  beneficiario: z.string().trim().min(1).optional(),
  numeroDeFactura: z.string().trim().min(1).optional(),
})

export const esquemaDeIngreso = z.object({
  cuentaId: z.string().uuid(),
  tipoDeIngreso: z.enum(TIPOS_DE_INGRESO),
  monto: dinero,
  ocurridoEl: fecha,
  concepto,
})

export const esquemaDeSaldoInicial = z.object({
  cuentaId: z.string().uuid(),
  monto: dinero,
  ocurridoEl: fecha,
  concepto,
})

export const esquemaDeCuentaBancaria = z.object({
  nombre: z.string().trim().min(1, 'una cuenta sin nombre no se puede elegir en un desplegable'),
  banco: z.string().trim().min(1, 'de qué banco es la cuenta'),
  /*
   * Obligatorio: es lo que permite cotejar contra el extracto que manda el
   * banco. Una cuenta bancaria sin número no se puede conciliar, y conciliar es
   * para lo único que existe registrarla.
   */
  numero: z.string().trim().min(1, 'el número es con lo que se coteja contra el extracto'),
  tipoDeCuentaBancaria: z.enum(['ahorros', 'corriente']),
})

export const esquemaDeEstadoDeCuenta = z.object({ activa: z.boolean() })

export const esquemaDeAnulacion = z.object({
  motivo: z
    .string()
    .trim()
    .min(
      LARGO_MINIMO_MOTIVO,
      `el motivo es lo que va a explicar el descuadre dentro de tres meses: al menos ${LARGO_MINIMO_MOTIVO} caracteres`,
    ),
})
