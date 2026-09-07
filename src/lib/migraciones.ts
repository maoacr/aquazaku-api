import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * ¿Le falta una migración a esta base?
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * El 7-sep-2026 se desplegó código que leía una tabla que la migración todavía
 * no había creado. **Nada lo impidió**: el servidor arrancó sano, el healthcheck
 * dio verde, y los dos módulos afectados fallaron recién cuando alguien los
 * abrió — en una demo con el cliente.
 *
 * El proceso no aplica migraciones: no es dueño de las tablas, y eso es
 * deliberado ([ADR-0004](/decisiones/0004-audit-log-inmutable/)). Pero puede
 * DARSE CUENTA, y decirlo antes de que lo descubra un usuario.
 *
 * ── No frena el arranque, a propósito ───────────────────────────────────────
 *
 * Un proceso que se niega a levantar deja a la plataforma reiniciándolo en
 * bucle, y nadie puede preguntarle qué le pasa. Levanta, funciona todo lo que
 * no dependa de lo que falta, y lo grita en el log y en `/health`.
 */

/** El journal viaja en la imagen: el Dockerfile copia `src` entero. */
const JOURNAL = join(process.cwd(), 'src', 'db', 'migrations', 'meta', '_journal.json')

export interface EstadoDeMigraciones {
  estado: 'al-dia' | 'pendientes' | 'no-verificable'
  /** Los `tag` que el código trae y la base todavía no aplicó. */
  faltan: string[]
  motivo?: string
}

export async function revisarMigraciones(): Promise<EstadoDeMigraciones> {
  let esperadas: string[]
  try {
    const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')) as { entries: { tag: string }[] }
    esperadas = journal.entries.map((e) => e.tag)
  } catch (err) {
    return noVerificable(`no se pudo leer el journal: ${mensaje(err)}`)
  }

  let aplicadas: number
  try {
    /*
     * Drizzle guarda un hash por migración, no el `tag`. Comparar por CANTIDAD
     * alcanza y es estable: las migraciones se aplican en orden y no se borran,
     * así que «hay menos aplicadas que archivos» significa exactamente que
     * faltan las últimas.
     */
    const [fila] = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
    )
    aplicadas = Number(fila?.n ?? 0)
  } catch (err) {
    /*
     * Sin el GRANT de la 0013 esto no se puede leer. Se responde
     * «no-verificable» en vez de «al-día»: decir que todo está bien cuando no
     * se pudo mirar es la mentira que este módulo vino a eliminar.
     */
    return noVerificable(`no se pudo leer el registro de migraciones: ${mensaje(err)}`)
  }

  if (aplicadas >= esperadas.length) return { estado: 'al-dia', faltan: [] }

  return { estado: 'pendientes', faltan: esperadas.slice(aplicadas) }
}

function noVerificable(motivo: string): EstadoDeMigraciones {
  return { estado: 'no-verificable', faltan: [], motivo }
}

function mensaje(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
