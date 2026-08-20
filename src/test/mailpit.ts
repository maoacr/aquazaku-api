/**
 * Cliente mínimo de la API de Mailpit, para tests.
 *
 * Permite verificar que un correo **realmente salió** por SMTP y llegó, en vez
 * de espiar si se llamó a una función. La diferencia importa: un mock confirma
 * que el código hizo lo que el test espera; Mailpit confirma que del otro lado
 * hay un mensaje.
 */

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025'

export interface MensajeDeMailpit {
  ID: string
  Subject: string
  To: Array<{ Address: string }>
}

export interface ContenidoDeMensaje {
  Subject: string
  Text: string
  HTML: string
}

/** Falla con un mensaje útil si Mailpit no está corriendo. */
export async function exigirMailpit(): Promise<void> {
  try {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=1`)
    if (res.ok) return
  } catch {
    // cae al throw de abajo
  }

  throw new Error(
    `Mailpit no responde en ${MAILPIT_URL}. Estos tests verifican envío real de correo.\n` +
      'Levantalo con: brew services start mailpit\n' +
      'Ver /empezar/entorno-local/ en las docs.',
  )
}

export async function vaciarBuzon(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' })
}

export async function mensajes(): Promise<MensajeDeMailpit[]> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`)
  const datos = (await res.json()) as { messages?: MensajeDeMailpit[] }
  return datos.messages ?? []
}

export async function contenido(id: string): Promise<ContenidoDeMensaje> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`)
  return (await res.json()) as ContenidoDeMensaje
}

/**
 * Espera a que llegue un correo para un destinatario y devuelve su contenido.
 *
 * El envío SMTP es asincrónico respecto del request que lo dispara, así que
 * consultar una sola vez produce tests que fallan de a ratos.
 */
export async function esperarCorreoPara(
  destinatario: string,
  timeoutMs = 5000,
): Promise<ContenidoDeMensaje> {
  const limite = Date.now() + timeoutMs

  while (Date.now() < limite) {
    const encontrado = (await mensajes()).find((m) =>
      m.To.some((t) => t.Address.toLowerCase() === destinatario.toLowerCase()),
    )

    if (encontrado) return contenido(encontrado.ID)

    await new Promise((r) => setTimeout(r, 100))
  }

  throw new Error(`no llegó ningún correo para ${destinatario} en ${timeoutMs}ms`)
}
