import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { headersDesdeFastify } from '@/lib/http'

const pedido = (headers: Record<string, string | string[] | undefined>) =>
  ({ headers }) as unknown as FastifyRequest

describe('headersDesdeFastify()', () => {
  it('convierte headers simples', () => {
    const headers = headersDesdeFastify(pedido({ 'content-type': 'application/json' }))

    expect(headers.get('content-type')).toBe('application/json')
  })

  it('conserva TODOS los valores de un header repetido', () => {
    // La razón de existir de este helper. Con `set` en vez de `append`, el
    // último valor pisa a los anteriores: en un `set-cookie` múltiple eso hace
    // que la cookie de sesión no llegue nunca y el login quede roto sin ningún
    // error visible.
    const headers = headersDesdeFastify(
      pedido({ 'set-cookie': ['a=1; Path=/', 'b=2; Path=/', 'aquazaku_session=xyz; Path=/'] }),
    )

    const cookies = headers.getSetCookie()
    expect(cookies).toHaveLength(3)
    expect(cookies.some((c) => c.startsWith('aquazaku_session='))).toBe(true)
  })

  it('descarta los headers sin valor', () => {
    const headers = headersDesdeFastify(pedido({ ausente: undefined, presente: 'sí' }))

    expect(headers.has('ausente')).toBe(false)
    expect(headers.get('presente')).toBe('sí')
  })

  it('sin headers devuelve una colección vacía', () => {
    expect([...headersDesdeFastify(pedido({}))]).toHaveLength(0)
  })
})
