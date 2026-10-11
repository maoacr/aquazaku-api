import { describe, expect, it } from 'vitest'
import { LARGO_MINIMO_MOTIVO } from '@/lib/motivos'
import { DIAS_MAXIMOS_HACIA_ATRAS } from '@/modules/ventas/venta'

/**
 * Las constantes que `web/` tiene copiadas — y el aviso cuando cambian.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────
 *
 * Dos números de negocio viven en los DOS repos con el mismo valor escrito a
 * mano. No es un descuido: `web/` los necesita para avisar qué falta **antes**
 * de mandar el formulario, los repos son independientes y no hay paquete común
 * que los ate. Quien decide sigue siendo `api/`.
 *
 * El problema de una copia no es tenerla: es que nadie se entera cuando una de
 * las dos cambia. Si acá sube el mínimo de motivo a 15 y en `web/` queda en 10,
 * la pantalla va a decir «ya alcanza» y el servidor va a devolver un 422 que
 * nadie entiende — y el que lo lee culpa al formulario, no al número.
 *
 * Este test hace que ese cambio se avise. Fija el valor, y si alguien lo mueve,
 * falla con el mensaje de qué tocar del otro lado.
 *
 * Es el mismo mecanismo que ya usa el cierre de producción: ver «El caso espejo
 * de la vista previa» en `modules/produccion/__tests__/routes.test.ts`, donde la
 * aritmética está repetida en `web/src/__tests__/produccion-vista-previa.test.ts`
 * y lo que los ata es que los dos tests usan los mismos valores.
 *
 * **Si tocás uno, tocá el otro.**
 */

describe('las constantes que `web/` espeja', () => {
  /**
   * Convención transversal (R2 del sistema de diseño): aplica a anulaciones,
   * devoluciones, daños, ajustes y diferencias de cierre.
   *
   * Copia en `web/`: `src/lib/motivos.ts`.
   */
  it('el mínimo de un motivo escrito a mano son 10 caracteres', () => {
    expect(
      LARGO_MINIMO_MOTIVO,
      'si cambiás esto, cambiá `LARGO_MINIMO_MOTIVO` en `web/src/lib/motivos.ts`: la pantalla avisa con ese número antes de mandar el formulario',
    ).toBe(10)
  })

  /**
   * RN-VEN-14. El tope de cuántos días hacia atrás se puede registrar una venta.
   *
   * Copia en `web/`: `src/components/ventas/mostrador.tsx`, que lo usa para
   * poner el `min` del campo de fecha.
   */
  it('una venta se puede registrar hasta 90 días hacia atrás', () => {
    expect(
      DIAS_MAXIMOS_HACIA_ATRAS,
      'si cambiás esto, cambiá `DIAS_MAXIMOS_HACIA_ATRAS` en `web/src/components/ventas/mostrador.tsx`: con un tope distinto el calendario deja elegir fechas que el servidor rechaza',
    ).toBe(90)
  })
})
