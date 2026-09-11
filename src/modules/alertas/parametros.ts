import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { parametros } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'

/**
 * Los umbrales de las alertas — M12.
 *
 * ── Por qué no hay valor por defecto en el código ───────────────────────────
 *
 * `RN-STK-11` es explícito: la constante **se va**, no queda como default. Un
 * default en el código y una fila en la base son dos lugares donde configurar
 * lo mismo, y el día que discrepen nadie va a saber cuál está mandando.
 *
 * Las filas nacen en la migración `0012`, así que existen siempre. Si una
 * faltara, esto **falla ruidoso** en vez de inventar un número: una alerta
 * calibrada con un valor que nadie eligió es peor que una alerta rota, porque
 * parece que funciona.
 */

/**
 * Los valores con los que nace cada parámetro — espejo de la migración `0012`.
 *
 * Existe para que `resetDb` pueda devolver la base al estado de recién migrada:
 * `parametros.actualizado_por` referencia a `users`, así que un
 * `TRUNCATE users CASCADE` se los lleva, y el código los lee sin alternativa.
 *
 * Es una lista espejo, con el riesgo que eso trae. Por eso hay un test que
 * compara esto contra lo que la migración dejó en la base: si alguien agrega un
 * parámetro en el SQL y se olvida de acá, se entera al correr los tests y no
 * meses después.
 */
export const PARAMETROS_INICIALES = [
  { clave: 'dias_aviso_vencimiento', valor: 7 },
  { clave: 'dias_entrega_bases', valor: 7 },
  { clave: 'dias_recompra_aviso', valor: 5 },
  { clave: 'dias_recompra_urgente', valor: 8 },
] as const

/** Las claves que el código conoce. Pedir otra es un error de tipos. */
export type ClaveDeParametro =
  | 'dias_aviso_vencimiento'
  | 'dias_entrega_bases'
  /*
   * Los dos de recompra van juntos y en ese orden: `aviso` abre la franja «por
   * llamar» y `urgente` la corta. Un trigger de la migración 0017 impide que se
   * crucen — con `aviso >= urgente` no queda ninguna franja intermedia y el
   * panel muestra a todos como urgentes, que es dejar de priorizar.
   */
  | 'dias_recompra_aviso'
  | 'dias_recompra_urgente'

export interface Parametro {
  clave: string
  valor: number
  minimo: number
  maximo: number
  etiqueta: string
  ayuda: string
  unidad: string
  actualizadoEn: Date
}

export async function listarParametros(): Promise<Parametro[]> {
  return db.select().from(parametros).orderBy(asc(parametros.clave))
}

/**
 * El valor de un umbral.
 *
 * Tira si la clave no existe. No devuelve `null` ni un default: quien llama
 * necesita un número para decidir si algo se avisa, y el único fallback honesto
 * ante una base incompleta es no responder.
 */
export async function leerParametro(clave: ClaveDeParametro): Promise<number> {
  const [fila] = await db
    .select({ valor: parametros.valor })
    .from(parametros)
    .where(eq(parametros.clave, clave))

  if (!fila) {
    throw new ErrorDeNegocio(
      'PARAMETRO_FALTANTE',
      500,
      `falta el parámetro «${clave}»: lo crea la migración 0012, así que la base está incompleta`,
    )
  }

  return fila.valor
}

/**
 * Cambia un umbral.
 *
 * ── El rango se valida acá Y en la base ─────────────────────────────────────
 *
 * El CHECK de la migración es la garantía; esto es la explicación. Sin el
 * mensaje, un valor fuera de rango llegaría como un error de constraint que
 * nadie puede leer — y quien lo escribió no sabría entre qué y qué puede
 * moverse (ADR-0006).
 */
export async function cambiarParametro(clave: string, valor: number): Promise<Parametro> {
  const [actual] = await db.select().from(parametros).where(eq(parametros.clave, clave))

  if (!actual) {
    throw new ErrorDeNegocio('PARAMETRO_DESCONOCIDO', 404, `no existe el parámetro «${clave}»`)
  }

  if (valor < actual.minimo || valor > actual.maximo) {
    throw new ErrorDeNegocio(
      'PARAMETRO_FUERA_DE_RANGO',
      422,
      `«${actual.etiqueta}» va entre ${actual.minimo} y ${actual.maximo} ${actual.unidad}. ` +
        `Un umbral en ${valor} ${valor < actual.minimo ? 'apagaría el aviso' : 'lo dejaría siempre encendido'}, y las dos formas se ven igual desde afuera: nadie reacciona.`,
    )
  }

  const [nuevo] = await db
    .update(parametros)
    .set({ valor, actualizadoEn: new Date() })
    .where(eq(parametros.clave, clave))
    .returning()

  return nuevo!
}
