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
 * Cada quince minutos.
 *
 * ── Por qué no cada seis horas, que alcanzaría para Supabase ────────────────
 *
 * El latido hace DOS cosas: mantener el proyecto despierto —para lo que sobra
 * con un latido diario— y decir si la base responde. La segunda manda: un
 * estado que se refresca cada seis horas no sirve para saber si la base está
 * caída ahora.
 *
 * El costo es un `SELECT now()` cada quince minutos. Noventa y seis consultas
 * triviales por día no se notan en ninguna parte.
 */
const CADA = 15 * 60 * 1000

/**
 * Tres latidos perdidos antes de declarar que no hay contacto.
 *
 * ── Este número TIENE que ser mayor que `CADA` ─────────────────────────────
 *
 * La primera versión tenía el intervalo en seis horas y el umbral en treinta
 * minutos: `/health` decía «sin contacto» durante 5,5 de cada 6 horas **con
 * todo funcionando**. Un aviso que suena el 92% del tiempo enseña a ignorarlo,
 * que es exactamente lo que dice RN-STK-11 sobre los umbrales.
 *
 * Se descubrió mirando producción, no leyendo el código. Hay un test que ahora
 * fija la relación entre los dos números.
 */
const SIN_NOTICIAS = 3 * CADA

/**
 * Los dos números, expuestos para que un test los pueda atar.
 *
 * No son configurables: son una propiedad del latido, no una decisión del
 * negocio. Lo que sí tiene que quedar fijo es su RELACIÓN.
 */
export const RITMO = { cada: CADA, sinNoticias: SIN_NOTICIAS } as const

export interface EstadoDeLatido {
  ultimoContacto: Date | null
  ultimoError: string | null
  latidos: number
  /**
   * Se revisa en cada latido **mientras no esté al día**; una vez al día, nunca
   * más — ver `revisarEsquemaSiHaceFalta`.
   */
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

  /**
   * ¿El esquema es el que este código espera? — en cada latido, hasta que lo sea.
   *
   * ── Por qué se vuelve a revisar, y por qué igual es gratis ─────────────────
   *
   * La versión anterior revisaba **una sola vez, al arrancar**, con este
   * argumento: «las migraciones no se aplican solas mientras el proceso vive —
   * si alguien las corre, el redeploy vuelve a revisar».
   *
   * Es cierto y es insuficiente, y lo descubrimos en un despliegue real
   * (13-oct-2026). El campo `faltan` seguía apareciendo media hora después de
   * que la migración hubiera entrado bien, porque el proceso repetía la foto de
   * su arranque. O sea: **durante un incidente, `/health` no podía confirmar la
   * corrección**. Y es justo cuando uno lo mira.
   *
   * Un indicador que sigue gritando después de resuelto enseña a ignorarlo —
   * el mismo argumento que `SIN_NOTICIAS` ya tenía escrito unas líneas arriba.
   *
   * ── Una vez al día, no se vuelve a revisar ─────────────────────────────────
   *
   * No es una optimización: es que para ESTE proceso no puede volver a estar
   * pendiente. Las esperadas son fijas —el journal viaja dentro de la imagen— y
   * las aplicadas solo crecen. `al-dia` es un estado terminal.
   *
   * Por eso el costo en el caso sano es exactamente **una** consulta, la del
   * arranque. Se paga un `count(*)` cada quince minutos solo mientras hay algo
   * roto, que es cuando vale la pena.
   *
   * `no-verificable` SÍ se vuelve a revisar: puede ser un `GRANT` que falta
   * (migración 0013) y eso alguien lo arregla sin reiniciar nada.
   */
  const revisarEsquemaSiHaceFalta = async (): Promise<void> => {
    if (estado.migraciones?.estado === 'al-dia') return

    const antes = estado.migraciones?.estado

    try {
      const m = await revisarMigraciones()
      estado.migraciones = m

      if (m.estado === 'pendientes') {
        log.warn(
          { faltan: m.faltan },
          'FALTAN MIGRACIONES: este código espera tablas que la base no tiene. Corré `pnpm db:migrate` contra producción',
        )
      } else if (m.estado === 'no-verificable') {
        log.warn({ motivo: m.motivo }, 'no se pudo verificar si faltan migraciones')
      } else if (antes !== undefined) {
        /*
         * La transición se anuncia. Sin esto, el log muestra cuándo empezó el
         * problema y nunca cuándo terminó, y hay que deducirlo del silencio.
         */
        log.info(
          { desde: antes },
          'el esquema quedó al día: las migraciones que faltaban ya están aplicadas',
        )
      }
    } catch (err: unknown) {
      log.warn({ error: String(err) }, 'falló la revisión de migraciones')
    }
  }

  const golpeYEsquema = async (): Promise<void> => {
    await golpe()
    await revisarEsquemaSiHaceFalta()
  }

  void golpeYEsquema()

  const reloj = setInterval(() => void golpeYEsquema(), cada)
  // Sin `unref`, el intervalo mantiene vivo al proceso y demora el SIGTERM de un
  // redeploy hasta seis horas.
  reloj.unref()

  return () => clearInterval(reloj)
}
