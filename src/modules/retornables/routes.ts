import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '@/db/client'
import { bases, clientes, direcciones } from '@/db/schema'
import { direccionLegible } from '@/modules/clientes/direccion-legible'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import {
  basesEnDireccion,
  comprarBases,
  darDeAltaBase,
  descartarBase,
  disponibilidadDeBases,
  historialDe,
  prestarBase,
  proximoCodigoDeBase,
  retornarBase,
} from './bases'
import {
  ajustarBotellones,
  comprarBotellones,
  descartarBotellones,
  entregarBotellones,
  retornarBotellones,
} from './botellones'
import { botellonesDe, botellonesEnBodega, verificarConservacion } from './conservacion'
import { marcarBaseDanada } from './dano'
import {
  esquemaDeAjusteDeBotellones,
  esquemaDeAltaDeBase,
  esquemaDeCompra,
  esquemaDeCompraDeBases,
  esquemaDeDano,
  esquemaDeDescarteDeBase,
  esquemaDeDescarteDeBotellones,
  esquemaDePrestamo,
  esquemaDeTransferencia,
} from './validation'

/**
 * Retornables — M7.
 *
 * ── Dos activos, dos recursos, y la matriz ya los tenía separados ───────────
 *
 * `botellones` y `bases` son recursos distintos en la matriz desde M0, con
 * acciones propias: `entregar` / `recibir_retorno` para uno, `prestar` /
 * `retirar` para el otro. Eso no es una duplicación — refleja que son dos
 * activos con ciclos independientes (`RN-BAS-12`).
 *
 * El `seller` los **ve** y no los opera. Es la matriz la que lo dice, y tiene
 * sentido hoy: quien entrega en la calle trabaja por ruta, y las rutas son M8.
 */
