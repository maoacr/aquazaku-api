import type { Cliente } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { aCentavos } from './precio'

/**
 * El chequeo compuesto de RN-VEN-05.
 *
 * ```
 * credito.habilitado
 *   AND verificacion.estado == 'verificado'
 *   AND (limite == null OR deuda + venta <= limite)
 * ```
 *
 * ── Las tres condiciones, y por qué ninguna sobra ───────────────────────────
 *
 * Las dos primeras ya las sostiene un `CHECK` en `clientes` desde M5 — crédito
 * no puede estar habilitado sin verificación. Chequearlas igual acá no es
 * redundancia: es que el mensaje diga **cuál** falta. Un rechazo que solo dice
 * «no se puede» manda a alguien a adivinar.
 *
 * La tercera solo aplica si hay tope. `null` es «sin tope» y es el default
 * (RN-CLI-12): si nadie decidió un número, el sistema no tiene con qué
 * bloquear, y **eso es una respuesta, no un hueco**.
 */
export function exigirCreditoValido(
  cliente: Cliente,
  deudaActual: string,
  montoDeLaVenta: string,
): void {
  if (!cliente.creditoHabilitado) {
    throw new ErrorDeNegocio(
      'SIN_CREDITO',
      422,
      `${cliente.nombre} no tiene crédito habilitado. Se puede cobrar de contado, o habilitárselo desde su ficha`,
    )
  }

  if (cliente.verificacionEstado !== 'verificado') {
    /*
     * Este caso no debería poder existir: el `CHECK` de M5 impide habilitar
     * crédito sin verificación, y también desverificar con crédito puesto.
     *
     * Se chequea igual porque el día que ese CHECK se afloje —o alguien cargue
     * datos por consola— el sistema tiene que fallar acá y no descubrirse
     * fiándole a una identidad sin comprobar.
     */
    throw new ErrorDeNegocio(
      'VERIFICACION_REQUERIDA',
      422,
      `el documento de ${cliente.nombre} no está verificado, así que su crédito no se puede usar`,
    )
  }

  if (cliente.creditoLimite === null) return

  const tope = aCentavos(cliente.creditoLimite)
  const quedaria = aCentavos(deudaActual) + aCentavos(montoDeLaVenta)

  if (quedaria > tope) {
    const exceso = (quedaria - tope) / 100

    throw new ErrorDeNegocio(
      'LIMITE_SUPERADO',
      422,
      `esta venta dejaría a ${cliente.nombre} en $${(quedaria / 100).toLocaleString('es-CO')} y su tope es $${Number(cliente.creditoLimite).toLocaleString('es-CO')}: se pasa por $${exceso.toLocaleString('es-CO')}. Se puede cobrar de contado, o registrar un cobro antes`,
    )
  }
}
