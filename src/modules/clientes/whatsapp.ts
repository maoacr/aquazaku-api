/**
 * El número listo para `wa.me`, o `null` si ese teléfono no tiene WhatsApp.
 *
 * ── Por qué esto vive en `api` y no en `web` ────────────────────────────────
 *
 * Mismo argumento que `direccionLegible`: si cada pantalla compusiera el
 * enlace, en tres meses habría tres reglas para decidir qué es un celular, y
 * dos de ellas estarían mal. Viaja armado con el teléfono.
 *
 * ── Por qué devuelve `null` y no el número igual ────────────────────────────
 *
 * `wa.me/576058781234` —un fijo— abre WhatsApp y contesta que ese número no
 * existe. Quien atiende lee eso como «el sistema está roto», y después
 * desconfía del botón también donde sí funciona. Un botón que a veces lleva a
 * una pared es peor que no tener botón: obliga a comprobar cada vez.
 *
 * Devolver `null` deja que la pantalla decida no dibujarlo, que es la única
 * respuesta honesta cuando no hay a dónde ir.
 *
 * ── Cómo se distingue, después de 2022 ──────────────────────────────────────
 *
 * Colombia renumeró: los fijos pasaron a diez dígitos empezando por `60`, la
 * misma longitud que un celular. **Ya no se distinguen por largo, solo por el
 * primer dígito** — celular empieza con `3`.
 *
 * Los números se guardan como texto libre —la base solo les hace `trim`— así
 * que acá entra lo que una persona escribió en el mostrador.
 */

/** El indicativo de Colombia. Viaja en el enlace, no se guarda en la base. */
const COLOMBIA = '57'

/** Diez dígitos que empiezan con 3: la forma de un celular colombiano. */
const CELULAR = /^3\d{9}$/

export function numeroParaWhatsapp(numero: string): string | null {
  const digitos = numero.replace(/\D/g, '')

  /*
   * El indicativo se quita solo si el resto queda con forma de celular. Así
   * `573001234567` (12) se reconoce y `5555123456` —que empieza con 55 y no es
   * Colombia— no se muerde por delante para forzarlo a entrar.
   */
  const sinIndicativo =
    digitos.startsWith(COLOMBIA) && CELULAR.test(digitos.slice(COLOMBIA.length))
      ? digitos.slice(COLOMBIA.length)
      : digitos

  /*
   * NO se toman «los últimos diez dígitos». Es la tentación obvia y convierte
   * un número de México en uno colombiano que le pertenece a otra persona: el
   * mensaje sale, y llega a quien no era.
   */
  if (!CELULAR.test(sinIndicativo)) return null

  return `${COLOMBIA}${sinIndicativo}`
}
