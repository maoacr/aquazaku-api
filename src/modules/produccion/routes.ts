import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import {
  type Nivel,
  type Tanque,
  ajustarAgua,
  movimientosDe,
  reconciliar,
  registrarIngreso,
  saldosDeAgua,
} from './agua'
import { cierreDe, listarCierres, registrarCierre } from './cierre'
import {
  esquemaDeAjusteDeAgua,
  esquemaDeCierre,
  esquemaDeReconciliacion,
  esquemaDeReposicion,
} from './validation'

/**
 * Producción y agua — M4.
 *
 * ── No hay forma de editar un cierre ────────────────────────────────────────
 *
 * Ni `PATCH` ni `DELETE`. El cierre es el único evento que convierte litros en
 * producto, así que editarlo cambiaría a la vez el agua, el stock y los insumos
 * **sin dejar rastro de qué decía antes** (RN-PRD-08). Una corrección es un
 * ajuste posterior con motivo y responsable.
 *
 * Que esas rutas no existan es parte del contrato, y hay un test que lo
 * verifica.
 *
 * ── Por qué `produccion` y `tanques` son recursos separados ─────────────────
 *
 * Porque distinguen dos cosas que se parecen y no son iguales:
 *
 * - **`tanques:registrar_reposicion`** lo tiene el `pos`: «llegó agua y se
 *   llenó el tanque» es un HECHO que observa quien está en la planta.
 * - **`tanques:ajustar`** es solo del `admin`: corregir un saldo que no cuadra
 *   es otra cosa, y quien opera no debería poder tapar su propia discrepancia.
 */
export async function produccionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/produccion',
    { preHandler: [requireAuth, requirePermission('produccion', 'ver')] },
    async () => listarCierres(),
  )

  app.get(
    '/produccion/:fecha',
    { preHandler: [requireAuth, requirePermission('produccion', 'ver')] },
    async (req, reply) => {
      const fecha = (req.params as { fecha: string }).fecha
      const cierre = await cierreDe(fecha)

      if (!cierre) {
        return reply
          .code(404)
          .send({ code: 'CIERRE_NO_ENCONTRADO', mensaje: `no hay cierre registrado el ${fecha}` })
      }
      return cierre
    },
  )

  app.post(
    '/produccion/cierres',
    {
      preHandler: [
        requireAuth,
        requirePermission('produccion', 'registrar_cierre', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeCierre, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await registrarCierre(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'produccion:registrar_cierre', datos.fecha)
      }
    },
  )

  app.get(
    '/tanques',
    { preHandler: [requireAuth, requirePermission('tanques', 'ver')] },
    async () => saldosDeAgua(),
  )

  app.get(
    '/tanques/:tanque/movimientos',
    { preHandler: [requireAuth, requirePermission('tanques', 'ver')] },
    async (req) => movimientosDe((req.params as { tanque: Tanque }).tanque),
  )

  /**
   * La reconciliación es una CONSULTA, y por eso es `GET`.
   *
   * No escribe: compara el saldo calculado contra lo que se vio y dice si
   * cuadra. Si no cuadra, quien mira decide si ajusta — con motivo, por la ruta
   * de abajo. Sobrescribir el saldo con la lectura es justo lo que RN-PRD-14
   * prohíbe.
   */
  app.get(
    '/tanques/reconciliacion',
    { preHandler: [requireAuth, requirePermission('tanques', 'ver')] },
    async (req, reply) => {
      const datos = validar(esquemaDeReconciliacion, req.query ?? {}, reply)
      if (!datos) return

      return reconciliar(datos.tanque as Tanque, datos.nivel as Nivel)
    },
  )

  /**
   * «Llegó agua y se llenó el tanque» — sin cantidad.
   *
   * El cuerpo NO acepta litros, y eso es RN-PRD-11 hecha contrato: no hay
   * medidor ni regleta. Si el endpoint los aceptara, alguien los mandaría a ojo
   * y el sistema convertiría un hueco conocido en un número que parece medido.
   */
  app.post(
    '/tanques/reposicion',
    {
      preHandler: [
        requireAuth,
        requirePermission('tanques', 'registrar_reposicion', { auditaLaRuta: true }),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeReposicion, req.body, reply)
      if (!datos) return

      return reply
        .code(201)
        .send(await registrarIngreso(datos.tanque as Tanque, req.user?.id ?? null))
    },
  )

  app.post(
    '/tanques/ajuste',
    {
      preHandler: [requireAuth, requirePermission('tanques', 'ajustar', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeAjusteDeAgua, req.body, reply)
      if (!datos) return

      try {
        return await ajustarAgua(
          datos.tanque as Tanque,
          datos.litros,
          datos.motivo,
          req.user?.id ?? null,
        )
      } catch (err) {
        return manejarError(err, req, reply, 'tanques:ajustar', datos.tanque)
      }
    },
  )
}

/**
 * Traduce un error de negocio a su status y lo deja en la bitácora.
 *
 * `auditarSinBloquear`: acá ya se ejecutó o ya se rechazó, así que un fallo de
 * auditoría no puede tumbar la respuesta. Lo que sí bloquea es la auditoría
 * PREVIA de `requirePermission({ auditaLaRuta: true })`.
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
      resource: action.startsWith('tanques') ? 'tanques' : 'produccion',
      result: 'denied',
      payload: { motivo: err.code, resourceId },
    })

    return reply.code(err.status).send({ code: err.code, mensaje: err.message })
  }

  throw err
}
