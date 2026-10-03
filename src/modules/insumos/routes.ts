import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import type { Resultado } from './saldo'
import {
  ajustarInsumo,
  buscarInsumo,
  crearInsumo,
  descartarInsumo,
  editarInsumo,
  listarInsumos,
  movimientosDe,
  registrarEntrada,
} from './service'
import {
  esquemaDeAjuste,
  esquemaDeAlta,
  esquemaDeDescarte,
  esquemaDeEdicion,
  esquemaDeEntrada,
} from './validation'

/**
 * Insumos de empaque — RN-INS-01 a 04.
 *
 * ── No hay ninguna ruta que edite el saldo ──────────────────────────────────
 *
 * Ni `PUT` ni `PATCH` sobre las unidades. El saldo **se mueve mediante
 * documentos** con motivo y responsable, nunca se corrige a mano. Que esas
 * rutas no existan es parte del contrato, no una omisión — igual que en M2, y
 * hay un test que lo verifica.
 *
 * `PATCH /insumos/:id` sí existe, pero toca la CONFIGURACIÓN del insumo
 * —nombre, mínimo, equivalencia, activo—, no su saldo.
 *
 * ── Por qué no hay `insumos:crear` en la matriz ─────────────────────────────
 *
 * Dar de alta un insumo es configuración, no operación: pasa una vez y la hace
 * un admin. Se cubre con `insumos:ajustar`, igual que se resolvió
 * `stock:descartar`. Un permiso que se usa tres veces al año no justifica una
 * fila más que hay que mantener y auditar.
 */
export async function insumosRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/insumos',
    { preHandler: [requireAuth, requirePermission('insumos', 'ver')] },
    async (req) => {
      const incluirInactivos = (req.query as { estado?: string }).estado === 'todos'
      return listarInsumos(incluirInactivos)
    },
  )

  app.get(
    '/insumos/:id',
    { preHandler: [requireAuth, requirePermission('insumos', 'ver')] },
    async (req, reply) => {
      const insumo = await buscarInsumo((req.params as { id: string }).id)
      if (!insumo) {
        return reply.code(404).send({ code: 'INSUMO_NO_ENCONTRADO', mensaje: 'no existe ese insumo' })
      }
      return insumo
    },
  )

  app.get(
    '/insumos/:id/movimientos',
    { preHandler: [requireAuth, requirePermission('insumos', 'ver')] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      try {
        return await movimientosDe(id)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ver', id)
      }
    },
  )

  app.post(
    '/insumos',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const datos = validar(esquemaDeAlta, req.body, reply)
      if (!datos) return

      try {
        const creado = await crearInsumo(datos)

        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'insumos:ajustar',
          resource: 'insumos',
          result: 'ok',
          payload: {
            operacion: 'alta',
            resourceId: creado.id,
            codigo: creado.codigo,
            nombre: creado.nombre,
            minimo: creado.minimo,
            equivalenciaPorKilo: creado.equivalenciaPorKilo,
          },
        })

        return reply.code(201).send(creado)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar')
      }
    },
  )

  app.patch(
    '/insumos/:id',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeEdicion, req.body, reply)
      if (!datos) return

      try {
        const editado = await editarInsumo(id, datos)

        /*
         * `cambios` lleva lo que VINO en el request, no los cuatro campos del
         * esquema: la edición es parcial, y un payload completo haría ver como
         * que se tocó todo cuando se movió solo el mínimo.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'insumos:ajustar',
          resource: 'insumos',
          result: 'ok',
          payload: {
            operacion: 'editar',
            resourceId: editado.id,
            codigo: editado.codigo,
            cambios: datos,
          },
        })

        return editado
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )

  app.post(
    '/insumos/:id/entrada',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeEntrada, req.body, reply)
      if (!datos) return

      try {
        const codigo = await codigoDe(id)
        const resultado = await registrarEntrada(id, datos, req.user?.id ?? null)

        /* La entrada llega en unidades O en kilos, nunca las dos: van las dos
         * claves y una es `null`, para que la fila diga en qué se recibió. */
        await auditarMovimiento(req, resultado, {
          operacion: 'entrada',
          resourceId: id,
          codigo,
          cantidad: datos.cantidad ?? null,
          kilos: datos.kilos ?? null,
        })

        return reply.code(201).send(resultado)
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )

  app.post(
    '/insumos/:id/ajuste',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeAjuste, req.body, reply)
      if (!datos) return

      try {
        const codigo = await codigoDe(id)
        const resultado = await ajustarInsumo(id, datos, req.user?.id ?? null)

        /* La diferencia va CON SIGNO, igual que en los tanques: «sobraban 40»
         * y «faltaban 40» son hechos opuestos y el signo los distingue. */
        await auditarMovimiento(req, resultado, {
          operacion: 'ajuste',
          resourceId: id,
          codigo,
          diferencia: datos.diferencia,
          motivo: datos.motivo,
        })

        return resultado
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )

  app.post(
    '/insumos/:id/descarte',
    { preHandler: [requireAuth, requirePermission('insumos', 'ajustar', { auditaLaRuta: true })] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id
      const datos = validar(esquemaDeDescarte, req.body, reply)
      if (!datos) return

      try {
        const codigo = await codigoDe(id)
        const resultado = await descartarInsumo(id, datos, req.user?.id ?? null)

        await auditarMovimiento(req, resultado, {
          operacion: 'descarte',
          resourceId: id,
          codigo,
          cantidad: datos.cantidad,
          causa: datos.causa,
          observaciones: datos.observaciones ?? null,
        })

        return resultado
      } catch (err) {
        return manejarError(err, req, reply, 'insumos:ajustar', id)
      }
    },
  )
}

