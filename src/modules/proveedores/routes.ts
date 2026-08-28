import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { comprasVencidas, marcarPagada, registrarCompra } from './compras'
import { cambiarEstado, crearProveedor, listarProveedores } from './service'
import { esquemaDeCompra, esquemaDeEstado, esquemaDeProveedor } from './validation'

/**
 * Proveedores y compras — M9.
 *
 * ── El `pos` compra, pero no da de alta proveedores ─────────────────────────
 *
 * Lo dice la matriz desde M0 y tiene sentido operativo: quien recibe la
 * mercadería en la planta registra lo que llegó, pero abrir un proveedor nuevo
 * es una decisión del negocio, no del mostrador.
 */
export async function proveedoresRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/proveedores',
    { preHandler: [requireAuth, requirePermission('proveedores', 'ver')] },
    async (req) => {
      const { incluirInactivos } = req.query as { incluirInactivos?: string }
      return listarProveedores(incluirInactivos === 'si')
    },
  )

  app.post(
    '/proveedores',
    {
      preHandler: [requireAuth, requirePermission('proveedores', 'crear', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeProveedor, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await crearProveedor(datos))
      } catch (err) {
        return manejarError(err, req, reply, 'proveedores', 'proveedores:crear')
      }
    },
  )

  /**
   * Activar o desactivar — RN-PRO-01.
   *
   * Una sola ruta para los dos sentidos porque son la misma operación con
   * distinto valor. Reactivar existe porque el caso real es «le volvimos a
   * comprar»: la compra a un inactivo se rechaza, y el camino correcto es
   * reactivarlo en vez de crear un duplicado con el mismo NIT.
   */
  app.patch(
    '/proveedores/:id/estado',
    {
      preHandler: [requireAuth, requirePermission('proveedores', 'editar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeEstado, req.body, reply)
      if (!datos) return

      try {
        return await cambiarEstado(id, datos.activo)
      } catch (err) {
        return manejarError(err, req, reply, 'proveedores', 'proveedores:editar', id)
      }
    },
  )

  app.post(
    '/compras',
    { preHandler: [requireAuth, requirePermission('compras', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeCompra, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await registrarCompra(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'compras', 'compras:crear')
      }
    },
  )

  /**
   * Lo vencido — RN-PRO-07.
   *
   * Va bajo `compras:crear` y no bajo un permiso de lectura porque no existe
   * `compras:ver` en la matriz, y no se inventa uno desde una ruta (ADR-0003):
   * quien registra las compras es quien tiene que saber cuáles vencieron.
   *
   * El día que el `contador` necesite verlas, es un cambio en la matriz.
   */
  app.get(
    '/compras/vencidas',
    { preHandler: [requireAuth, requirePermission('compras', 'crear')] },
    async () => comprasVencidas(hoyISO()),
  )

  app.post(
    '/compras/:id/pago',
    { preHandler: [requireAuth, requirePermission('compras', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        return await marcarPagada(id)
      } catch (err) {
        return manejarError(err, req, reply, 'compras', 'compras:crear', id)
      }
    },
  )
}

/**
 * Hoy en `YYYY-MM-DD`.
 *
 * El servicio lo recibe por parámetro para poder testear el borde del
 * vencimiento sin esperar a mañana. La ruta es el único lugar donde corresponde
 * leer el reloj.
 */
function hoyISO(): string {
  return new Date().toISOString().slice(0, 10)
}

async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  resource: 'proveedores' | 'compras',
  action: string,
  resourceId = '(nuevo)',
): Promise<FastifyReply> {
  if (err instanceof ErrorDeNegocio) {
    await auditarSinBloquear(req, {
      userId: req.user?.id ?? null,
      rolEjercido: req.user?.roles ?? [],
      action,
      resource,
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
