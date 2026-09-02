import type { FastifyInstance } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { carteraPorEdad } from './cartera'
import { extracto } from './extracto'
import { resumenMensual } from './mensual'
import { esquemaDeExtracto, esquemaDeResumenMensual } from './validation'

/**
 * Lo que consulta el contador — M11.
 *
 * ── Solo lectura, y por eso no audita ───────────────────────────────────────
 *
 * Ninguna ruta acá cambia nada. `auditaLaRuta` existe para dejar rastro de
 * acciones sensibles ([ADR-0007](/decisiones/0007-auditoria-bloqueante/)), y una
 * consulta no lo es: anotar cada vez que alguien mira un reporte llenaría la
 * bitácora de ruido y haría más difícil encontrar lo que sí importa.
 *
 * ── Los permisos ya existían ────────────────────────────────────────────────
 *
 * `reportes:financieros` y `reportes:operativos` están en la matriz desde M0.
 * Este módulo no agrega ninguno: construye los endpoints que esa matriz ya
 * preveía.
 */
export async function contadorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * El extracto de movimientos de plata — RN-CON-03 y 04.
   *
   * Va bajo `financieros` y no bajo `operativos`: muestra montos y medios de
   * pago. La distinción existe en la matriz porque el `pos` tiene
   * `operativos` en preparación y NO debería ver la plata del negocio.
   */
  app.get(
    '/reportes/extracto',
    { preHandler: [requireAuth, requirePermission('reportes', 'financieros')] },
    async (req, reply) => {
      const datos = validar(esquemaDeExtracto, req.query, reply)
      if (!datos) return

      try {
        return await extracto({
          desde: datos.desde,
          hasta: datos.hasta,
          /*
           * Los tipos llegan separados por coma —`?tipos=venta,cobro`— porque
           * es una query string, no un cuerpo JSON. Sin ninguno, vienen todos.
           */
          ...(datos.tipos && { tipos: datos.tipos.split(',') as never }),
        })
      } catch (err) {
        /*
         * Se traduce el error de negocio y NO se audita: es una consulta, no
         * una acción sensible (ADR-0007). Anotar cada rango mal escrito
         * llenaría la bitácora de ruido.
         */
        if (err instanceof ErrorDeNegocio) {
          return reply.code(err.status).send({ code: err.code, mensaje: err.message })
        }
        throw err
      }
    },
  )

  /**
   * Cartera por edad — RN-CON-05.
   *
   * `hoy` lo pone la ruta y no el cliente: es el único lugar donde corresponde
   * leer el reloj, y dejarlo entrar por parámetro permitiría pedir una cartera
   * «al 30 de junio» que el servicio no puede calcular bien —los cobros
   * posteriores ya están imputados—.
   */
  app.get(
    '/reportes/cartera',
    { preHandler: [requireAuth, requirePermission('reportes', 'financieros')] },
    async () => carteraPorEdad(hoyISO()),
  )

  /**
   * El resumen mensual — RN-CON-07.
   *
   * Una fila por mes con sus totales. Responde «cómo viene el año», que el
   * extracto no contesta sin pedirlo doce veces y sumar a mano.
   */
  app.get(
    '/reportes/mensual',
    { preHandler: [requireAuth, requirePermission('reportes', 'financieros')] },
    async (req, reply) => {
      const datos = validar(esquemaDeResumenMensual, req.query, reply)
      if (!datos) return

      try {
        return await resumenMensual(datos)
      } catch (err) {
        if (err instanceof ErrorDeNegocio) {
          return reply.code(err.status).send({ code: err.code, mensaje: err.message })
        }
        throw err
      }
    },
  )
}

/** Hoy en `YYYY-MM-DD`. El servicio lo recibe para poder testear los bordes. */
function hoyISO(): string {
  return new Date().toISOString().slice(0, 10)
}
