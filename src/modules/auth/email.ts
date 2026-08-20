import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { env } from '@/lib/env'

/**
 * Envío de correo.
 *
 * Dos transportes reales, elegidos por `MAIL_TRANSPORT` (ADR-0001):
 *
 *   · `resend` → producción. El proveedor definitivo.
 *   · `smtp`   → desarrollo. Apunta a Mailpit, que corre local y **no deja
 *                salir nada a internet**. Los correos se leen en su UI web.
 *
 * Los DOS se implementan de verdad y los DOS tienen tests. La alternativa
 * —dejar Resend como un camino que solo se ejecuta en producción— garantiza
 * estrenarlo el día del deploy, que es el peor momento para descubrir que algo
 * no anda. En dev el correo no sale a internet; el código sí es el mismo.
 */

export interface Email {
  to: string
  subject: string
  html: string
  /** Alternativa en texto plano. Sin ella, muchos filtros marcan el correo como spam. */
  text: string
}

export interface TransporteDeEmail {
  readonly nombre: 'smtp' | 'resend'
  enviar(email: Email): Promise<void>
}

/** Mailpit en desarrollo. Cualquier servidor SMTP en general. */
export function transporteSmtp(): TransporteDeEmail {
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Mailpit escucha en texto plano. Es local y descartable: no hay nada que
    // proteger en el camino, y exigir TLS solo rompería el entorno de dev.
    secure: false,
    ignoreTLS: true,
  })

  return {
    nombre: 'smtp',
    async enviar(email) {
      await transporter.sendMail({
        from: env.EMAIL_FROM,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })
    },
  }
}

/**
 * Resend en producción.
 *
 * Recibe la clave por parámetro en vez de leerla del entorno adentro. El
 * contrato de entorno se parsea una sola vez al arrancar el proceso, así que un
 * test no puede cambiarlo después: con la dependencia explícita, el caso "falta
 * la clave" es testeable sin trucos.
 */
export function transporteResend(apiKey: string | undefined = env.RESEND_API_KEY): TransporteDeEmail {
  if (!apiKey) {
    throw new Error('MAIL_TRANSPORT=resend requiere RESEND_API_KEY')
  }

  const resend = new Resend(apiKey)

  return {
    nombre: 'resend',
    async enviar(email) {
      const { error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })

      // El SDK de Resend no tira: devuelve el error en el resultado. Sin este
      // chequeo, un correo rechazado se vería exactamente igual que uno enviado.
      if (error) {
        throw new Error(`Resend rechazó el envío: ${error.name} — ${error.message}`)
      }
    },
  }
}

let transporte: TransporteDeEmail | null = null

/** Transporte configurado. Se construye una sola vez. */
export function transporteDeEmail(): TransporteDeEmail {
  if (!transporte) {
    transporte = env.MAIL_TRANSPORT === 'resend' ? transporteResend() : transporteSmtp()
  }

  return transporte
}

/** Solo para tests: permite inyectar un transporte y volver atrás. */
export function _reemplazarTransporte(nuevo: TransporteDeEmail | null): void {
  transporte = nuevo
}

interface EmailDeReset {
  to: string
  nombre: string
  url: string
}

/**
 * Correo de recuperación de contraseña.
 *
 * El link vence en una hora (spec §7.3). Se aclara en el cuerpo: un usuario que
 * no sabe que el link caduca lo intenta al día siguiente y cree que el sistema
 * está roto.
 */
export async function enviarEmailDeReset({ to, nombre, url }: EmailDeReset): Promise<void> {
  const subject = 'Restablecer tu contraseña — Aquazaku'

  const text = [
    `Hola ${nombre},`,
    '',
    'Recibimos una solicitud para restablecer tu contraseña.',
    'Entrá a este link para elegir una nueva:',
    '',
    url,
    '',
    'El link vence en 1 hora.',
    'Si no fuiste vos, ignorá este mensaje: tu contraseña no cambió.',
    '',
    'Aquazaku',
  ].join('\n')

  const html = `
    <div style="font-family: system-ui, sans-serif; line-height: 1.6; color: #111">
      <p>Hola ${escaparHtml(nombre)},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña.</p>
      <p><a href="${escaparHtml(url)}" style="display:inline-block;padding:10px 18px;background:#0b6bcb;color:#fff;border-radius:6px;text-decoration:none">Elegir una nueva contraseña</a></p>
      <p style="color:#666;font-size:14px">El link vence en 1 hora.<br>Si no fuiste vos, ignorá este mensaje: tu contraseña no cambió.</p>
      <p style="color:#666;font-size:14px">Aquazaku</p>
    </div>
  `.trim()

  await transporteDeEmail().enviar({ to, subject, html, text })
}

/** El nombre del usuario va dentro del HTML: si no se escapa, es una inyección. */
function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
