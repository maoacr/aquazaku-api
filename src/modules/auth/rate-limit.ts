/**
 * Límite de intentos, en memoria.
 *
 * En memoria por decisión explícita del spec (§16, pregunta 5): con un solo
 * servidor alcanza. Cuando haya varias instancias hará falta Redis, y el día
 * que eso pase el contador por proceso deja de servir — está anotado ahí y no
 * es un descuido.
 *
 * Es un límite **de seguridad**, no de capacidad: existe para que probar
 * contraseñas a mano sea inviable, no para proteger la CPU.
 */

interface Registro {
  intentos: number
  venceEn: number
}

const registros = new Map<string, Registro>()

export interface OpcionesDeLimite {
  /** Intentos permitidos dentro de la ventana. */
  max: number
  /** Duración de la ventana, en milisegundos. */
  ventanaMs: number
}

/** Login: 5 intentos fallidos por IP+email cada 15 minutos (spec §5). */
export const LIMITE_LOGIN: OpcionesDeLimite = { max: 5, ventanaMs: 15 * 60 * 1000 }

/**
 * Recuperación de contraseña: 3 pedidos cada 15 minutos.
 *
 * Acá el riesgo no es adivinar una contraseña sino usar el sistema para
 * bombardear de correos a una casilla ajena. Sin límite, cualquiera con el
 * email de otra persona puede mandarle cien mensajes.
 */
export const LIMITE_RESET: OpcionesDeLimite = { max: 3, ventanaMs: 15 * 60 * 1000 }

export interface ResultadoDeLimite {
  permitido: boolean
  /** Segundos que faltan para que se libere. Solo tiene sentido si `permitido` es false. */
  reintentarEn: number
}

/**
 * Registra un intento y dice si se puede seguir.
 *
 * Cuenta **todos** los intentos, no solo los fallidos. Contar solo los fallidos
 * deja abierta la puerta a alternar contraseñas correctas de una cuenta propia
 * para resetear el contador de otra.
 */
export function registrarIntento(clave: string, opciones: OpcionesDeLimite): ResultadoDeLimite {
  const ahora = Date.now()
  const registro = registros.get(clave)

  if (!registro || registro.venceEn <= ahora) {
    registros.set(clave, { intentos: 1, venceEn: ahora + opciones.ventanaMs })
    return { permitido: true, reintentarEn: 0 }
  }

  if (registro.intentos >= opciones.max) {
    return {
      permitido: false,
      reintentarEn: Math.ceil((registro.venceEn - ahora) / 1000),
    }
  }

  registro.intentos += 1
  return { permitido: true, reintentarEn: 0 }
}

/**
 * Borra el contador de una clave.
 *
 * Se llama al autenticarse con éxito: si la persona era la dueña de la cuenta y
 * simplemente se equivocó unas veces, no tiene por qué arrastrar el castigo.
 */
export function limpiarIntentos(clave: string): void {
  registros.delete(clave)
}

/**
 * Clave del contador: combina IP y email.
 *
 * Solo por IP castigaría a toda una oficina detrás del mismo NAT por culpa de
 * una persona. Solo por email deja que un atacante distribuya el ataque entre
 * miles de IPs. La combinación acota las dos cosas.
 *
 * El email se normaliza a minúsculas para que cambiarle el case no sirva de
 * evasión — y para que sea coherente con `citext` en la base.
 */
export function claveDeIntento(ip: string, email: string): string {
  return `${ip}|${email.trim().toLowerCase()}`
}

/** Solo para tests: deja el contador en cero. */
export function _reiniciarLimites(): void {
  registros.clear()
}
