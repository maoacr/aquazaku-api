import { z } from 'zod'

/**
 * Esquemas de proveedores y compras — M9.
 *
 * Validan **forma**. Que la fecha de vencimiento acompañe al crédito, que una
 * línea compre exactamente una cosa y que un proveedor desactivado no reciba
 * compras lo decide el servicio: una regla, un código de error, un lugar.
 */

const dinero = z.string().regex(/^\d+(\.\d{1,2})?$/, 'debe ser un monto como 80000 o 80000.50')

export const esquemaDeProveedor = z.object({
  nombre: z.string().trim().min(1, 'un proveedor sin nombre no se puede identificar'),
  /*
   * Opcionales a propósito: un proveedor puede ser el señor que trae las tapas
   * en su camioneta. Exigirle NIT llevaría a inventar uno.
   */
  nit: z.string().trim().optional(),
  contacto: z.string().trim().optional(),
})

export const esquemaDeEstado = z.object({ activo: z.boolean() })

const lineaDeCompra = z
  .object({
    insumoId: z.string().uuid().optional(),
    botellones: z.number().int().positive().optional(),
    bases: z.number().int().positive().optional(),

    /** Lo RECIBIDO, no lo pedido — RN-PRO-03. */
    cantidad: z.number().positive('una línea recibe al menos algo'),
    /** Solo para insumos que se compran al peso — RN-INS-02. */
    kilos: z.number().positive().optional(),

    costoUnitario: dinero,
  })
  /*
   * La forma se puede validar acá: exactamente uno de los tres. El servicio lo
   * vuelve a comprobar porque también se lo llama desde adentro, y una regla que
   * solo vive en la validación HTTP no protege esos caminos.
   */
  .refine(
    (l) => [l.insumoId, l.botellones, l.bases].filter((x) => x !== undefined).length === 1,
    'cada línea compra exactamente una cosa: un insumo, botellones o bases',
  )
  .refine(
    (l) => l.kilos === undefined || l.insumoId !== undefined,
    'los kilos son solo para insumos: los botellones y las bases se cuentan por unidad',
  )

export const esquemaDeCompra = z.object({
  proveedorId: z.string().uuid(),
  medioDePago: z.enum(['efectivo', 'transferencia', 'credito']),

  /**
   * Obligatoria a crédito y prohibida si no — RN-PRO-07.
   *
   * Las dos mitades las verifica el servicio, donde el mensaje puede explicar
   * por qué. Acá solo se valida que sea una fecha.
   */
  venceEl: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va como 2026-09-30')
    .optional(),

  lineas: z.array(lineaDeCompra).min(1, 'una compra sin líneas no es una compra'),
})
