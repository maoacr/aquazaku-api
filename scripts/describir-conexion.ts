/**
 * De qué base estamos hablando.
 *
 * ── Por qué esto merece su propio archivo ───────────────────────────────────
 *
 * El respaldo volcó la base LOCAL creyendo que volcaba producción: la variable
 * se había puesto con `export` en otra terminal, se perdió al abrir una nueva, y
 * el `.env` tomó el control **sin decir nada**.
 *
 * El script imprimió un tilde verde igual. Así se llega a tener un año de copias
 * de la laptop de alguien, y a descubrirlo el día que hay que restaurar.
 *
 * Una herramienta de respaldo que no dice QUÉ respaldó no es una herramienta de
 * respaldo. Por eso el destino se anuncia antes de empezar, se repite al
 * terminar, y va en el nombre del archivo.
 */

export interface Conexion {
  /** `usuario@host/base`, **sin la contraseña**. Para mostrar en pantalla. */
  descripcion: string
  /** Etiqueta corta para el nombre del archivo: `localhost`, `aws-0-us-east-1`. */
  etiqueta: string
}

export function describirConexion(url: string): Conexion {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { descripcion: '(cadena de conexión ilegible)', etiqueta: 'desconocido' }
  }

  const base = u.pathname.replace(/^\//, '') || '(sin base)'

  /*
   * La contraseña NUNCA se arma en la descripción. No es solo pantalla: esto
   * termina en logs, en capturas y pegado en un chat — ya pasó dos veces en
   * este proyecto.
   */
  const usuario = u.username || '(sin usuario)'

  return {
    descripcion: `${usuario}@${u.hostname}/${base}`,
    // La primera etiqueta del host alcanza para distinguir local de remoto.
    etiqueta: u.hostname.split('.')[0] || 'desconocido',
  }
}