/**
 * El código del insumo, para que la fila no diga solo un uuid.
 *
 * «entraron 300 TAPA_20L» se lee; «entraron 300 de
 * 9609053e-8578-4705-9ffc-509ad31f74e9» obliga a ir a buscar cuál era. Es una
 * lectura extra por movimiento y se acepta por eso.
 */
async function codigoDe(id: string): Promise<string | null> {
  return (await buscarInsumo(id))?.codigo ?? null
}

/**
 * Escribe la fila de un movimiento de saldo, se haya movido o no.
 *
 * Las tres rutas de movimiento devuelven `Resultado`, y `descontar` responde
 * `{ ok: false, disponible }` en vez de lanzar: que no alcance es un estado
 * normal de la planta, no un error. Por eso ese intento NO pasa por
 * `manejarError`, y sin esta rama quedaría SIN RASTRO —antes dejaba la fila
 * automática del middleware, que decía `ok` para algo que no movió nada—.
 *
 * Queda como `denied` con lo pedido y lo que de verdad había: «intentó
 * descartar 900 de las 500 que hay» es justo el patrón que una bitácora existe
 * para poder mostrar.
 */
async function auditarMovimiento(
  req: FastifyRequest,
  resultado: Resultado,
  payload: Record<string, unknown>,
): Promise<void> {
  await auditarSinBloquear(req, {
    userId: req.user?.id ?? null,
    rolEjercido: req.user?.roles ?? [],
    action: 'insumos:ajustar',
    resource: 'insumos',
    result: resultado.ok ? 'ok' : 'denied',
    payload: resultado.ok
      ? { ...payload, saldo: resultado.saldo }
      : { ...payload, disponible: resultado.disponible },
  })
}

/**
 * Traduce un error de negocio a su status, y lo deja en la bitácora.
 *
 * `auditarSinBloquear`: acá ya se ejecutó la acción o ya se rechazó, así que un
 * fallo de auditoría no puede tumbar la respuesta. Lo que sí bloquea es la
 * auditoría PREVIA de `requirePermission({ auditaLaRuta: true })`.
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
      resource: 'insumos',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
