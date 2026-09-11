import { describe, expect, it } from 'vitest'
import { numeroParaWhatsapp } from '../whatsapp'

/**
 * El enlace de WhatsApp, y por qué no todo número lo tiene.
 *
 * ── Lo que este archivo vigila ──────────────────────────────────────────────
 *
 * Que el botón NO aparezca sobre un fijo. `wa.me/576058781234` abre WhatsApp y
 * contesta que ese número no existe — un callejón sin salida que quien atiende
 * lee como «el sistema está roto», y que lo va a hacer desconfiar del botón
 * también donde sí funciona.
 *
 * Los números se guardan como texto libre: la base solo les hace `trim`. Así
 * que acá entra lo que una persona escribió, con espacios, guiones, paréntesis
 * o el indicativo por delante.
 */

describe('celulares colombianos', () => {
  it('un celular con espacios sale en dígitos, con el 57 adelante', () => {
    expect(numeroParaWhatsapp('300 123 4567')).toBe('573001234567')
  })

  it.each([
    ['guiones', '300-123-4567'],
    ['paréntesis', '(300) 123 4567'],
    ['puntos', '300.123.4567'],
    ['todo junto', '3001234567'],
    ['con indicativo', '+57 300 123 4567'],
    ['con indicativo sin +', '57 300 123 4567'],
  ])('%s', (_, escrito) => {
    expect(numeroParaWhatsapp(escrito)).toBe('573001234567')
  })
})

/**
 * ── La razón de ser de esta función ─────────────────────────────────────────
 *
 * Colombia renumeró en 2022: los fijos quedaron en diez dígitos empezando por
 * `60`, igual de largos que un celular. Ya no se distinguen por longitud — solo
 * por el primer dígito.
 *
 * La colección de Bruno tiene los dos casos conviviendo en el mismo cliente:
 * `300 123 4567` y `605 878 1234`.
 */
describe('lo que NO es un celular', () => {
  it.each([
    ['un fijo de Barranquilla', '605 878 1234'],
    ['un fijo de Bogotá', '601 234 5678'],
    ['una extensión corta', '3001'],
    ['un número de más', '3001234567890'],
    ['letras', 'llamar al local'],
    ['vacío', ''],
    ['solo espacios', '   '],
  ])('%s no tiene WhatsApp', (_, escrito) => {
    expect(numeroParaWhatsapp(escrito)).toBeNull()
  })
})

/**
 * Un indicativo que no es el de Colombia se rechaza en vez de reinterpretarse.
 *
 * Tentador sería quedarse con los últimos diez dígitos, pero eso convierte un
 * número de México en uno colombiano que le pertenece a otra persona — y el
 * mensaje llega, a quien no era.
 */
describe('lo que no es de Colombia', () => {
  it('un número con otro indicativo no se recorta para que entre', () => {
    expect(numeroParaWhatsapp('+52 55 1234 5678')).toBeNull()
  })
})
