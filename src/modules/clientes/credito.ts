import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'
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
  contexto: ContextoDeAuditoria,
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

  /*
   * ── El cambio y su fila, una sola escritura — ADR-0007 ────────────────────
   *
   * Habilitar crédito es de las acciones que la ADR nombra sensibles: sin
   * bitácora, **no se ejecuta**. Emitir después del `UPDATE` no puede dar eso
   * —si el INSERT falla, el crédito ya quedó habilitado y lo único que se
   * devuelve es un 500— así que las dos van en la misma transacción: si una se
   * cae, el rollback se lleva la otra.
   *
   * Por eso el emit vive acá y no en la ruta: la transacción es de este
   * servicio, y la ruta no la tiene.
   */
  return db.transaction(async (tx) => {
    const [cliente] = await tx
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

    /*
     * El TOPE es la pregunta de auditoría de este módulo. Sin él, una deuda que
     * creció sin control no se puede explicar: no se sabe si alguien subió el
     * límite o si nunca hubo uno — y `null` es «sin tope», que es el default
     * (RN-CLI-12).
     *
     * Se lee del cliente devuelto y no de `datos`: deshabilitar borra el tope,
     * así que lo que quedó guardado no siempre es lo que se mandó.
     */
    await emit(
      {
        ...contexto,
        action: 'clientes:habilitar_credito',
        resource: 'clientes',
        resourceId: cliente!.id,
        result: 'ok',
        payload: {
          resourceId: cliente!.id,
          habilitado: cliente!.creditoHabilitado,
          limite: cliente!.creditoLimite,
        },
      },
      tx,
    )

    return cliente!
  })
}
