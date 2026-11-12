import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hoyEnLaPlanta } from '@/lib/dia'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { cambiarEstadoDeCuenta, crearCuentaBancaria, cuentasConSaldo } from './cuentas'
import {
  anularMovimiento,
  gastosPorTipo,
  listarMovimientos,
  registrarEgreso,
  registrarIngreso,
  registrarSaldoInicial,
} from './libro'
import {
  esquemaDeAnulacion,
  esquemaDeCuentaBancaria,
  esquemaDeEgreso,
  esquemaDeEstadoDeCuenta,
  esquemaDeIngreso,
  esquemaDeSaldoInicial,
} from './validation'

/**
 * Gastos y tesorería — M16.
 *
 * ── Todas las escrituras emiten su propia fila ──────────────────────────────
 *
 * Llevan `auditaLaRuta: true` y la bitácora la escribe el SERVICIO, dentro de
 * su transacción (ADR-0007). La fila automática del middleware alcanza para
 * decir que algo pasó, pero llega con `payload` en NULL: un movimiento de plata
 * sin la cuenta, el monto y el saldo resultante no sirve para reconstruir un
 * descuadre, que es lo único para lo que se va a leer.
 */
export async function gastosRoutes(app: FastifyInstance): Promise<void> {
  const contextoDe = (req: FastifyRequest) => ({
    userId: req.user?.id ?? null,
    rolEjercido: req.user?.roles ?? [],
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  })

  // ── Cuentas ───────────────────────────────────────────────────────────────

  /**
   * Las cuentas con su saldo — la pantalla abre con esto.
   *
   * El saldo viaja acá y no en un endpoint aparte porque son el mismo dato: una
   * cuenta sin su saldo no se puede mostrar en una lista de tesorería, y dos
   * llamadas dejarían la pantalla capaz de pintar un saldo de una carga vieja
   * al lado de una cuenta de la nueva.
   */
  app.get(
    '/cuentas',
    { preHandler: [requireAuth, requirePermission('cuentas', 'ver')] },
    async (req) => {
      const { incluirInactivas } = req.query as { incluirInactivas?: string }
      return cuentasConSaldo(incluirInactivas === 'si')
    },
  )

  app.post(
    '/cuentas',
    { preHandler: [requireAuth, requirePermission('cuentas', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeCuentaBancaria, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const creada = await crearCuentaBancaria(datos, contextoDe(req))
        return reply.code(201).send(creada)
      } catch (err) {
        return manejarError(err, req, reply, 'cuentas', 'cuentas:crear')
      }
    },
  )

  /**
   * Activar o desactivar — una sola ruta para los dos sentidos.
   *
   * El permiso se elige por el sentido: desactivar es lo que esconde una cuenta
   * de la pantalla, así que va bajo `desactivar`; reactivar es una corrección de
   * configuración y va bajo `editar`. Hoy el `admin` tiene los dos, pero la
   * bitácora los distingue, y el día que alguien más pueda reactivar sin poder
   * cerrar, la matriz ya lo expresa.
   */
  app.patch(
    '/cuentas/:id/estado',
    {
      preHandler: [
        requireAuth,
        requirePermission('cuentas', 'desactivar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeEstadoDeCuenta, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        return await cambiarEstadoDeCuenta(id, datos.activa, contextoDe(req))
      } catch (err) {
        return manejarError(err, req, reply, 'cuentas', 'cuentas:desactivar', id)
      }
    },
  )

  // ── El libro ──────────────────────────────────────────────────────────────

  app.get(
    '/gastos/movimientos',
    { preHandler: [requireAuth, requirePermission('gastos', 'ver')] },
    async (req) => {
      const q = req.query as {
        cuentaId?: string
        desde?: string
        hasta?: string
        tipo?: 'egreso' | 'ingreso' | 'saldo_inicial'
        incluirAnulados?: string
      }

      return listarMovimientos({
        cuentaId: q.cuentaId,
        desde: q.desde,
        hasta: q.hasta,
        tipo: q.tipo,
        incluirAnulados: q.incluirAnulados === 'si',
      })
    },
  )

  /**
   * En qué se gastó la plata del período.
   *
   * Sin `desde`/`hasta` contesta por el mes corriente, calculado con la fecha de
   * la planta: pedirle a la pantalla que arme el rango dejaría que el browser
   * del usuario —en otra zona horaria— pida un mes que no es el del negocio.
   */
  app.get(
    '/gastos/por-tipo',
    { preHandler: [requireAuth, requirePermission('gastos', 'ver')] },
    async (req) => {
      const { desde, hasta } = req.query as { desde?: string; hasta?: string }
      const hoy = hoyEnLaPlanta()

      return gastosPorTipo(desde ?? `${hoy.slice(0, 7)}-01`, hasta ?? hoy)
    },
  )

  app.post(
    '/gastos/egresos',
    { preHandler: [requireAuth, requirePermission('gastos', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeEgreso, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const creado = await registrarEgreso(datos, req.user?.id ?? null, contextoDe(req))
        return reply.code(201).send(creado)
      } catch (err) {
        return manejarError(err, req, reply, 'gastos', 'gastos:crear')
      }
    },
  )

  app.post(
    '/gastos/ingresos',
    { preHandler: [requireAuth, requirePermission('gastos', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeIngreso, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const creado = await registrarIngreso(datos, req.user?.id ?? null, contextoDe(req))
        return reply.code(201).send(creado)
      } catch (err) {
        return manejarError(err, req, reply, 'gastos', 'gastos:crear')
      }
    },
  )

  app.post(
    '/gastos/saldo-inicial',
    { preHandler: [requireAuth, requirePermission('gastos', 'crear', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeSaldoInicial, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const creado = await registrarSaldoInicial(datos, req.user?.id ?? null, contextoDe(req))
        return reply.code(201).send(creado)
      } catch (err) {
        return manejarError(err, req, reply, 'gastos', 'gastos:crear')
      }
    },
  )

  app.post(
    '/gastos/movimientos/:id/anulacion',
    { preHandler: [requireAuth, requirePermission('gastos', 'anular', { auditaLaRuta: true })] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeAnulacion, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        return await anularMovimiento(id, datos.motivo, contextoDe(req))
      } catch (err) {
        return manejarError(err, req, reply, 'gastos', 'gastos:anular', id)
      }
    },
  )
}

async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  resource: 'gastos' | 'cuentas',
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
