import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '@/db/client'
import { lineasDeVenta, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { scopedCondition } from '@/modules/authz/scoped-query'
import { anularVenta } from './anulacion'
import { cartera, cobrosDe, registrarCobro } from './cobros'
import { crearCodigo, desactivarCodigo, listarCodigos } from './descuentos'
import { devolucionesDe, registrarDevolucion } from './devoluciones'
import { deudaDe } from './saldo'
import {
  esquemaDeAnulacion,
  esquemaDeCobro,
  esquemaDeCodigo,
  esquemaDeDevolucion,
  esquemaDeVenta,
} from './validation'
import { registrarVenta } from './venta'

/**
 * Ventas, cobros, devoluciones y descuentos — M6.
 *
 * ── No hay forma de editar una venta ────────────────────────────────────────
 *
 * Ni `PATCH` ni `PUT` sobre una venta. Si está mal, se **anula** y se registra
 * una nueva (RN-VEN-02). Es la regla que más se pide romper por comodidad y la
 * que más caro sale romper: si el monto de ayer puede cambiar hoy, ningún
 * arqueo ni rendición es confiable.
 *
 * Que esas rutas no existan es parte del contrato, y hay tests que lo verifican.
 * La base tampoco lo permitiría — hay un trigger.
 *
 * ── El alcance lo resuelve la matriz, no la ruta ────────────────────────────
 *
 * `pos` y `seller` ven y anulan **lo propio**; `admin` ve y anula todo. Eso está
 * en la matriz desde M0 y acá solo se aplica: `scopedCondition` para las listas
 * y `puedeAnular` para la fila. La ruta no repite la regla — la usa.
 */
export async function ventasRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/ventas',
    { preHandler: [requireAuth, requirePermission('ventas', 'ver')] },
    async (req) => {
      /*
       * El recorte sale del alcance del usuario. `undefined` significa «sin
       * filtro» y solo ocurre con alcance `todo`: nunca es el resultado de que
       * algo salió mal.
       */
      const alcance = scopedCondition(req.user!, 'ventas', 'ver', {
        createdBy: ventas.registradoPor,
      })

      const consulta = db.select().from(ventas).orderBy(desc(ventas.createdAt)).limit(100)

      return alcance ? consulta.where(alcance) : consulta
    },
  )

  app.get(
    '/ventas/:id',
    { preHandler: [requireAuth, requirePermission('ventas', 'ver')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const [venta] = await db.select().from(ventas).where(eq(ventas.id, id))

      if (!venta) {
        return reply.code(404).send({ code: 'VENTA_NO_ENCONTRADA', mensaje: 'esa venta no existe' })
      }

      return {
        ...venta,
        lineas: await db.select().from(lineasDeVenta).where(eq(lineasDeVenta.ventaId, id)),
        devoluciones: await devolucionesDe(id),
      }
    },
  )

  app.post(
    '/ventas',
    { preHandler: [requireAuth, requirePermission('ventas', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeVenta, req.body, reply)
      if (!datos) return

      try {
        const resultado = await registrarVenta(
          { ...datos, hoy: hoyISO() },
          req.user?.id ?? null,
        )

        return reply.code(201).send(resultado)
      } catch (err) {
        return manejarError(err, req, reply, 'ventas:crear')
      }
    },
  )

  /**
   * Anular — RN-VEN-08.
   *
   * `POST` sobre un sub-recurso y no `DELETE` sobre la venta: la venta no se
   * borra, se le agrega un hecho. El verbo dice qué pasa de verdad.
   */
  app.post(
    '/ventas/:id/anulacion',
    { preHandler: [requireAuth, requirePermission('ventas', 'anular', { auditaLaRuta: true })] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeAnulacion, req.body, reply)
      if (!datos) return

      try {
        return await anularVenta(id, datos.motivo, req.user!)
      } catch (err) {
        return manejarError(err, req, reply, 'ventas:anular', id)
      }
    },
  )

  /**
   * Devoluciones — RN-VEN-10.
   *
   * Van bajo `ventas:crear` porque aceptar una devolución es una operación de
   * mostrador, como vender. No hay un recurso `devoluciones` en la matriz, y no
   * se inventa uno acá: si el negocio quiere restringirlas a `pos`, eso es un
   * cambio en la matriz —donde vive la regla— y no en esta ruta.
   */
  app.post(
    '/devoluciones',
    { preHandler: [requireAuth, requirePermission('ventas', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeDevolucion, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await registrarDevolucion(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'ventas:crear', datos.lineaId)
      }
    },
  )

  app.get(
    '/cobros',
    { preHandler: [requireAuth, requirePermission('cobros', 'ver')] },
    async (req) => {
      const { clienteId } = req.query as { clienteId?: string }

      return clienteId ? cobrosDe(clienteId) : cartera()
    },
  )

  app.post(
    '/cobros',
    { preHandler: [requireAuth, requirePermission('cobros', 'registrar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeCobro, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await registrarCobro(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'cobros:registrar', datos.clienteId)
      }
    },
  )

  /**
   * La deuda de un cliente — el número que M5 dejó en `null`.
   *
   * Va bajo `cobros:ver` y no `clientes:ver`: es información de cartera, y el
   * `seller` que ve clientes no necesariamente ve lo que deben.
   */
  app.get(
    '/clientes/:id/deuda',
    { preHandler: [requireAuth, requirePermission('cobros', 'ver')] },
    async (req) => {
      const { id } = req.params as { id: string }

      return { deuda: await deudaDe(id), cobros: await cobrosDe(id) }
    },
  )

  /* ── Códigos de descuento: solo admin — RN-VEN-13 ───────────────────────── */

  app.get(
    '/descuentos',
    { preHandler: [requireAuth, requirePermission('configuracion', 'ver')] },
    async (req) => {
      const soloVigentes = (req.query as { vigentes?: string }).vigentes === 'si'

      return listarCodigos(soloVigentes, hoyISO())
    },
  )

  app.post(
    '/descuentos',
    {
      preHandler: [
        requireAuth,
        requirePermission('configuracion', 'editar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeCodigo, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await crearCodigo(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'configuracion:editar')
      }
    },
  )

  /**
   * Desactivar, no borrar: una venta pasada lo referencia y sigue explicando
   * por qué costó lo que costó. `DELETE` está revocado en la base.
   */
  app.patch(
    '/descuentos/:id/desactivar',
    {
      preHandler: [
        requireAuth,
        requirePermission('configuracion', 'editar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        return await desactivarCodigo(id)
      } catch (err) {
        return manejarError(err, req, reply, 'configuracion:editar', id)
      }
    },
  )
}

/**
 * Hoy en `YYYY-MM-DD`.
 *
 * Los servicios lo reciben por parámetro para poder testear el borde del
 * vencimiento sin esperar a mañana. La ruta es el único lugar donde
 * corresponde leer el reloj.
 */
function hoyISO(): string {
  return new Date().toISOString().slice(0, 10)
}

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
      resource: action.startsWith('cobros') ? 'cobros' : action.startsWith('configuracion') ? 'configuracion' : 'ventas',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
