import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { configurarCredito } from './credito'
import { agregarDireccion, desactivarDireccion, direccionesDe } from './direcciones'
import { documentoParaMostrar } from './documento'
import {
  cambiarEstado,
  clientePorId,
  crearCliente,
  editarCliente,
  listarClientes,
} from './service'
import {
  esquemaDeAlta,
  esquemaDeCredito,
  esquemaDeDireccion,
  esquemaDeEdicion,
  esquemaDeEstado,
  esquemaDeReversion,
} from './validation'
import { revertirVerificacion, verificarDocumento } from './verificacion'

/**
 * Clientes — M5.
 *
 * ── No hay DELETE ──────────────────────────────────────────────────────────
 *
 * Un cliente no se borra (RN-CLI-02): se desactiva con `PATCH /:id/estado`.
 * Borrarlo dejaría ventas y botellones apuntando a nadie, y la deuda sin dueño.
 * La base también lo impide — `DELETE` está revocado.
 *
 * ── El documento se muestra armado, se guarda pelado ────────────────────────
 *
 * Lo que viaja en la respuesta lleva el DV calculado (`900123456-8`) porque es
 * como se escribe un NIT. Lo que está en la base es el número base: el DV es
 * una función de ese número y guardarlo abriría la puerta a que las dos copias
 * digan cosas distintas.
 */
export async function clientesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/clientes',
    { preHandler: [requireAuth, requirePermission('clientes', 'ver')] },
    async (req) => {
      const todos = (req.query as { estado?: string }).estado === 'todos'

      return (await listarClientes(!todos)).map(conDocumento)
    },
  )

  app.get(
    '/clientes/:id',
    { preHandler: [requireAuth, requirePermission('clientes', 'ver')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        const cliente = await clientePorId(id)

        return {
          ...conDocumento(cliente),
          direcciones: await direccionesDe(id),
          /*
           * Los cuatro saldos de RN-CLI-06 todavía no tienen de dónde salir:
           * deuda y cargos son M6, botellones y bases son M7.
           *
           * Se devuelve `null` y no cero. Un cero diría «este cliente no debe
           * nada», y la verdad es «todavía no existe el módulo que registra
           * deudas». Es el mismo criterio que dejó el caudal sin medir en `null`.
           */
          saldos: {
            deuda: null,
            botellones: null,
            bases: null,
            cargosPendientes: null,
          },
        }
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:ver', id)
      }
    },
  )

  app.post(
    '/clientes',
    {
      preHandler: [requireAuth, requirePermission('clientes', 'crear', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeAlta, req.body, reply)
      if (!datos) return

      try {
        const { cliente, aviso } = await crearCliente(datos)

        return reply.code(201).send({ ...conDocumento(cliente), aviso })
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:crear')
      }
    },
  )

  app.patch(
    '/clientes/:id',
    {
      preHandler: [requireAuth, requirePermission('clientes', 'editar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeEdicion, req.body, reply)
      if (!datos) return

      try {
        const { cliente, aviso } = await editarCliente(id, datos)

        return { ...conDocumento(cliente), aviso }
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:editar', id)
      }
    },
  )

  app.patch(
    '/clientes/:id/estado',
    {
      preHandler: [requireAuth, requirePermission('clientes', 'editar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeEstado, req.body, reply)
      if (!datos) return

      try {
        return conDocumento(await cambiarEstado(id, datos.activo))
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:editar', id)
      }
    },
  )

  /**
   * Verificar el documento — RN-CLI-14.
   *
   * El cuerpo NO lleva el método: se deriva del rol de quien verifica. Si
   * viniera del pedido, un `seller` podría marcar `admin_oficial` y darle a su
   * cotejo en la calle el peso de una validación contra documento oficial.
   */
  app.post(
    '/clientes/:id/verificacion',
    {
      preHandler: [
        requireAuth,
        requirePermission('clientes', 'verificar_documento', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        return conDocumento(
          await verificarDocumento(id, req.user?.id ?? null, req.user?.roles ?? []),
        )
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:verificar_documento', id)
      }
    },
  )

  app.delete(
    '/clientes/:id/verificacion',
    {
      preHandler: [
        requireAuth,
        requirePermission('clientes', 'verificar_documento', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeReversion, req.body, reply)
      if (!datos) return

      try {
        return conDocumento(await revertirVerificacion(id, datos.motivo))
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:verificar_documento', id)
      }
    },
  )

  app.put(
    '/clientes/:id/credito',
    {
      preHandler: [
        requireAuth,
        requirePermission('clientes', 'habilitar_credito', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeCredito, req.body, reply)
      if (!datos) return

      try {
        return conDocumento(await configurarCredito(id, datos))
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:habilitar_credito', id)
      }
    },
  )

  app.get(
    '/clientes/:id/direcciones',
    { preHandler: [requireAuth, requirePermission('clientes', 'ver')] },
    async (req) => direccionesDe((req.params as { id: string }).id),
  )

  app.post(
    '/clientes/:id/direcciones',
    {
      preHandler: [requireAuth, requirePermission('clientes', 'editar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeDireccion, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await agregarDireccion(id, datos))
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:editar', id)
      }
    },
  )

  app.patch(
    '/direcciones/:id/desactivar',
    {
      preHandler: [requireAuth, requirePermission('clientes', 'editar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        return await desactivarDireccion(id)
      } catch (err) {
        return manejarError(err, req, reply, 'clientes:editar', id)
      }
    },
  )
}

/** Suma el documento ya armado, sin guardarlo. */
function conDocumento<T extends { tipoDocumento: 'CC' | 'NIT'; numeroDocumento: string }>(
  cliente: T,
): T & { documento: string } {
  return { ...cliente, documento: documentoParaMostrar(cliente.tipoDocumento, cliente.numeroDocumento) }
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
      resource: 'clientes',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
