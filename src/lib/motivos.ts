/**
 * Largo mínimo de un motivo escrito a mano.
 *
 * Convención transversal del proyecto, no una regla del stock: aplica a
 * anulaciones, devoluciones, daños, ajustes y diferencias de cierre. Está en el
 * roadmap como convención y en `claude-design/reglas-como-tests.md` como R2.
 *
 * ── Por qué diez y no "no vacío" ────────────────────────────────────────────
 *
 * Un mínimo de un carácter acepta `.`, `x`, `ok`. Tres meses después, quien
 * investiga un descuadre encuentra "x" y el registro no sirve para nada — pero
 * el sistema hizo lo que le pidieron.
 *
 * Diez caracteres no garantizan una buena explicación, pero descartan el gesto
 * reflejo de llenar el campo para que la pantalla deje pasar.
 */
export const LARGO_MINIMO_MOTIVO = 10

export function motivoEsSuficiente(motivo: string | null | undefined): boolean {
  return (motivo?.trim().length ?? 0) >= LARGO_MINIMO_MOTIVO
}
