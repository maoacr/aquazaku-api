/**
 * Verificación de un volcado de `pg_dump`.
 *
 * ── El único chequeo que importa de verdad ──────────────────────────────────
 *
 * Que `pg_dump` devuelva cero NO significa que el archivo sirva. Una conexión
 * cortada, un disco lleno o un pipe roto pueden dejar un volcado truncado con
 * salida limpia. Por eso se busca el marcador que pg_dump escribe al final de
 * todo: es la diferencia entre «el comando anduvo» y «el archivo sirve».
 *
 * ── Los permisos se verifican por lo que DICEN, no por cómo se escribieron ──
 *
 * La primera versión buscaba la palabra `REVOKE` en el volcado. Estaba mal:
 * `pg_dump` no reproduce la historia, dumpea el estado FINAL. Un
 * `GRANT SELECT,INSERT,UPDATE` seguido de `REVOKE UPDATE` sale del otro lado
 * como `GRANT SELECT,INSERT` y ni una sola línea con `REVOKE`.
 *
 * Buscar la palabra daba falsa alarma sobre un respaldo perfecto — y habría
 * dado falsa CALMA el día que el `GRANT` volviera con `UPDATE` adentro.
 *
 * Ahora se lee de las migraciones qué privilegios se quitaron, y se verifica que
 * el volcado no los devuelva. Es la garantía, no su ortografía.
 */

/** Lo que pg_dump escribe en la última línea. Sin esto, el volcado está cortado. */
const CIERRE = 'PostgreSQL database dump complete'

/** El rol con el que corre la aplicación. Es de quien hay que cuidar los permisos. */
const ROL_APP = 'aquazaku_app'

export interface Veredicto {
  ok: boolean
  problemas: string[]
}

/**
 * Qué privilegios quita cada migración, leído del SQL.
 *
 * Sale de las migraciones y no de una lista escrita a mano: agregar un `REVOKE`
 * en una migración nueva hace que el respaldo lo empiece a verificar solo. Una
 * lista fija se desactualiza en silencio, que es la peor forma de fallar.
 */
export function privilegiosQuitados(sqlDeMigraciones: string): Map<string, Set<string>> {
  const quitados = new Map<string, Set<string>>()
  const patron = /REVOKE\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?(?:public\.)?"?(\w+)"?\s+FROM\s+(\w+)/gi

  for (const [, privilegios, tabla, rol] of sqlDeMigraciones.matchAll(patron)) {
    if (rol!.toLowerCase() !== ROL_APP) continue

    const actuales = quitados.get(tabla!) ?? new Set<string>()
    for (const p of privilegios!.split(',')) actuales.add(p.trim().toUpperCase())
    quitados.set(tabla!, actuales)
  }

  return quitados
}

export function verificarRespaldo(
  volcado: string,
  tablasEsperadas: string[],
  quitados: Map<string, Set<string>> = new Map(),
): Veredicto {
  const problemas: string[] = []

  if (volcado.trim() === '') {
    return { ok: false, problemas: ['el volcado está vacío'] }
  }

  /*
   * ── Verificar contra nada NO es verificar ─────────────────────────────────
   *
   * Sin tablas esperadas, todo lo de abajo pasa por vacuidad y el script
   * imprime «✓ respaldo verificado — 0 tablas». Ya pasó: la lista se armaba
   * adivinando la forma interna de los objetos de Drizzle y salía vacía.
   *
   * Un verificador que no puede fallar es peor que ninguno: da exactamente la
   * confianza que uno fue a buscar, y la da siempre.
   */
  if (tablasEsperadas.length === 0) {
    return {
      ok: false,
      problemas: [
        'no hay ninguna tabla que verificar: la lista llegó vacía, así que este respaldo NO se verificó',
      ],
    }
  }

  if (!volcado.includes(CIERRE)) {
    problemas.push(
      'falta el marcador de cierre de pg_dump: el volcado quedó TRUNCADO aunque el comando no haya fallado',
    )
  }

  const faltantes = tablasEsperadas.filter(
    (tabla) => !new RegExp(`CREATE TABLE (?:public\\.)?"?${tabla}"?\\b`).test(volcado),
  )
  if (faltantes.length > 0) {
    problemas.push(`faltan tablas que el esquema declara: ${faltantes.join(', ')}`)
  }

  /*
   * Sin un solo GRANT al rol de la aplicación, el volcado se hizo con
   * `--no-privileges`: restauraría una base donde `aquazaku_app` no puede hacer
   * nada, o —peor, según cómo se restaure— donde los candados no existen.
   */
  const otorgados = [...volcado.matchAll(otorgadosA(ROL_APP))]

  if (otorgados.length === 0 && quitados.size > 0) {
    problemas.push(
      `el volcado no otorga NADA a ${ROL_APP}: se hizo con --no-privileges y perdió toda la estructura de permisos (ADR-0004)`,
    )
  }

  /*
   * ── Lo que este chequeo cuida ─────────────────────────────────────────────
   *
   * Que un privilegio quitado en una migración no reaparezca en el volcado. Si
   * `movimientos_stock` vuelve con `UPDATE`, el respaldo restaura un libro de
   * movimientos reescribible: una base que funciona, pasa los tests, y perdió
   * la garantía.
   */
  for (const [, [, privilegios, tabla]] of otorgados.entries()) {
    const prohibidos = quitados.get(tabla!)
    if (!prohibidos) continue

    const devueltos = privilegios!
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => prohibidos.has(p))

    if (devueltos.length > 0) {
      problemas.push(
        `${tabla} recupera ${devueltos.join(', ')} sobre ${ROL_APP}: una migración se lo había quitado, y este respaldo lo restauraría reescribible`,
      )
    }
  }

  return { ok: problemas.length === 0, problemas }
}

/** `GRANT SELECT,INSERT ON TABLE public.movimientos_stock TO aquazaku_app;` */
function otorgadosA(rol: string): RegExp {
  return new RegExp(
    `GRANT\\s+([A-Z,\\s]+?)\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?"?(\\w+)"?\\s+TO\\s+${rol}\\b`,
    'gi',
  )
}
