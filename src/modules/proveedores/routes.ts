import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { comprasVencidas, marcarPagada, registrarCompra } from './compras'
import { cambiarEstado, crearProveedor, listarProveedores } from './service'
import { esquemaDeCompra, esquemaDeEstado, esquemaDeProveedor } from './validation'
import { hoyEnLaPlanta } from '@/lib/dia'

/**
 * Proveedores y compras — M9.
 *
 * ── El `pos` compra, pero no da de alta proveedores ─────────────────────────
 *
 * Lo dice la matriz desde M0 y tiene sentido operativo: quien recibe la
 * mercadería en la planta registra lo que llegó, pero abrir un proveedor nuevo
 * es una decisión del negocio, no del mostrador.
 *
 * ── Las cinco rutas se auditan solas ────────────────────────────────────────
 *
 * Todas llevan `auditaLaRuta: true` y emiten su propia fila DESPUÉS del
 * commit, porque la fila automática del middleware solo alcanza a decir que
 * algo pasó: llegaba con `payload` en NULL. Una compra es dinero que SALE —
 * sin el proveedor y el total, la bitácora no sirve para conciliar.
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
      preHandler: [
        requireAuth,
        requirePermission('proveedores', 'crear', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeProveedor, req.body, reply)
      if (!datos) return

      try {
        const creado = await crearProveedor(datos)

        /*
         * El NIT es lo que hace rastreable al proveedor en la contabilidad, y
         * es el campo que el servicio protege contra duplicados: si mañana
         * aparecen dos filas con el mismo NIT, esta es la que dice cuál se
         * cargó primero y quién la cargó.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'proveedores:crear',
          resource: 'proveedores',
          result: 'ok',
          payload: {
            resourceId: creado.id,
            nombre: creado.nombre,
            nit: creado.nit,
            contacto: creado.contacto,
          },
        })

        return reply.code(201).send(creado)
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
      preHandler: [
        requireAuth,
        requirePermission('proveedores', 'editar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeEstado, req.body, reply)
      if (!datos) return

      try {
        const cambiado = await cambiarEstado(id, datos.activo)

        /*
         * Los dos sentidos comparten acción porque comparten ruta, y el payload
         * dice en cuál quedó. Importa el sentido, no solo que «se editó»:
         * desactivar cierra la puerta a comprarle, y reactivar la vuelve a
         * abrir.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'proveedores:editar',
          resource: 'proveedores',
          result: 'ok',
          payload: {
            resourceId: cambiado.id,
            nombre: cambiado.nombre,
            activo: cambiado.activo,
          },
        })

        return cambiado
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
        const resultado = await registrarCompra(datos, req.user?.id ?? null)

        /*
         * Registrar la compra y marcarla pagada comparten `compras:crear`
         * porque comparten permiso. Las separa `operacion`: la primera abre una
         * deuda, la segunda la cierra. Sin eso, una compra a crédito y su pago
         * se leen como dos compras.
         *
         * El total va congelado (RN-PRO-04) y el vencimiento también: son los
         * dos datos con los que se concilia lo que se le debe a un proveedor,
         * y recalcularlos desde las líneas tres meses después da otro número
         * si cambió un costo.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'compras:crear',
          resource: 'compras',
          result: 'ok',
          payload: {
            operacion: 'registrar',
            resourceId: resultado.compra.id,
            proveedorId: resultado.compra.proveedorId,
            medioDePago: resultado.compra.medioDePago,
            total: resultado.compra.total,
            venceEl: resultado.compra.venceEl,
            lineas: resultado.lineas.length,
          },
        })

        return reply.code(201).send(resultado)
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
   *
   * Por eso lleva `auditaLaRuta: true` y NO emite: es una lectura pura bajo un
   * permiso de escritura. Sin la exención, cada vez que alguien revisa qué se
   * le debe a los proveedores queda una fila `compras:crear` indistinguible de
   * una compra de verdad. Es el segundo caso del sistema, después de
   * `GET /bases/proximo-codigo`; en cualquier otra ruta, no emitir es el
   * defecto que `opt-out-de-auditoria.test.ts` vigila.
   */
  app.get(
    '/compras/vencidas',
    { preHandler: [requireAuth, requirePermission('compras', 'crear', { auditaLaRuta: true })] },
    async () => comprasVencidas(hoyEnLaPlanta()),
  )

  app.post(
    '/compras/:id/pago',
    { preHandler: [requireAuth, requirePermission('compras', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        const pagada = await marcarPagada(id)

        /* El otro lado de `operacion`: acá se cierra la deuda. El total va
         * repetido a propósito —es el de la compra, congelado— para que la fila
         * del pago se lea sola, sin ir a buscar la de la compra. */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'compras:crear',
          resource: 'compras',
          result: 'ok',
          payload: {
            operacion: 'pago',
            resourceId: pagada.id,
            proveedorId: pagada.proveedorId,
            total: pagada.total,
          },
        })

        return pagada
      } catch (err) {
        return manejarError(err, req, reply, 'compras', 'compras:crear', id)
      }
    },
  )
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
