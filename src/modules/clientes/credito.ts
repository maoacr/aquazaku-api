import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Cliente, clientes } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { clientePorId } from './service'

/**
 * El crédito — RN-CLI-04, RN-CLI-12 y RN-CLI-15.
 *
 * ── El invariante lo sostiene la base; acá se EXPLICA ───────────────────────
 *
 * `clientes_credito_exige_verificacion` rechaza la fila. Este servicio chequea
 * lo mismo antes, no para garantizarlo —eso ya está garantizado— sino para que
 * el mensaje diga qué hacer en vez de dejar salir un error de Postgres que no
 * le sirve a nadie.
 *
 * Es la línea de ADR-0006: el invariante vive en la base, el servicio explica.
 */

export interface DatosDeCredito {
  habilitado: boolean
  /**
   * `null` es SIN TOPE, y es el default.
   *
   * RN-CLI-12: forzar un número hoy sería inventarlo. Pocos clientes tienen
   * crédito y los que lo tienen son confiables; el bloqueo por límite solo
   * aplica cuando alguien decidió un número.
   */
  limite?: number | null
}

export async function configurarCredito(
  id: string,
  datos: DatosDeCredito,
): Promise<Cliente> {
  const actual = await clientePorId(id)

  if (datos.habilitado && actual.verificacionEstado !== 'verificado') {
    throw new ErrorDeNegocio(
      'VERIFICACION_REQUERIDA',
      422,
      `no se le puede habilitar crédito a ${actual.nombre} hasta que alguien coteje su documento. Extender crédito a una identidad sin comprobar es justamente el riesgo que el crédito viene a acotar`,
    )
  }

  if (datos.limite !== undefined && datos.limite !== null && datos.limite <= 0) {
    throw new ErrorDeNegocio(
      'LIMITE_INVALIDO',
      422,
      'un límite de cero o menos no es un límite: es no tener crédito. Deje el campo vacío para no poner tope',
    )
  }

  const [cliente] = await db
    .update(clientes)
    .set({
      creditoHabilitado: datos.habilitado,
      /*
       * Deshabilitar borra el tope. Conservarlo dejaría un número guardado que
       * no aplica a nada, y el día que alguien vuelva a habilitar el crédito
       * heredaría en silencio un límite que nadie revisó.
       */
      ...(datos.habilitado
        ? { creditoLimite: datos.limite === undefined ? actual.creditoLimite : datos.limite?.toFixed(2) ?? null }
        : { creditoLimite: null }),
      updatedAt: new Date(),
    })
    .where(eq(clientes.id, id))
    .returning()

  return cliente!
}
