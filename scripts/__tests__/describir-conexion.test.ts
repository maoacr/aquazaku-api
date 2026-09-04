import { describe, expect, it } from 'vitest'
import { describirConexion } from '../describir-conexion'

/**
 * De qué base estamos hablando.
 *
 * Existe porque el respaldo volcó la base local creyendo que volcaba producción,
 * y lo reportó con un tilde verde. Lo único que faltaba era decir a dónde se
 * había conectado.
 */

describe('qué base se está respaldando', () => {
  it('distingue la local de la de producción', () => {
    expect(describirConexion('postgresql://aquazaku:secreta@localhost:5432/aquazaku_dev')).toEqual({
      descripcion: 'aquazaku@localhost/aquazaku_dev',
      etiqueta: 'localhost',
    })

    expect(
      describirConexion(
        'postgresql://postgres.abc:secreta@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      ),
    ).toEqual({
      descripcion: 'postgres.abc@aws-0-us-east-1.pooler.supabase.com/postgres',
      etiqueta: 'aws-0-us-east-1',
    })
  })
})

/**
 * ── La contraseña no se arma, ni para mostrar ───────────────────────────────
 *
 * Esto termina en la consola, en capturas y pegado en un chat. En este proyecto
 * ya se filtró dos veces por ahí.
 */
describe('la contraseña', () => {
  it('nunca aparece en la descripción', () => {
    const { descripcion } = describirConexion(
      'postgresql://usuario:fygtef-3zagty@host.com:5432/base',
    )

    expect(descripcion).not.toContain('fygtef')
    expect(descripcion).toBe('usuario@host.com/base')
  })

  it('tampoco cuando tiene caracteres raros escapados', () => {
    const { descripcion } = describirConexion('postgresql://u:p%40ss%3Aword@host.com/base')

    expect(descripcion).not.toContain('ss')
    expect(descripcion).not.toContain('word')
  })
})

describe('una cadena ilegible', () => {
  it('no rompe el script: dice que no la entiende', () => {
    expect(describirConexion('esto no es una url').descripcion).toContain('ilegible')
  })
})
