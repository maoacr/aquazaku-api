import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type EstadoDeMigraciones, revisarMigraciones } from '@/lib/migraciones'

/**
 * El latido que evita que Supabase apague el proyecto.
 *
 * ── Por qué vive acá y no en un cron externo ────────────────────────────────
 *
 * El plan gratuito de Supabase pausa el proyecto tras una semana **sin
 * actividad de base de datos**. Una consulta cualquiera reinicia ese reloj.
 *
 * Y `api` ya es un proceso de larga vida: por eso corre en contenedores y no en
 * funciones ([ADR-0009](/decisiones/0009-donde-corre-aquazaku/)). Un servicio de
 * cron aparte sería una cuarta plataforma, con su cuenta, su factura y su propia
 * forma de fallar en silencio — para hacer lo que este proceso puede hacer solo.
 *
 * ── El latido también dice si la base responde ──────────────────────────────
 *
 * Es el mismo hecho. Consultar para mantenerla despierta y consultar para saber
 * si contesta son la misma consulta, así que `/health` reporta lo que este
 * latido descubrió en vez de mentir con un `ok` fijo.
 *
 * Antes de esto, Railway estuvo en verde durante toda la puesta en marcha con
 * Supabase inalcanzable.
 */

/**
 * Cada seis horas: 28 latidos en la ventana de siete días.
 *
 * No se elige por costo —una consulta trivial cuatro veces al día no se nota—
 * sino por MARGEN. Con un latido diario, siete fallos seguidos apagan el
 * proyecto; con este, harían falta veintiocho.
 */
const CADA = 6 * 60 * 60 * 1000

/** A partir de acá, `/health` deja de decir que la base está bien. */
const SIN_NOTICIAS = 30 * 60 * 1000

export interface EstadoDeLatido {
  ultimoContacto: Date | null
  ultimoError: string | null
  latidos: number
  /** Se revisa una vez al arrancar: el esquema no cambia mientras el proceso vive. */
  migraciones: EstadoDeMigraciones | null
}

const estado: EstadoDeLatido = {
  ultimoContacto: null,
  ultimoError: null,
  latidos: 0,
  migraciones: null,
}

export function leerEstado(): EstadoDeLatido {
  return { ...estado }
}

/**
 * Lo que `/health` cuenta sobre la base.
 *
 * Separado del efecto para poder probar los bordes —el arranque, el silencio
 * largo— sin esperar seis horas ni tocar una base.
 */
export function resumirLatido(
  e: EstadoDeLatido,
  ahora: Date,
  sinNoticias = SIN_NOTICIAS,
): {
  base: 'ok' | 'sin-contacto' | 'arrancando'
  desdeHaceMs: number | null
  error?: string
  esquema?: EstadoDeMigraciones['estado']
  faltan?: string[]
} {
  /*
   * El estado del esquema viaja en el mismo reporte que el de la base. Son la
   * misma pregunta: «¿este proceso puede hacer su trabajo?»
   */
  const esquema =
    e.migraciones && e.migraciones.estado !== 'al-dia'
      ? { esquema: e.migraciones.estado, faltan: e.migraciones.faltan }
      : {}

  if (!e.ultimoContacto) {
    /*
     * Sin contacto todavía NO es lo mismo que contacto perdido. Al arrancar hay
     * unos segundos donde nada falló aún, y reportar «sin-contacto» ahí
     * enseñaría a ignorar ese valor.
     */
    return e.ultimoError
      ? { base: 'sin-contacto', desdeHaceMs: null, error: e.ultimoError, ...esquema }
      : { base: 'arrancando', desdeHaceMs: null, ...esquema }
  }

  const desdeHaceMs = ahora.getTime() - e.ultimoContacto.getTime()
  if (desdeHaceMs > sinNoticias) {
    return {
      base: 'sin-contacto',
      desdeHaceMs,
      ...(e.ultimoError && { error: e.ultimoError }),
      ...esquema,
    }
  }

  return { base: 'ok', desdeHaceMs, ...esquema }
}

/** Una consulta trivial que además devuelve algo cierto: el reloj de la base. */
export async function latir(): Promise<Date> {
  const [fila] = await db.execute<{ ahora: Date }>(sql`SELECT now() AS ahora`)
  return new Date(fila!.ahora)
}

/**
 * Arranca el latido y devuelve cómo detenerlo.
 *
 * ── Late al arrancar, no solo cada seis horas ───────────────────────────────
 *
 * Si solo latiera en el intervalo, un contenedor que se reinicia seguido
 * —cada deploy lo reinicia— podría no latir NUNCA: el temporizador vuelve a
 * cero antes de cumplirse. El sistema quedaría sin latido justamente mientras
 * más se trabaja en él.
 */
export function iniciarLatido(
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  cada = CADA,
): () => void {
  const golpe = async (): Promise<void> => {
    try {
      const enLaBase = await latir()

      estado.ultimoContacto = new Date()
      estado.ultimoError = null
      estado.latidos += 1

      log.info(
        { latidos: estado.latidos, relojDeLaBase: enLaBase.toISOString() },
        'latido: la base respondió, el proyecto sigue despierto',
      )
    } catch (err) {
      /*
       * Nunca tira. Un latido que voltea al servidor donde vive es peor que no
       * tener latido: cambia «la base no responde» por «no responde nadie».
       */
      estado.ultimoError = err instanceof Error ? err.message : String(err)
      log.warn({ error: estado.ultimoError }, 'latido: la base NO respondió')
    }
  }

  /*
   * Al arrancar, además del latido: ¿el esquema es el que este código espera?
   *
   * Una sola vez, porque las migraciones no se aplican solas mientras el
   * proceso vive — si alguien las corre, el redeploy vuelve a revisar.
   */
  void revisarMigraciones()
    .then((m) => {
      estado.migraciones = m

      if (m.estado === 'pendientes') {
        log.warn(
          { faltan: m.faltan },
          'FALTAN MIGRACIONES: este código espera tablas que la base no tiene. Corré `pnpm db:migrate` contra producción',
        )
      } else if (m.estado === 'no-verificable') {
        log.warn({ motivo: m.motivo }, 'no se pudo verificar si faltan migraciones')
      }
    })
    .catch((err: unknown) => {
      log.warn({ error: String(err) }, 'falló la revisión de migraciones')
    })

  void golpe()

  const reloj = setInterval(() => void golpe(), cada)
  // Sin `unref`, el intervalo mantiene vivo al proceso y demora el SIGTERM de un
  // redeploy hasta seis horas.
  reloj.unref()

  return () => clearInterval(reloj)
}
