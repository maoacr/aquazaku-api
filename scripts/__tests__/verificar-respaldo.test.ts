import { describe, expect, it } from 'vitest'
import { privilegiosQuitados, verificarRespaldo } from '../verificar-respaldo'

/**
 * La verificación del respaldo.
 *
 * ── Por qué esto tiene tests y el script no ─────────────────────────────────
 *
 * El script llama a `pg_dump`; probarlo sería probar a Postgres. Lo que sí es
 * nuestro —y lo que decide si un archivo cuenta como respaldo— es esta función.
 *
 * Y es exactamente la lógica que no se puede descubrir rota el día que hay que
 * restaurar.
 */

const TABLAS = ['clientes', 'ventas', 'audit_log']

/**
 * Un volcado como los que produce pg_dump de verdad.
 *
 * ── El detalle que la primera versión no supo ─────────────────────────────
 *
 * pg_dump **no reproduce la historia**: dumpea el estado final. Un
 * `GRANT SELECT,INSERT,UPDATE` seguido de `REVOKE UPDATE` sale de acá como
 * `GRANT SELECT,INSERT` y sin una sola línea con `REVOKE`.
 *
 * Verificado contra pg_dump 17.11 antes de escribir esto.
 */
const volcadoCompleto = (grantMovimientos = 'SELECT,INSERT') => `
--
-- PostgreSQL database dump
--
CREATE TABLE public.clientes (id uuid NOT NULL);
CREATE TABLE public.ventas (id uuid NOT NULL);
CREATE TABLE public.audit_log (id uuid NOT NULL);
CREATE TABLE public.movimientos_stock (id uuid NOT NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.clientes TO aquazaku_app;
GRANT ${grantMovimientos} ON TABLE public.movimientos_stock TO aquazaku_app;
--
-- PostgreSQL database dump complete
--
`

const MIGRACIONES = `
REVOKE UPDATE, DELETE ON movimientos_stock FROM aquazaku_app;
REVOKE DELETE ON ventas FROM aquazaku_app;
`

describe('lo que se quitó, leído de las migraciones', () => {
  it('sale de las migraciones y no de una lista escrita a mano', () => {
    const quitados = privilegiosQuitados(MIGRACIONES)

    expect([...quitados.get('movimientos_stock')!]).toEqual(['UPDATE', 'DELETE'])
    expect([...quitados.get('ventas')!]).toEqual(['DELETE'])
  })

  it('ignora los REVOKE que no son sobre el rol de la aplicación', () => {
    expect(privilegiosQuitados('REVOKE ALL ON tabla FROM PUBLIC;').size).toBe(0)
  })
})

describe('un respaldo válido', () => {
  it('pasa aunque no contenga la palabra REVOKE, porque pg_dump no la escribe', () => {
    const volcado = volcadoCompleto()

    expect(volcado).not.toContain('REVOKE')
    expect(verificarRespaldo(volcado, TABLAS, privilegiosQuitados(MIGRACIONES))).toEqual({
      ok: true,
      problemas: [],
    })
  })
})

/**
 * ── Lo que este chequeo existe para atrapar ─────────────────────────────────
 *
 * `pg_dump` puede devolver cero y dejar un archivo cortado: una conexión que se
 * cae, un disco lleno, un pipe roto. El archivo se ve bien, pesa, tiene SQL
 * adentro — y no sirve.
 */
describe('un respaldo truncado', () => {
  it('se detecta por el marcador de cierre que falta', () => {
    const cortado = volcadoCompleto().replace('-- PostgreSQL database dump complete', '')

    const { ok, problemas } = verificarRespaldo(cortado, TABLAS)

    expect(ok).toBe(false)
    expect(problemas[0]).toContain('TRUNCADO')
  })

  it('un volcado vacío no se confunde con uno sin datos', () => {
    expect(verificarRespaldo('   ', TABLAS)).toEqual({
      ok: false,
      problemas: ['el volcado está vacío'],
    })
  })
})

describe('un respaldo incompleto', () => {
  it('avisa qué tabla falta, no solo que algo falta', () => {
    const sinAudit = volcadoCompleto().replace('CREATE TABLE public.audit_log (id uuid NOT NULL);', '')

    expect(verificarRespaldo(sinAudit, TABLAS).problemas[0]).toContain('audit_log')
  })

  /*
   * `bases_historicas` NO satisface a `bases`. Sin el límite de palabra, una
   * tabla ausente se daría por presente porque otra la contiene como prefijo.
   */
  it('una tabla cuyo nombre EMPIEZA con el buscado no la da por presente', () => {
    const conPrefijo = 'CREATE TABLE public.bases_historicas (id uuid);\n-- PostgreSQL database dump complete'

    expect(verificarRespaldo(conPrefijo, ['bases']).problemas[0]).toContain('bases')
  })
})

/**
 * ── El respaldo que restaura un libro reescribible ──────────────────────────
 *
 * Es el peor caso posible, porque no se nota: restaura sin errores, la
 * aplicación arranca, los tests pasan. Y `movimientos_stock` volvió a ser
 * editable, así que las leyes de conservación dejaron de valer.
 */
describe('los permisos que una migración había quitado', () => {
  it('un GRANT que devuelve UPDATE se rechaza', () => {
    const conUpdate = volcadoCompleto('SELECT,INSERT,UPDATE')

    const { ok, problemas } = verificarRespaldo(conUpdate, TABLAS, privilegiosQuitados(MIGRACIONES))

    expect(ok).toBe(false)
    expect(problemas[0]).toContain('movimientos_stock recupera UPDATE')
  })

  it('un volcado sin ningún GRANT se rechaza: se hizo con --no-privileges', () => {
    const sinPermisos = volcadoCompleto().replace(/^GRANT.*$/gm, '')

    const { ok, problemas } = verificarRespaldo(sinPermisos, TABLAS, privilegiosQuitados(MIGRACIONES))

    expect(ok).toBe(false)
    expect(problemas[0]).toContain('--no-privileges')
  })

  it('un GRANT amplio sobre una tabla SIN revoke no molesta', () => {
    // `clientes` se edita a propósito: no todo libro es de solo lectura.
    expect(verificarRespaldo(volcadoCompleto(), TABLAS, privilegiosQuitados(MIGRACIONES)).ok).toBe(true)
  })
})
