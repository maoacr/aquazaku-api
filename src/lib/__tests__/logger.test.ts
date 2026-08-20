import { describe, expect, it } from 'vitest'
import { buildLoggerOptions } from '@/lib/logger'

describe('configuración del logger', () => {
  it('lo apaga en tests, para que el output de los asserts se lea', () => {
    expect(buildLoggerOptions('test', 'info')).toBe(false)
  })

  it('en desarrollo usa pino-pretty', () => {
    const opciones = buildLoggerOptions('development', 'debug')

    expect(opciones).toMatchObject({
      level: 'debug',
      transport: { target: 'pino-pretty' },
    })
  })

  it('en producción emite JSON crudo, sin transport', () => {
    const opciones = buildLoggerOptions('production', 'warn')

    expect(opciones).toEqual({ level: 'warn' })
  })

  it('sin NODE_ENV se comporta como producción — el default seguro', () => {
    expect(buildLoggerOptions(undefined, 'info')).toEqual({ level: 'info' })
  })

  it('cae en info cuando no le dicen el nivel', () => {
    expect(buildLoggerOptions('production', undefined)).toEqual({ level: 'info' })
  })
})
