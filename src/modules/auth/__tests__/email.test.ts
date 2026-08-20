import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { esperarCorreoPara, exigirMailpit, mensajes, vaciarBuzon } from '@/test/mailpit'
import {
  _reemplazarTransporte,
  enviarEmailDeReset,
  transporteResend,
  transporteSmtp,
} from '../email'

describe('transporte SMTP contra Mailpit real', () => {
  beforeAll(async () => {
    await exigirMailpit()
  })

  beforeEach(async () => {
    await vaciarBuzon()
    _reemplazarTransporte(transporteSmtp())
  })

  afterAll(() => {
    _reemplazarTransporte(null)
  })

  it('el correo LLEGA de verdad', async () => {
    // Esto es lo que un mock no puede probar: que del otro lado hay un mensaje.
    await enviarEmailDeReset({
      to: 'destinatario@aquazaku.com',
      nombre: 'Mao',
      url: 'http://localhost:3000/reset-password?token=abc123',
    })

    const correo = await esperarCorreoPara('destinatario@aquazaku.com')

    expect(correo.Subject).toBe('Restablecer tu contraseña — Aquazaku')
    expect(correo.HTML).toContain('http://localhost:3000/reset-password?token=abc123')
  })

  it('lleva versión en texto plano además de HTML', async () => {
    await enviarEmailDeReset({
      to: 'texto@aquazaku.com',
      nombre: 'Mao',
      url: 'http://localhost:3000/reset-password?token=xyz',
    })

    const correo = await esperarCorreoPara('texto@aquazaku.com')

    // Sin alternativa en texto plano, muchos filtros lo marcan como spam.
    expect(correo.Text).toContain('http://localhost:3000/reset-password?token=xyz')
    expect(correo.Text).toContain('Mao')
  })

  it('avisa que el link vence en 1 hora', async () => {
    await enviarEmailDeReset({
      to: 'vencimiento@aquazaku.com',
      nombre: 'Mao',
      url: 'http://localhost:3000/reset-password?token=t',
    })

    const correo = await esperarCorreoPara('vencimiento@aquazaku.com')

    // Un usuario que no sabe que el link caduca lo intenta al día siguiente y
    // concluye que el sistema está roto.
    expect(correo.Text).toMatch(/vence en 1 hora/i)
  })

  it('escapa el nombre: no se puede inyectar HTML por ahí', async () => {
    await enviarEmailDeReset({
      to: 'inyeccion@aquazaku.com',
      nombre: '<img src=x onerror=alert(1)>',
      url: 'http://localhost:3000/reset-password?token=t',
    })

    const correo = await esperarCorreoPara('inyeccion@aquazaku.com')

    expect(correo.HTML).not.toContain('<img src=x')
    expect(correo.HTML).toContain('&lt;img')
  })

  it('en desarrollo NADA sale a internet: todo queda en Mailpit', async () => {
    await enviarEmailDeReset({
      to: 'cliente-real@gmail.com',
      nombre: 'Alguien',
      url: 'http://localhost:3000/reset-password?token=t',
    })

    // Aunque el destinatario sea una casilla real, el correo se queda acá.
    const correo = await esperarCorreoPara('cliente-real@gmail.com')
    expect(correo.Subject).toContain('Aquazaku')
    expect(await mensajes()).toHaveLength(1)
  })
})

/**
 * Se mockea el SDK de Resend, no nuestro código.
 *
 * Así el transporte de producción SE EJECUTA en los tests —el mapeo de campos,
 * el chequeo del error— y lo único que queda afuera es la red. Mockear nuestro
 * propio transporte dejaría el camino de producción sin correr nunca hasta el
 * día del deploy, que es justo lo que se quiere evitar.
 */
const enviarDeResend = vi.fn()
const CLAVE = 're_clave_de_prueba'

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: enviarDeResend }
  },
}))

describe('transporte Resend', () => {
  beforeEach(() => {
    enviarDeResend.mockReset()
    enviarDeResend.mockResolvedValue({ data: { id: 'msg_1' }, error: null })
    _reemplazarTransporte(null)
  })

  afterAll(() => {
    _reemplazarTransporte(null)
  })

  it('manda el correo por el SDK con todos los campos', async () => {
    _reemplazarTransporte(transporteResend(CLAVE))

    await enviarEmailDeReset({
      to: 'produccion@aquazaku.com',
      nombre: 'Mao',
      url: 'http://localhost:3000/reset-password?token=abc',
    })

    expect(enviarDeResend).toHaveBeenCalledOnce()
    const enviado = enviarDeResend.mock.calls[0]?.[0]
    expect(enviado).toMatchObject({
      to: 'produccion@aquazaku.com',
      subject: 'Restablecer tu contraseña — Aquazaku',
    })
    expect(enviado.html).toContain('token=abc')
    expect(enviado.text).toContain('token=abc')
  })

  it('trata el error del SDK, que no lanza sino que lo devuelve', async () => {
    // La trampa de la API de Resend: `send` RESUELVE con `{ error }` en vez de
    // rechazar. Sin chequearlo, un correo rechazado se ve igual que uno enviado.
    enviarDeResend.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'from inválido' },
    })
    _reemplazarTransporte(transporteResend(CLAVE))

    await expect(
      enviarEmailDeReset({ to: 'x@aquazaku.com', nombre: 'X', url: 'http://x' }),
    ).rejects.toThrow(/Resend rechazó el envío.*validation_error/)
  })

  it('exige la API key: el transporte no puede construirse a medias', () => {
    // Descubrir que falta la clave al mandar el primer correo de producción es
    // demasiado tarde.
    expect(() => transporteResend(undefined)).toThrow(/RESEND_API_KEY/)
    expect(() => transporteResend('')).toThrow(/RESEND_API_KEY/)
  })

  it('el correo es IDÉNTICO al que manda el transporte SMTP', async () => {
    _reemplazarTransporte(transporteResend(CLAVE))
    await enviarEmailDeReset({
      to: 'comparacion@aquazaku.com',
      nombre: 'Mao',
      url: 'http://localhost:3000/reset-password?token=zzz',
    })
    const porResend = enviarDeResend.mock.calls[0]?.[0]

    _reemplazarTransporte(transporteSmtp())
    await vaciarBuzon()
    await enviarEmailDeReset({
      to: 'comparacion@aquazaku.com',
      nombre: 'Mao',
      url: 'http://localhost:3000/reset-password?token=zzz',
    })
    const porSmtp = await esperarCorreoPara('comparacion@aquazaku.com')

    // Si difirieran, el correo que ve el usuario en producción sería uno que
    // nadie miró nunca en desarrollo.
    expect(porResend.subject).toBe(porSmtp.Subject)
    expect(porSmtp.Text.replace(/\r/g, '').trim()).toBe(porResend.text.trim())
  })
})
