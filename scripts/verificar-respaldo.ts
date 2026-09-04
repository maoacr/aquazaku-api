/**
 * Verificación de un volcado de `pg_dump`.
 *
 * ── El único chequeo que importa de verdad ──────────────────────────────────
 *
 * Que `pg_dump` devuelva cero NO significa que el archivo sirva. Una conexión
 * cortada a la mitad, un disco lleno o un pipe roto pueden dejar un volcado
 * truncado con salida limpia.
 *
 * Por eso se busca el marcador de cierre que pg_dump escribe **al final de
 * todo**: si está, el volcado llegó hasta el último byte. Es la diferencia entre
 * «el comando anduvo» y «el archivo sirve».
 *
 * Está separado del script para poder probarlo sin una base y sin `pg_dump`:
 * la lógica que decide si un respaldo vale es justamente la que no puede
 * descubrirse rota el día que hay que restaurar.
 */

/** Lo que pg_dump escribe en la última línea. Sin esto, el volcado está cortado. */
const CIERRE = 'PostgreSQL database dump complete'

export interface Veredicto {
  ok: boolean
  problemas: string[]
}

export function verificarRespaldo(volcado: string, tablasEsperadas: string[]): Veredicto {
  const problemas: string[] = []

  if (volcado.trim() === '') {
    return { ok: false, problemas: ['el volcado está vacío'] }
  }

  if (!volcado.includes(CIERRE)) {
    problemas.push(
      'falta el marcador de cierre de pg_dump: el volcado quedó TRUNCADO aunque el comando no haya fallado',
    )
  }

  /*
   * Las tablas se contrastan contra las que declara el esquema, no contra una
   * lista escrita a mano. Una lista fija se desactualiza en silencio: se agrega
   * una tabla, el respaldo la trae, y la verificación nunca se entera de que
   * podría no traerla.
   */
  const faltantes = tablasEsperadas.filter(
    (tabla) => !new RegExp(`CREATE TABLE (?:public\\.)?"?${tabla}"?\\b`).test(volcado),
  )

  if (faltantes.length > 0) {
    problemas.push(`faltan tablas que el esquema declara: ${faltantes.join(', ')}`)
  }

  /*
   * ── Los REVOKE tienen que estar ───────────────────────────────────────────
   *
   * La mitad dura de la inmutabilidad del `audit_log` (ADR-0004) son permisos,
   * no triggers. Un `pg_dump --no-privileges` los descarta y produce un archivo
   * que restaura una base funcional con la bitácora EDITABLE.
   *
   * Ese respaldo es peor que ninguno: pasa desapercibido hasta el día que se
   * usa, y ese día ya nadie recuerda que se restauró.
   */
  if (!/^REVOKE /m.test(volcado)) {
    problemas.push(
      'el volcado no trae ningún REVOKE: se hizo con --no-privileges y restauraría el audit_log EDITABLE (ADR-0004)',
    )
  }

  return { ok: problemas.length === 0, problemas }
}