export async function retornablesRoutes(app: FastifyInstance): Promise<void> {
  /* ── Botellones ───────────────────────────────────────────────────────── */

  app.get(
    '/botellones',
    { preHandler: [requireAuth, requirePermission('botellones', 'ver')] },
    async () => {
      const conservacion = await verificarConservacion()

      return {
        enBodega: await botellonesEnBodega(),
        ...conservacion,
        /*
         * La ley de conservación viaja en la respuesta a propósito. El dominio
         * pidió que fallara «ruidosamente», y un endpoint que la calcula y no la
         * dice la deja tan silenciosa como no calcularla.
         */
      }
    },
  )

  app.get(
    '/clientes/:id/botellones',
    { preHandler: [requireAuth, requirePermission('botellones', 'ver')] },
    async (req) => ({
      enPoderDelCliente: await botellonesDe((req.params as { id: string }).id),
    }),
  )

  app.post(
    '/botellones/compra',
    {
      preHandler: [
        requireAuth,
        requirePermission('botellones', 'registrar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeCompra, req.body, reply)
      if (!datos) return

      try {
        const enBodega = await comprarBotellones(
          datos.cantidad,
          datos.motivo ?? '',
          req.user?.id ?? null,
        )

        /*
         * ── `operacion` separa dos hechos que comparten nombre de acción ────
         *
         * Comprar y ajustar van los dos bajo `botellones:registrar` porque
         * comparten el permiso. Son cosas distintas: una compra SUMA parque, un
         * ajuste corrige un conteo que no cuadraba. Sin este campo, «entraron
         * 50» se lee igual que «faltaban 50».
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'botellones:registrar',
          resource: 'botellones',
          result: 'ok',
          payload: { operacion: 'compra', cantidad: datos.cantidad, motivo: datos.motivo ?? null, enBodega },
        })

        return reply.code(201).send({ enBodega })
      } catch (err) {
        return manejarError(err, req, reply, 'botellones', 'botellones:registrar')
      }
    },
  )

  app.post(
    '/botellones/entrega',
    {
      preHandler: [
        requireAuth,
        requirePermission('botellones', 'entregar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeTransferencia, req.body, reply)
      if (!datos) return

      try {
        const saldos = await entregarBotellones({ ...datos, registradoPor: req.user?.id ?? null })

        /*
         * Un botellón que sale y no queda registrado es un activo perdido con
         * papeles. La fila dice cuántos, a quién, y cómo quedaron los dos
         * saldos — los mismos dos que la ficha del cliente muestra, para poder
         * cotejar sin recalcular.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'botellones:entregar',
          resource: 'botellones',
          result: 'ok',
          payload: {
            resourceId: datos.clienteId,
            cantidad: datos.cantidad,
            enPoderDelCliente: saldos.enPoderDelCliente,
            enBodega: saldos.enBodega,
          },
        })

        return reply.code(201).send(saldos)
      } catch (err) {
        return manejarError(err, req, reply, 'botellones', 'botellones:entregar', datos.clienteId)
      }
    },
  )

  app.post(
    '/botellones/retorno',
    {
      preHandler: [
        requireAuth,
        requirePermission('botellones', 'recibir_retorno', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeTransferencia, req.body, reply)
      if (!datos) return

      try {
        const saldos = await retornarBotellones({ ...datos, registradoPor: req.user?.id ?? null })

        /* El reverso de la entrega, y se audita igual: lo que baja la deuda de
         * envases de un cliente tiene que ser tan reconstruible como lo que la
         * sube. */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'botellones:recibir_retorno',
          resource: 'botellones',
          result: 'ok',
          payload: {
            resourceId: datos.clienteId,
            cantidad: datos.cantidad,
            enPoderDelCliente: saldos.enPoderDelCliente,
            enBodega: saldos.enBodega,
          },
        })

        return reply.code(201).send(saldos)
      } catch (err) {
        return manejarError(err, req, reply, 'botellones', 'botellones:recibir_retorno', datos.clienteId)
      }
    },
  )

  app.post(
    '/botellones/descarte',
    {
      preHandler: [
        requireAuth,
        requirePermission('botellones', 'descartar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeDescarteDeBotellones, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const enBodega = await descartarBotellones(
          datos.cantidad,
          datos.motivo,
          req.user?.id ?? null,
          {
            userId: req.user?.id ?? null,
            rolEjercido: req.user?.roles ?? [],
            requestId: String(req.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          },
        )

        return reply.code(201).send({ enBodega })
      } catch (err) {
        return manejarError(err, req, reply, 'botellones', 'botellones:descartar')
      }
    },
  )

  app.post(
    '/botellones/ajuste',
    {
      preHandler: [
        requireAuth,
        requirePermission('botellones', 'registrar', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeAjusteDeBotellones, req.body, reply)
      if (!datos) return

      try {
        const saldo = await ajustarBotellones(datos, req.user?.id ?? null)

        /* `operacion: 'ajuste'` es lo que lo separa de la compra, que comparte
         * esta acción. Ver el comentario en `/botellones/compra`. */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'botellones:registrar',
          resource: 'botellones',
          result: 'ok',
          payload: {
            operacion: 'ajuste',
            resourceId: datos.clienteId ?? null,
            diferencia: datos.diferencia,
            motivo: datos.motivo,
            saldo,
          },
        })

        return reply.code(201).send({
          saldo,
          /* Después de un ajuste, el estado de la ley es lo que hay que mirar. */
          conservacion: await verificarConservacion(),
        })
      } catch (err) {
        return manejarError(err, req, reply, 'botellones', 'botellones:registrar')
      }
    },
  )

  /* ── Bases ────────────────────────────────────────────────────────────── */

  /**
   * Las bases, cada una con DÓNDE está.
   *
   * ── El N+1 que esto vino a matar ──────────────────────────────────────────
   *
   * La pantalla de Retornables resolvía «dónde está cada base» trayéndose las
   * direcciones de TODOS los clientes: una petición por cliente. Con los 40 de
   * hoy pasa desapercibido; con mil son **mil una** peticiones cada vez que
   * alguien abre la pantalla, para mostrar como mucho cuarenta direcciones.
   *
   * Acá es un `LEFT JOIN`. La dirección viaja pegada a la base porque es un
   * atributo de la base —dónde está— y no una lista aparte que la pantalla
   * tenga que cruzar.
   */
  app.get(
    '/bases',
    { preHandler: [requireAuth, requirePermission('bases', 'ver')] },
    async () => {
      const filas = await db
        .select({ base: bases, direccion: direcciones, clienteNombre: clientes.nombre })
        .from(bases)
        .leftJoin(direcciones, eq(direcciones.id, bases.direccionId))
        .leftJoin(clientes, eq(clientes.id, direcciones.clienteId))
        .where(eq(bases.activa, true))
        .orderBy(bases.idSticker)

      return filas.map(({ base, direccion, clienteNombre }) => ({
        ...base,
        // `null` cuando está en la bodega, que es el caso común.
        ubicacion:
          direccion === null
            ? null
            : {
                direccionId: direccion.id,
                etiqueta: direccion.etiqueta,
                // La compone `api`, como en todos lados: si cada pantalla
                // armara la nomenclatura, habría tres formatos en tres meses.
                legible: direccionLegible(direccion),
                clienteId: direccion.clienteId,
                clienteNombre: clienteNombre!,
              },
      }))
    },
  )

  /**
   * El código que el sistema propondría para la próxima base — RN-BAS-10.
   *
   * Existe como endpoint y no como cálculo en la pantalla porque la regla del
   * consecutivo —máximo + 1, sin reciclar descartados— vive en un solo lugar.
   * Una copia en el componente empezaría a mentir el día que cambie, y lo haría
   * en silencio: propondría un número ya tomado y el alta fallaría con un
   * duplicado que el operario no pidió.
   *
   * Va bajo `registrar` y no bajo `ver`: es una ayuda para dar de alta, y quien
   * no puede dar de alta no tiene qué hacer con el número siguiente.
   */
  app.get(
    '/bases/proximo-codigo',
    /*
     * ── `auditaLaRuta` SIN emitir, y acá sí corresponde ──────────────────────
     *
     * Normalmente declarar el opt-out y no escribir la fila es el defecto que
     * `opt-out-de-auditoria` vigila. Esta ruta es la excepción, y por la propia
     * política del módulo: «todo PERMITIDO se audita, SALVO las lecturas
     * puras».
     *
     * Esto es una lectura pura. Vive bajo `bases:registrar` porque quien no
     * puede dar de alta no tiene qué hacer con el número siguiente, no porque
     * registre nada. Sin la exención, cada vez que alguien ABRE el formulario
     * de alta quedaba una fila `bases:registrar` indistinguible de un alta de
     * verdad — y el alta sí escribe la suya, con el sticker.
     */
    {
      preHandler: [requireAuth, requirePermission('bases', 'registrar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      try {
        return { proximo: await proximoCodigoDeBase() }
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:registrar')
      }
    },
  )

  /**
   * ¿Alcanzan las bases hasta el próximo pedido? — RN-BAS-13.
   *
   * Devuelve los DOS números y la demora, no solo el veredicto: un aviso que
   * dice «hay que comprar» sin decir cuántas quedan ni a qué ritmo se van
   * obliga a ir a buscarlo a otra pantalla antes de poder decidir cuántas
   * pedir.
   *
   * Va bajo `ver` y no bajo `registrar`: quien mira el parque tiene que poder
   * ver si alcanza, aunque no sea quien compra.
   */
  app.get(
    '/bases/disponibilidad',
    { preHandler: [requireAuth, requirePermission('bases', 'ver')] },
    async () => disponibilidadDeBases(),
  )

  app.get(
    '/bases/:id/historial',
    { preHandler: [requireAuth, requirePermission('bases', 'ver')] },
    async (req) => historialDe((req.params as { id: string }).id),
  )

  app.get(
    '/direcciones/:id/bases',
    { preHandler: [requireAuth, requirePermission('bases', 'ver')] },
    async (req) => basesEnDireccion((req.params as { id: string }).id),
  )

  app.post(
    '/bases',
    {
      preHandler: [requireAuth, requirePermission('bases', 'registrar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeAltaDeBase, req.body, reply)
      if (!datos) return

      try {
        const base = await darDeAltaBase(datos.idSticker, req.user?.id ?? null)

        /* `operacion` separa el alta de una base concreta de la compra de un
         * lote, que comparten esta acción porque comparten el permiso. */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'bases:registrar',
          resource: 'bases',
          result: 'ok',
          payload: { operacion: 'alta', resourceId: base.id, idSticker: base.idSticker },
        })

        return reply.code(201).send(base)
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:registrar')
      }
    },
  )

  /**
   * Comprar bases — RN-BAS-10.
   *
   * Espeja `POST /botellones/compra`: los dos activos entran al parque por una
   * compra con cantidad. Cargar 40 de a una son 40 operaciones que pueden
   * cortarse por la mitad, y con los stickers ya impresos el hueco queda en la
   * caja y no en la pantalla.
   *
   * No acepta sticker: una base comprada llega sin rotular y el sistema la
   * numera. El camino de «el rótulo ya viene pegado» es `POST /bases`.
   */
  app.post(
    '/bases/compra',
    {
      preHandler: [requireAuth, requirePermission('bases', 'registrar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeCompraDeBases, req.body, reply)
      if (!datos) return

      try {
        const compradas = await comprarBases(datos.cantidad, req.user?.id ?? null)

        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'bases:registrar',
          resource: 'bases',
          result: 'ok',
          payload: { operacion: 'compra', cantidad: datos.cantidad },
        })

        return reply.code(201).send(compradas)
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:registrar')
      }
    },
  )

  app.post(
    '/bases/:id/prestamo',
    {
      preHandler: [requireAuth, requirePermission('bases', 'prestar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDePrestamo, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const prestada = await prestarBase(id, datos.direccionId, req.user?.id ?? null, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        })

        return prestada
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:prestar', id)
      }
    },
  )

  app.post(
    '/bases/:id/retorno',
    {
      preHandler: [requireAuth, requirePermission('bases', 'retirar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const retornada = await retornarBase(id, req.user?.id ?? null, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        })

        return retornada
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:retirar', id)
      }
    },
  )

  /**
   * Marcar una base como dañada — RN-BAS-08.
   *
   * ── Por qué va bajo `bases:descartar` y no bajo un permiso nuevo ────────────
   *
   * La matriz no tiene una acción `marcar_dano`, y **no se inventa una acá**:
   * los permisos viven en un solo lugar (ADR-0003) y agregar uno desde una ruta
   * lo partiría en dos.
   *
   * `descartar` es la acción existente cuyo conjunto de roles coincide
   * exactamente con lo que el dominio pide —«`pos` o `admin` registra el estado
   * dañada»— y cuya semántica es la más cercana: la base sale del servicio
   * normal. No es idéntica: una base dañada sigue existiendo.
   *
   * Si el negocio quiere separarlas, es un cambio en la matriz. Queda dicho acá
   * para que la próxima persona no tenga que deducirlo.
   */
  app.post(
    '/bases/:id/dano',
    {
      preHandler: [requireAuth, requirePermission('bases', 'descartar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeDano, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const dano = await marcarBaseDanada({ baseId: id, ...datos }, req.user?.id ?? null, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        })

        return reply.code(201).send(dano)
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:descartar', id)
      }
    },
  )

  app.post(
    '/bases/:id/descarte',
    {
      preHandler: [requireAuth, requirePermission('bases', 'descartar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeDescarteDeBase, req.body, reply)
      if (!datos) return

      try {
        /* La fila la escribe el servicio, dentro de su transacción — ADR-0007. */
        const descartada = await descartarBase(id, datos.motivo, req.user?.id ?? null, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        })

        return descartada
      } catch (err) {
        return manejarError(err, req, reply, 'bases', 'bases:descartar', id)
      }
    },
  )
}

/**
 * El `resource` se pasa explícito, no se deduce del texto de la acción.
 *
 * En M6 salía de un ternario sobre `action.startsWith(…)`, y un action nuevo se
 * auditaba como otro recurso **en silencio**. La bitácora existe justamente para
 * poder confiar en ella.
 */
async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  resource: 'botellones' | 'bases',
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
