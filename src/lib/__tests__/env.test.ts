import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/lib/env'

/** Lo mínimo que hace falta para que el contrato de entorno valide. */
const minimo = {
  DATABASE_URL: 'postgres://app:app@localhost:5432/aquazaku_dev',
  DATABASE_MIGRATION_URL: 'postgres://owner:owner@localhost:5432/aquazaku_dev',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3001',
}

describe('contrato de entorno', () => {
  it('aplica los defaults cuando solo se pasa lo obligatorio', () => {
    const env = parseEnv(minimo)

    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(3001)
    expect(env.MAIL_TRANSPORT).toBe('smtp')
    expect(env.SMTP_PORT).toBe(1025)
    expect(env.COOKIE_DOMAIN).toBe('localhost')
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.WEB_PUBLIC_URL).toBe('http://localhost:3000')
  })

  it('convierte PORT de string a número', () => {
    expect(parseEnv({ ...minimo, PORT: '4000' }).PORT).toBe(4000)
  })

  describe('rechazos', () => {
    it('falta DATABASE_URL', () => {
      const { DATABASE_URL: _omitida, ...sinDb } = minimo
      expect(() => parseEnv(sinDb)).toThrow(/DATABASE_URL/)
    })

    it('falta DATABASE_MIGRATION_URL — migraciones y app usan roles distintos', () => {
      const { DATABASE_MIGRATION_URL: _omitida, ...sinMigracion } = minimo
      expect(() => parseEnv(sinMigracion)).toThrow(/DATABASE_MIGRATION_URL/)
    })

    it('secreto de auth demasiado corto', () => {
      expect(() => parseEnv({ ...minimo, BETTER_AUTH_SECRET: 'corto' })).toThrow(
        /al menos 32 caracteres/,
      )
    })

    it('NODE_ENV con un valor que no existe', () => {
      expect(() => parseEnv({ ...minimo, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/)
    })

    it('MAIL_TRANSPORT con un transporte desconocido', () => {
      expect(() => parseEnv({ ...minimo, MAIL_TRANSPORT: 'sendgrid' })).toThrow(/MAIL_TRANSPORT/)
    })

    it('el mensaje de error dice cómo arreglarlo', () => {
      expect(() => parseEnv({})).toThrow(/Copiá \.env\.example a \.env/)
    })

    it('acumula todos los faltantes en un solo error, no de a uno', () => {
      try {
        parseEnv({})
        expect.unreachable('debería haber fallado')
      } catch (err) {
        const mensaje = (err as Error).message
        expect(mensaje).toMatch(/DATABASE_URL/)
        expect(mensaje).toMatch(/DATABASE_MIGRATION_URL/)
        expect(mensaje).toMatch(/BETTER_AUTH_SECRET/)
      }
    })
  })

  describe('Resend en producción', () => {
    const produccion = { ...minimo, NODE_ENV: 'production', MAIL_TRANSPORT: 'resend' }

    it('exige la API key', () => {
      expect(() => parseEnv(produccion)).toThrow(/requiere RESEND_API_KEY/)
    })

    it('pasa cuando la API key está', () => {
      expect(() => parseEnv({ ...produccion, RESEND_API_KEY: 're_loquesea' })).not.toThrow()
    })

    it('no la exige en producción si el transporte es SMTP', () => {
      expect(() =>
        parseEnv({ ...minimo, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp' }),
      ).not.toThrow()
    })

    it('no la exige en desarrollo', () => {
      expect(() => parseEnv({ ...minimo, MAIL_TRANSPORT: 'resend' })).not.toThrow()
    })
  })
})
