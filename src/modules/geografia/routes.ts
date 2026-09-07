import type { FastifyInstance } from 'fastify'
import { requireAuth } from '@/modules/authz/middleware'
import { DEPARTAMENTOS, MUNICIPIOS } from './catalogo'

/**
 * El catálogo geográfico — M14.
 *
 * ── Solo pide sesión, ningún permiso ────────────────────────────────────────
 *
 * No es un dato de Aquazaku: es la división política de Colombia, publicada por
 * el DANE. Exigir un permiso para leerla sería tratar como secreto algo que
 * está en datos.gov.co.
 *
 * ── Los municipios se piden por departamento ────────────────────────────────
 *
 * Son 1122. Mandarlos todos a un desplegable haría que el navegador filtre una
 * lista donde el 98% nunca se va a elegir — Aquazaku reparte en Atlántico y sus
 * vecinos. Con el departamento elegido, la lista baja a dos docenas.
 */
export async function geografiaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/geografia/departamentos', { preHandler: [requireAuth] }, async () => DEPARTAMENTOS)

  app.get('/geografia/municipios', { preHandler: [requireAuth] }, async (req) => {
    const { departamento } = req.query as { departamento?: string }

    /*
     * Sin departamento se devuelven todos. Es lo que necesita quien todavía no
     * eligió uno —o quien busca «Suan» sin acordarse de en qué departamento
     * queda—, y son 1122 filas chicas.
     */
    if (!departamento) return MUNICIPIOS

    return MUNICIPIOS.filter((m) => m.departamento === departamento)
  })
}
