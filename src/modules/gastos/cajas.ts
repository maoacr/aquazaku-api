/**
 * Las dos cajas que el sistema tiene siempre — M17.
 *
 * ── Por qué vive en su propio archivo ───────────────────────────────────────
 *
 * Esto NO es parte del servicio de cuentas: es la **copia verificada de la
 * semilla** que escribe la migración 0030. La migración es la autoridad; esto
 * existe porque los tests truncan las tablas y necesitan reponerlas, y porque
 * `invariantes.test.ts` comprueba que la base tenga exactamente estas dos.
 *
 * Separarlo de `cuentas.ts` tiene una razón concreta: `src/test/db.ts` lo
 * importa, y `db.ts` lo usa TODA la suite. Con la constante adentro del
 * servicio, cualquier recorte del módulo que no incluya `cuentas.ts` deja la
 * suite entera sin compilar — pasó al partir el trabajo en PRs encadenados: el
 * primero traía el esquema y la semilla, pero no el servicio, y `db.ts` apuntaba
 * a un archivo que todavía no existía.
 *
 * Es la misma forma que `PARAMETROS_INICIALES` de alertas: el valor inicial
 * vive aparte de quien lo opera.
 */
export const CAJAS_INICIALES = [
  { nombre: 'Caja menor', tipo: 'caja_menor' },
  { nombre: 'Caja mayor', tipo: 'caja_mayor' },
] as const
