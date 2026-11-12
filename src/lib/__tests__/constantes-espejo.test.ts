import { describe, expect, it } from 'vitest'
import { tipoDeBaseEnum, tipoDeEgresoEnum, tipoDeIngresoEnum } from '@/db/schema'
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

  /**
   * RN-BAS-14. Los tipos de base que existen.
   *
   * No es un número, pero se rompe igual: `web/` los tiene copiados en el
   * desplegable con el que se registra una base, y el tipo **no tiene valor por
   * omisión** en ninguna capa. El día que Aquazaku compre un tercer tipo y acá
   * se agregue al enum, un `web/` que no lo ofrezca deja ese tipo imposible de
   * registrar desde la pantalla — y nadie se entera, porque no falla nada:
   * simplemente no está en la lista.
   *
   * Copia en `web/`: el tipo `TipoDeBase` de `src/lib/api-types.ts` y las
   * `<option>` de `src/components/retornables/bases.tsx`.
   */
  it('hay dos tipos de base: estructura y dispensador', () => {
    expect(
      tipoDeBaseEnum.enumValues,
      'si agregás un tipo de base, agregalo en `web/src/lib/api-types.ts` (`TipoDeBase`) y en el desplegable de `web/src/components/retornables/bases.tsx`: sin eso el tipo nuevo no se puede elegir desde la pantalla',
    ).toEqual(['estructura', 'dispensador'])
  })

  /**
   * RN-GAS-06. Los catorce tipos de gasto.
   *
   * Mismo modo de falla que los tipos de base, y peor consecuencia: el tipo de
   * gasto **no tiene valor por omisión**, así que un tipo que acá existe y en
   * `web/` no está en el desplegable queda imposible de registrar desde la
   * pantalla. Y no falla nada: simplemente no aparece, y el gasto se carga como
   * `otro` o no se carga — y entonces la caja deja de cuadrar contra la plata
   * física, que es lo único que el módulo vino a resolver.
   *
   * Al revés también rompe: un valor en `web/` que acá no exista viaja y vuelve
   * con un 422 de zod que habla de un enum, no de un gasto.
   *
   * Copia en `web/`: el tipo `TipoDeEgreso` de `src/lib/api-types.ts`, y las
   * tres constantes de `src/lib/gastos.ts` — `TIPOS_DE_EGRESO` (el orden del
   * desplegable), `ETIQUETA_DE_EGRESO` y `AYUDA_DE_EGRESO`. Las dos últimas son
   * `Record<TipoDeEgreso, string>`, así que a esas el compilador de `web/` ya
   * las obliga; la lista del desplegable no, y es la que se olvida.
   */
  it('hay catorce tipos de gasto, y ninguno mueve inventario', () => {
    expect(
      tipoDeEgresoEnum.enumValues,
      'si agregás un tipo de gasto, agregalo en `web/src/lib/api-types.ts` (`TipoDeEgreso`) y en `TIPOS_DE_EGRESO` de `web/src/lib/gastos.ts`: sin eso no se puede elegir desde la pantalla',
    ).toEqual([
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
    ])

    /*
     * ── La mitad que de verdad protege el dinero — RN-GAS-07 ───────────────
     *
     * `insumo`, `base` y `botellon` NO pueden estar. Esos tres entran por una
     * compra a proveedor (M9), que escribe el documento y mueve el inventario
     * en la misma transacción. El día que alguien agregue uno de esos valores
     * «para completar la lista», el mismo insumo se podría registrar por los
     * dos lados y el mes se contaría dos veces.
     *
     * No es una posibilidad remota: es lo que pasa si nadie lo impide, porque
     * registrar la factura del proveedor como gasto es lo intuitivo.
     */
    for (const prohibido of ['insumo', 'insumos', 'base', 'bases', 'botellon', 'botellones']) {
      expect(
        tipoDeEgresoEnum.enumValues,
        `«${prohibido}» no puede ser un tipo de gasto: eso entra por una compra a proveedor, que mueve el inventario. Con las dos vías abiertas, el mes se cuenta dos veces (RN-GAS-07)`,
      ).not.toContain(prohibido)
    }
  })

  /**
   * RN-GAS-10. De dónde puede venir la plata que entra.
   *
   * `recaudo_de_ventas` es el que importa: es cómo el efectivo de las ventas
   * aterriza en una caja **sin tocar M6**. Si se cae de la lista, no hay forma
   * de meter la plata del día a la caja y el módulo queda sin fondos.
   *
   * Copia en `web/`: `TipoDeIngreso` y `TIPOS_DE_INGRESO` / `ETIQUETA_DE_INGRESO`.
   */
  it('hay cinco orígenes de ingreso, con el recaudo de ventas entre ellos', () => {
    expect(
      tipoDeIngresoEnum.enumValues,
      'si agregás un origen de ingreso, agregalo en `web/src/lib/api-types.ts` (`TipoDeIngreso`) y en `TIPOS_DE_INGRESO` de `web/src/lib/gastos.ts`',
    ).toEqual([
      'aporte_socio',
      'prestamo',
      'recaudo_de_ventas',
      'devolucion_de_proveedor',
      'otro',
    ])
  })
})
