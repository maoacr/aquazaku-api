import { describe, expect, it } from 'vitest'
import { verificarRespaldo } from '../verificar-respaldo'

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

const volcadoCompleto = (cuerpo = '') => `
--
-- PostgreSQL database dump
--
CREATE TABLE public.clientes (id uuid NOT NULL);
CREATE TABLE public.ventas (id uuid NOT NULL);
CREATE TABLE public.audit_log (id uuid NOT NULL);
REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM aquazaku_app;
${cuerpo}
--
-- PostgreSQL database dump complete
--
`

describe('un respaldo válido', () => {
  it('pasa cuando está completo y trae todas las tablas', () => {
    expect(verificarRespaldo(volcadoCompleto(), TABLAS)).toEqual({ ok: true, problemas: [] })
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
    const { ok, problemas } = verificarRespaldo('   ', TABLAS)

    expect(ok).toBe(false)
    expect(problemas).toEqual(['el volcado está vacío'])
  })
})

describe('un respaldo incompleto', () => {
  /*
   * El caso real: se vuelca con el rol de la aplicación en vez del dueño. Sale
   * con código cero y con la mitad de las tablas.
   */
  it('avisa qué tabla falta, no solo que algo falta', () => {
    const sinAudit = volcadoCompleto().replace('CREATE TABLE public.audit_log (id uuid NOT NULL);', '')

    const { ok, problemas } = verificarRespaldo(sinAudit, TABLAS)

    expect(ok).toBe(false)
    expect(problemas[0]).toContain('audit_log')
  })

  it('lista TODAS las que faltan, para no arreglarlas de a una', () => {
    const { problemas } = verificarRespaldo(volcadoCompleto(), [...TABLAS, 'bases', 'compras'])

    expect(problemas[0]).toContain('bases')
    expect(problemas[0]).toContain('compras')
  })
})

describe('la forma del volcado', () => {
  it('acepta las tablas con o sin el esquema public por delante', () => {
    const sinEsquema = volcadoCompleto()
      .replace(/public\./g, '')

    expect(verificarRespaldo(sinEsquema, TABLAS).ok).toBe(true)
  })

  /*
   * `bases_historicas` NO satisface a `bases`. Sin el límite de palabra, una
   * tabla ausente se daría por presente porque otra la contiene como prefijo, y
   * el respaldo pasaría la verificación estando incompleto.
   */
  it('una tabla cuyo nombre EMPIEZA con el buscado no lo da por presente', () => {
    const conPrefijo = `
CREATE TABLE public.bases_historicas (id uuid NOT NULL);
-- PostgreSQL database dump complete
`
    const { ok, problemas } = verificarRespaldo(conPrefijo, ['bases'])

    expect(ok).toBe(false)
    expect(problemas[0]).toContain('bases')
  })
})

/**
 * ── El respaldo que restaura una bitácora editable ──────────────────────────
 *
 * `pg_dump --no-privileges` produce un archivo que se ve perfecto: trae todas
 * las tablas, cierra bien, restaura sin errores. Y deja el `audit_log`
 * editable, porque la mitad dura de ADR-0004 son permisos.
 *
 * Es el peor respaldo posible: el que no se nota.
 */
describe('los permisos del audit_log', () => {
  it('un volcado sin REVOKE se rechaza aunque esté completo', () => {
    const sinPermisos = volcadoCompleto().replace(
      'REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM aquazaku_app;',
      '',
    )

    const { ok, problemas } = verificarRespaldo(sinPermisos, TABLAS)

    expect(ok).toBe(false)
    expect(problemas.join(' ')).toContain('EDITABLE')
  })
})
