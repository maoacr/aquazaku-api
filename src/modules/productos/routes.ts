import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { emit } from '@/modules/authz/audit'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import {
  buscarProducto,
  crearProducto,
  desactivarProducto,
  editarPrecios,
  editarProducto,
  listarProductos,
  reactivarProducto,
} from './service'
import {
  esquemaAltaDeProducto,
  esquemaDeFiltro,
  esquemaDePrecios,
  esquemaEdicionDeProducto,
} from './validation'

/**
 * Catálogo de productos — RN-CAT-01 a 11.
 *
 * Los cuatro roles LEEN: un `pos` que no ve precios no puede vender. Escribir
 * es exclusivo de `admin` (RN-CAT-06), y el middleware es quien lo hace
 * cumplir — ocultar el botón en la UI no es seguridad (RN-ACC-02).
 *
 * No hay `DELETE` en ninguna ruta. Un producto se desactiva (RN-CAT-02), y eso
 * ya está garantizado en tres capas: la base le revocó el privilegio al rol de
 * la aplicación, el servicio no expone el método, y acá no existe el endpoint.
 */
export async function productoRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/productos',
    { preHandler: [requireAuth, requirePermission('productos', 'ver')] },
    async (req, reply) => {
      const filtro = validar(esquemaDeFiltro, req.query ?? {}, reply)
      if (!filtro) return

      return listarProductos(filtro.estado)
    },
  )

  app.get(
    '/productos/:id',
    { preHandler: [requireAuth, requirePermission('productos', 'ver')] },
    async (req, reply) => {
      const producto = await buscarProducto(idDe(req))
      if (!producto) return reply.code(404).send({ code: 'PRODUCTO_NO_ENCONTRADO' })

      return producto
    },
  )

  app.post(
    '/productos',
    { preHandler: [requireAuth, requirePermission('productos', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaAltaDeProducto, req.body, reply)
      if (!datos) return

      try {
        const producto = await crearProducto(datos)

        await auditar(req, 'productos:crear', producto.id, { codigo: producto.codigo, nombre: producto.nombre })

        return reply.code(201).send(producto)
      } catch (err) {
        return manejarError(err, req, reply, 'productos:crear')
      }
    },
  )

  app.patch(
    '/productos/:id',
    { preHandler: [requireAuth, requirePermission('productos', 'editar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = idDe(req)
      const datos = validar(esquemaEdicionDeProducto, req.body, reply)
      if (!datos) return

      try {
        return await editarProducto(id, datos)
      } catch (err) {
        return manejarError(err, req, reply, 'productos:editar', id)
      }
    },
  )

  /**
   * Cambiar precios es su propia ruta y su propio permiso.
   *
   * Si viviera dentro del PATCH general, `productos:editar` daría acceso a lo
   * que `productos:editar_precios` protege, y la matriz dejaría de significar
   * lo que dice.
   *
   * El servicio escribe la bitácora con el antes y el después: acá no se
   * duplica.
   */
  app.patch(
    '/productos/:id/precios',
    {
      preHandler: [
        requireAuth,
        requirePermission('productos', 'editar_precios', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const id = idDe(req)
      const datos = validar(esquemaDePrecios, req.body, reply)
      if (!datos) return

      try {
        return await editarPrecios(id, datos, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        })
      } catch (err) {
        return manejarError(err, req, reply, 'productos:editar_precios', id)
      }
    },
  )

  /**
   * `POST` y no `DELETE`, a propósito.
   *
   * Un `DELETE /productos/:id` diría que el producto desaparece, y eso es
   * justamente lo que RN-CAT-02 prohíbe. El verbo tiene que contar la verdad de
   * lo que pasa.
   */
  app.post(
    '/productos/:id/desactivar',
    {
      preHandler: [requireAuth, requirePermission('productos', 'desactivar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const id = idDe(req)

      try {
        const producto = await desactivarProducto(id)

        await auditar(req, 'productos:desactivar', id, { codigo: producto.codigo })

        return producto
      } catch (err) {
        return manejarError(err, req, reply, 'productos:desactivar', id)
      }
    },
  )

  app.post(
    '/productos/:id/reactivar',
    {
      preHandler: [requireAuth, requirePermission('productos', 'desactivar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const id = idDe(req)

      try {
        const producto = await reactivarProducto(id)

        await auditar(req, 'productos:reactivar', id, { codigo: producto.codigo })

        return producto
      } catch (err) {
        return manejarError(err, req, reply, 'productos:reactivar', id)
      }
    },
  )
}

function idDe(req: FastifyRequest): string {
  return (req.params as { id: string }).id
}

/**
 * Escribe en la bitácora una acción sobre el catálogo. **Bloqueante**.
 *
 * No usa `auditarSinBloquear`: esa existe para eventos de sesión y se traga los
 * fallos a propósito, porque una bitácora caída no debería impedir entrar al
 * sistema. Acá es al revés — RN-ACC-04 nombra los cambios de precio entre las
 * acciones sensibles, y un precio que cambia sin dejar rastro es exactamente lo
 * que la regla existe para impedir.
 *
 * Si no se puede auditar, la operación falla. Misma regla que en
 * `requirePermission`.
 */
async function auditar(
  req: FastifyRequest,
  action: string,
  resourceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await emit({
    userId: req.user?.id ?? null,
    rolEjercido: req.user?.roles ?? [],
    action,
    resource: 'productos',
    resourceId,
    result: 'ok',
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    payload,
  })
}

/**
 * Traduce un error de negocio a HTTP y deja el intento fallido en la bitácora.
 *
 * Registrar el rechazo importa tanto como registrar el éxito: alguien
 * intentando bajar un precio por debajo del piso una y otra vez es exactamente
 * el tipo de patrón que hay que poder ver después.
 */
async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
  resourceId = '(nuevo)',
): Promise<FastifyReply> {
  if (err instanceof ErrorDeNegocio) {
    await auditarSinBloquear(req, {
      userId: req.user?.id ?? null,
      rolEjercido: req.user?.roles ?? [],
      action,
      resource: 'productos',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
