import { type SQL, and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '@/db/client'
import { clientes, direcciones, lineasDeVenta, productos, users, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { validar } from '@/lib/http'
import { auditarSinBloquear } from '@/modules/auth/routes'
import { can } from '@/modules/authz/can'
import { requireAuth, requirePermission } from '@/modules/authz/middleware'
import { scopedCondition } from '@/modules/authz/scoped-query'
import { anularVenta } from './anulacion'
import { corregirVenta } from './correccion'
import { cartera, cobrosDe, registrarCobro } from './cobros'
import { crearCodigo, desactivarCodigo, listarCodigos } from './descuentos'
import { devolucionesDe, registrarDevolucion } from './devoluciones'
import { cargosPendientesDe, deudaDe } from './saldo'
import {
  esquemaDeAnulacion,
  esquemaDeCobro,
  esquemaDeCodigo,
  esquemaDeCorreccion,
  esquemaDeDevolucion,
  esquemaDeVenta,
} from './validation'
import { registrarVenta } from './venta'
import { hoyEnLaPlanta } from '@/lib/dia'
import { documentoParaMostrar } from '@/modules/clientes/documento'

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

      /*
       * ── `?clienteId`: la misma lista, recortada a un cliente ─────────────
       *
       * Lo pide la ficha del cliente, que muestra sus últimas ventas. Filtrar
       * del otro lado no serviría: lo que viaja son las cien últimas del
       * negocio, y un cliente que compró la semana pasada quedaría sin una sola
       * venta a la vista porque ese corte se lo comió. El recorte tiene que
       * pasar donde está el `ORDER BY`.
       *
       * Es el mismo parámetro que ya usa `GET /cobros?clienteId`, y se COMBINA
       * con el alcance en vez de reemplazarlo: un `pos` que filtra por cliente
       * sigue viendo lo propio. Si se reemplazara, este parámetro sería una
       * puerta de atrás a la matriz (RN-ACC-03) —y se abriría desde la barra de
       * direcciones—.
       */
      const { clienteId } = req.query as { clienteId?: string }

      /*
       * Una venta corregida NO aparece — RN-VEN-16 + cambio UX de lista.
       *
       * La corrección NO es un PATCH: la vieja se marca `estado='corregida'`
       * y se inserta una venta NUEVA que la reemplaza. Sin este filtro, la
       * lista mostraría DOS filas para una sola operación lógica, con la
       * misma hora a la que se hizo la corrección.
       *
       * La fila que se ve es la NUEVA — y como `corregirVenta` la inserta
       * con `createdAt = original.createdAt` (o el override que pidió el
       * admin), queda en la posición temporal del hecho, no salta al tope
       * con la hora de la corrección. Es la única fila que importa: la
       * vieja solo existe como eslabón de la trazabilidad.
       *
       * Las anuladas sí se listan, en su propio tab — ver `UltimasVentas`
       * en `web/`.
       */
      const condicion = and(
        alcance,
        ne(ventas.estado, 'corregida'),
        clienteId ? eq(ventas.clienteId, clienteId) : undefined,
      )

      /*
       * Los nombres viajan RESUELTOS, no los ids.
       *
       * `clienteId` y `registradoPor` son UUIDs: una lista de cien ventas con
       * cien UUIDs no se lee, y resolverlos del otro lado costaría cien
       * consultas —o traerse la tabla de clientes entera, que es justo lo que
       * el mostrador dejó de hacer—.
       *
       * Los dos son `leftJoin` porque las dos columnas son nulas por diseño: la
       * venta de mostrador no tiene cliente, y borrar una cuenta deja la venta
       * en pie con su autor en `null`.
       */
      return ventasDelListado(condicion)
    },
  )

  app.get(
    '/ventas/:id',
    { preHandler: [requireAuth, requirePermission('ventas', 'ver')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      /*
       * La MISMA proyección que la lista, no un `select()` crudo.
       *
       * Devolvía la fila pelada de `ventas`: sin `clienteNombre`, sin
       * `tipoClienteAlMomento`, y con las líneas sin el nombre del producto.
       * Nadie lo notó mientras la única pantalla que corregía una venta la
       * tomaba de la LISTA, que sí viene enriquecida.
       *
       * Se notó cuando Seguimientos quiso abrir el mismo mostrador pidiendo la
       * venta por id: el modal abría sin cliente. Y no lo atrapó el typecheck,
       * porque del otro lado la respuesta se tipa a mano — un cast en el borde
       * del fetch es una afirmación, no una comprobación.
       */
      const [venta] = await ventasDelListado(eq(ventas.id, id))

      if (!venta) {
        return reply.code(404).send({ code: 'VENTA_NO_ENCONTRADA', mensaje: 'esa venta no existe' })
      }

      return {
        ...venta,
        /*
         * Las líneas CRUDAS, con su `id`, pisando el resumen de la lista.
         *
         * El resumen AGRUPA por producto —`sum(cantidad)`— así que no tiene un
         * id por fila, y `POST /devoluciones` necesita apuntar a una línea
         * concreta. Acá se devuelven enteras.
         *
         * Al mostrador de corrección le sirven igual: usa `productoId`,
         * `cantidad`, `precioFinal` y `precioManual`, y las cuatro están en la
         * fila cruda. Lo único que no trae es el nombre del producto, que ese
         * formulario saca del catálogo.
         */
        lineas: await db.select().from(lineasDeVenta).where(eq(lineasDeVenta.ventaId, id)),
        devoluciones: await devolucionesDe(id),
      }
    },
  )

  app.post(
    '/ventas',
    {
      /*
       * `auditaLaRuta: true` APAGA la fila automática del middleware porque
       * esta ruta escribe la SUYA — RN-ACC-04.
       *
       * La del middleware se escribe en el `preHandler`, ANTES de que la venta
       * exista, así que sale sin `resourceId` y sin `payload`: dice «alguien
       * con permiso intentó vender» y no cuál venta, ni si llegó a hacerse.
       *
       * Medido en producción: 225 filas de `ventas:crear`, las 225 con
       * `resource_id` y `payload` en NULL. Un total que no cuadra contra una
       * copia impresa no se puede explicar con eso.
       */
      preHandler: [requireAuth, requirePermission('ventas', 'crear', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeVenta, req.body, reply)
      if (!datos) return

      /*
       * ── Llevar una base exige el permiso de prestarla ────────────────────
       *
       * Sin esto, este endpoint sería una puerta de atrás a la matriz: el
       * `seller` tiene `ventas:crear` pero solo `bases:ver`, y prestaría bases
       * mandando un campo más en el cuerpo de una venta.
       *
       * Es RN-ACC-02 en su forma menos obvia. La regla no es «cada ruta valida
       * su permiso», es «cada ACCIÓN valida el suyo» — y esta ruta hace dos.
       */
      if (datos.base && !can(req.user!, 'bases', 'prestar')) {
        return reply.code(403).send({
          code: 'SIN_PERMISO',
          mensaje:
            'no tiene permiso para prestar bases. Puede registrar la venta sin la base, y que la entregue quien sí lo tenga',
        })
      }

      try {
        const resultado = await registrarVenta(
          { ...datos, hoy: hoyEnLaPlanta() },
          req.user?.id ?? null,
        )

        /*
         * ── Fechar una venta hacia atrás deja rastro propio — RN-VEN-14 ─────
         *
         * La venta ya la audita `requirePermission` como cualquier otra. Esta
         * fila es aparte y solo existe cuando la fecha NO es hoy, porque lo que
         * registra es otra cosa: alguien movió plata de un mes a otro.
         *
         * Ojo con `auditaLaRuta`: el flag NO audita, APAGA la fila del
         * middleware para que la escriba el handler. Un comentario que decía lo
         * contrario, justo acá, dejó a `ventas:crear` sin rastro durante meses
         * — solo quedaban las ventas RECHAZADAS, que las escribe `manejarError`.
         *
         * El reporte de agosto cambia después de haberse emitido —RN-VEN-14 lo
         * acepta a propósito—, y lo único que acota ese costo es poder
         * reconstruir quién lo hizo y cuándo. Sin esta fila, un total que no
         * cuadra contra una copia impresa no tiene explicación.
         *
         * Va con `auditarSinBloquear`: la venta ya está escrita y confirmada. Si
         * la bitácora falla, tumbar la respuesta dejaría al operador creyendo
         * que no vendió, y cobrando de nuevo.
         */
        if (datos.ocurrioEn) {
          await auditarSinBloquear(req, {
            userId: req.user?.id ?? null,
            rolEjercido: req.user?.roles ?? [],
            action: 'ventas:crear_retroactiva',
            resource: 'ventas',
            result: 'ok',
            payload: {
              resourceId: resultado.venta.id,
              ocurrioEn: datos.ocurrioEn,
              registradaEl: hoyEnLaPlanta(),
              total: resultado.venta.total,
            },
          })
        }

        /*
         * ── La venta deja su fila, con lo que hace falta para reconstruirla ─
         *
         * Va PRIMERO porque es el hecho: las que siguen —retroactiva, precio
         * manual— califican esta, no la reemplazan.
         *
         * Lleva `resourceId` para poder ir de la bitácora a la venta, y `total`
         * y `cliente` para que la fila signifique algo sin ir a buscarla. Es el
         * mismo criterio que `clientes:desactivar`, que guarda los conteos de lo
         * que volvió al parque.
         *
         * `auditarSinBloquear` por la misma razón que las otras dos: la venta ya
         * está escrita y confirmada. Tumbar la respuesta porque falló la
         * bitácora dejaría al operador creyendo que no vendió, y cobrando de
         * nuevo.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'ventas:crear',
          resource: 'ventas',
          result: 'ok',
          payload: {
            resourceId: resultado.venta.id,
            total: resultado.venta.total,
            medioDePago: resultado.venta.medioDePago,
            clienteId: resultado.venta.clienteId,
            lineas: resultado.lineas.length,
          },
        })

        /*
         * ── Un precio escrito a mano deja rastro propio — RN-VEN-15 ─────────
         *
         * Fila aparte, y solo cuando alguien escribió un precio. Lo que registra
         * es otra cosa que la venta: alguien afirmó haber cobrado un número que
         * el catálogo no dice, y el piso de ese producto no lo frenó porque el
         * número escrito pasó a ser su propio piso.
         *
         * ── Por qué guarda el precio de LISTA al lado ───────────────────────
         *
         * Porque es el delta lo que se audita, no el importe. «Se vendió a
         * 3.800» ya lo dice la venta; «se vendió a 3.800 cuando la lista decía
         * 10.000» es lo que alguien puede mirar y preguntar.
         *
         * Y acá pesa más que en la venta retroactiva: el permiso es
         * `ventas:crear`, que tienen admin, pos y seller por igual. Esta fila es
         * el único control que separa cargar una venta vieja de cobrar 10.000 y
         * registrar 3.800.
         *
         * Va con `auditarSinBloquear` por la misma razón que la retroactiva: la
         * venta ya está escrita y confirmada, y tumbar la respuesta dejaría al
         * operador creyendo que no vendió, y cobrando de nuevo.
         */
        if (resultado.preciosManuales.length > 0) {
          await auditarSinBloquear(req, {
            userId: req.user?.id ?? null,
            rolEjercido: req.user?.roles ?? [],
            action: 'ventas:precio_manual',
            resource: 'ventas',
            result: 'ok',
            payload: {
              resourceId: resultado.venta.id,
              items: resultado.preciosManuales,
              total: resultado.venta.total,
            },
          })
        }

        return reply.code(201).send(resultado)
      } catch (err) {
        return manejarError(err, req, reply, 'ventas', 'ventas:crear')
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
    { preHandler: [requireAuth, requirePermission('ventas', 'anular')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeAnulacion, req.body, reply)
      if (!datos) return

      try {
        const { venta: anulada, reversiones } = await anularVenta(id, datos.motivo, req.user!)

        /**
         * Bitácora post-commit con payload rico — change `botellones-entrega-devolucion`.
         *
         * Antes la fila `ok` no se escribía (quedaba en manos del middleware de
         * `requirePermission`, que solo persiste `resourceId`). Sin el detalle de
         * qué se revirtió, reconstruir la anulación exigía cruzar `ventas`,
         * `movimientos_botellon` y `movimientos_base` a mano.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'ventas:anular',
          resource: 'ventas',
          result: 'ok',
          payload: {
            resourceId: anulada.id,
            motivo: anulada.motivoAnulacion,
            botellonesReversados: reversiones.botellonesReversados,
            botellonesDevueltos: reversiones.botellonesDevueltos,
            baseReversada: reversiones.baseReversada,
          },
        })

        return reply.code(200).send(anulada)
      } catch (err) {
        return manejarError(err, req, reply, 'ventas', 'ventas:anular', id)
      }
    },
  )

  /**
   * Corregir — RN-VEN-16.
   *
   * `POST` sobre un sub-recurso, igual que la anulación, y **nunca** un `PATCH`
   * sobre la venta. El verbo dice qué pasa de verdad: no se edita la venta —eso
   * sigue sin existir y sigue habiendo un test que lo verifica— se le agrega el
   * hecho de que fue reemplazada por otra.
   *
   * ── Por qué `corregir` y no `anular` en el `requirePermission` ────────────
   *
   * Corregir hace dos cosas: anula una venta Y registra otra con la fecha de la
   * primera. Lo segundo esquiva el tope de 90 días de RN-VEN-14, que rige para
   * todo el mundo cuando se carga una venta vieja. Colgarlo de `ventas:anular`
   * —que `pos` y `seller` tienen sobre lo propio— convertiría este endpoint en
   * la puerta de atrás a ese tope. Es RN-ACC-02: cada ACCIÓN valida el suyo.
   */
  app.post(
    '/ventas/:id/correccion',
    { preHandler: [requireAuth, requirePermission('ventas', 'corregir', { auditaLaRuta: true })] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const datos = validar(esquemaDeCorreccion, req.body, reply)
      if (!datos) return

      /*
       * Igual que en `POST /ventas`: llevar una base exige el permiso de
       * prestarla. La corrección no es una excepción — si lo fuera, sería la
       * puerta de atrás que esa validación existe para cerrar.
       */
      if (datos.base && !can(req.user!, 'bases', 'prestar')) {
        return reply.code(403).send({
          code: 'SIN_PERMISO',
          mensaje:
            'no tiene permiso para prestar bases. Puede corregir la venta sin la base, y que la entregue quien sí lo tenga',
        })
      }

      try {
        const resultado = await corregirVenta(id, { ...datos, hoy: hoyEnLaPlanta() }, req.user!)

        /*
         * ── La corrección deja su propia fila, siempre ─────────────────────
         *
         * Esta ruta pide `auditaLaRuta`, así que el middleware NO escribe la
         * fila: la escribe ésta, y es la única que va a existir. Por eso lleva
         * **qué cambió** y no solo que alguien llamó al endpoint — sin el antes
         * y el después juntos, reconstruir una corrección obliga a cruzar dos
         * filas de `ventas` que nadie sabe que están relacionadas.
         *
         * Y no es opcional como la fila de venta retroactiva: acá el reporte de
         * un mes ya emitido puede cambiar SIEMPRE —esa es la naturaleza del
         * reemplazo— así que el delta de plata es el dato que hace auditable la
         * operación entera.
         *
         * Va con `auditarSinBloquear` por lo mismo que las otras dos: la
         * corrección ya está escrita y confirmada. Tumbar la respuesta porque
         * falló la bitácora dejaría al operador creyendo que no se aplicó, y
         * corrigiendo de nuevo sobre una venta que ya no es la vigente.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'ventas:corregir',
          resource: 'ventas',
          result: 'ok',
          payload: {
            resourceId: resultado.venta.id,
            reemplaza: resultado.reemplazada.id,
            motivo: resultado.reemplazada.motivoAnulacion,
            totalAnterior: resultado.reemplazada.total,
            totalNuevo: resultado.venta.total,
            clienteAnterior: resultado.reemplazada.clienteId,
            clienteNuevo: resultado.venta.clienteId,
            /*
             * RN-VEN-16-AUDIT — la corrección registra **ambas** fechas, no una.
             *
             * La clave singular `ocurrioEn` desaparece del payload de
             * `ventas:corregir`: servía cuando la nueva siempre heredaba el
             * instante exacto de la vieja y un solo campo bastaba. Ahora la
             * nueva puede tener otra fecha (override válido del admin) y la
             * auditoría necesita reconstruir qué cambió sin cruzar dos filas de
             * `ventas`.
             *
             * Se serializan como `Date` —el serializer estándar de Fastify
             * produce ISO 8601 con `Z` (UTC), equivalente al `-05:00` del
             * mediodía de Bogotá. Eso es lo que ya hacía la clave singular
             * antes y es lo que la UI de auditoría hoy renderiza con
             * `JSON.stringify`; el formato no cambia.
             */
            ocurrioEnAnterior: resultado.reemplazada.createdAt,
            ocurrioEnNuevo: resultado.venta.createdAt,
            /*
             * Botellones — change `botellones-entrega-devolucion`. La corrección
             * puede mover las dos cantidades; sin el antes/después, reconstruir
             * el cambio obliga a sumar los compensatorios `tipo='ajuste'`.
             */
            botellonesEntregados: {
              anterior: resultado.reemplazada.botellonesEntregados,
              nuevo: resultado.venta.botellonesEntregados,
            },
            botellonesRecibidos: {
              anterior: resultado.reemplazada.botellonesRecibidos,
              nuevo: resultado.venta.botellonesRecibidos,
            },
          },
        })

        return reply.code(201).send(resultado)
      } catch (err) {
        return manejarError(err, req, reply, 'ventas', 'ventas:corregir', id)
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
    {
      /*
       * Comparte el permiso `ventas:crear` —devolver es parte de vender, y la
       * matriz lo dice ahí— pero NO comparte el nombre en la bitácora.
       *
       * Con la fila del middleware, una devolución quedaba registrada como
       * `ventas:crear`: dos hechos opuestos con el mismo nombre. Quien audite
       * «cuántas ventas se hicieron» contaba devoluciones adentro.
       */
      preHandler: [requireAuth, requirePermission('ventas', 'crear', { auditaLaRuta: true })],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeDevolucion, req.body, reply)
      if (!datos) return

      try {
        const devolucion = await registrarDevolucion(datos, req.user?.id ?? null)

        /*
         * Una devolución mueve stock y plata: qué línea volvió, cuánta, en qué
         * estado y por qué. Sin el payload, la fila dice que alguien devolvió
         * algo y no qué — y esto es justamente lo que alguien va a querer
         * reconstruir cuando el inventario no cuadre.
         */
        await auditarSinBloquear(req, {
          userId: req.user?.id ?? null,
          rolEjercido: req.user?.roles ?? [],
          action: 'ventas:devolucion',
          resource: 'ventas',
          result: 'ok',
          payload: {
            resourceId: devolucion.devolucion.id,
            lineaId: datos.lineaId,
            cantidad: datos.cantidad,
            estadoProducto: datos.estadoProducto,
            motivo: datos.motivo,
            /*
             * Las dos consecuencias, no solo el hecho: cuánto se le bajó de la
             * deuda y si el producto volvió al stock. Un «sano» vuelve, un
             * «dañado» no — y esa diferencia es la que explica un inventario.
             */
            montoAcreditado: devolucion.montoAcreditado,
            volvioAlStock: devolucion.volvioAlStock,
          },
        })

        return reply.code(201).send(devolucion)
      } catch (err) {
        return manejarError(err, req, reply, 'ventas', 'ventas:crear', datos.lineaId)
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
    { preHandler: [requireAuth, requirePermission('cobros', 'registrar')] },
    async (req, reply) => {
      const datos = validar(esquemaDeCobro, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await registrarCobro(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'cobros', 'cobros:registrar', datos.clienteId)
      }
    },
  )

  /**
   * Lo que un cliente debe — los dos saldos de plata de `RN-CLI-06`.
   *
   * Va bajo `cobros:ver` y no `clientes:ver`: es información de cartera, y el
   * `seller` que ve clientes no necesariamente ve lo que deben.
   *
   * ── Dos números y no uno ──────────────────────────────────────────────────
   *
   * `deuda` nace de haber comprado; `cargosPendientes` nace de haber roto algo
   * prestado. Se reclaman distinto, así que se cuentan distinto — un solo campo
   * «estado de cuenta» no diría nada útil.
   *
   * Los dos salen de `ventas`, separados por `tipo`. Ese filtro es lo que hace
   * que `RN-BAS-08` y `RN-CLI-06` se cumplan a la vez.
   */
  app.get(
    '/clientes/:id/deuda',
    { preHandler: [requireAuth, requirePermission('cobros', 'ver')] },
    async (req) => {
      const { id } = req.params as { id: string }

      return {
        deuda: await deudaDe(id),
        cargosPendientes: await cargosPendientesDe(id),
        cobros: await cobrosDe(id),
      }
    },
  )

  /* ── Códigos de descuento: solo admin — RN-VEN-13 ───────────────────────── */

  app.get(
    '/descuentos',
    { preHandler: [requireAuth, requirePermission('configuracion', 'ver')] },
    async (req) => {
      const soloVigentes = (req.query as { vigentes?: string }).vigentes === 'si'

      return listarCodigos(soloVigentes, hoyEnLaPlanta())
    },
  )

  app.post(
    '/descuentos',
    {
      preHandler: [
        requireAuth,
        requirePermission('configuracion', 'editar'),
      ],
    },
    async (req, reply) => {
      const datos = validar(esquemaDeCodigo, req.body, reply)
      if (!datos) return

      try {
        return reply.code(201).send(await crearCodigo(datos, req.user?.id ?? null))
      } catch (err) {
        return manejarError(err, req, reply, 'configuracion', 'configuracion:editar')
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
        requirePermission('configuracion', 'editar'),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }

      try {
        return await desactivarCodigo(id)
      } catch (err) {
        return manejarError(err, req, reply, 'configuracion', 'configuracion:editar', id)
      }
    },
  )
}

/**
 * Qué salió en cada venta, para una lista — no para un comprobante.
 *
 * ── Una consulta, no una por fila ───────────────────────────────────────────
 *
 * Con cien ventas, pedir las líneas venta por venta son cien viajes a la base
 * para pintar una pantalla. `inArray` las trae todas juntas y el agrupado se
 * hace acá, en memoria, sobre datos que ya están.
 *
 * ── Agrupadas por producto, no por línea ────────────────────────────────────
 *
 * Una línea es un par producto+LOTE: pedir diez botellones cuando el primer
 * lote tiene seis genera dos líneas del mismo producto (FEFO, RN-STK-06). El
 * lote importa para el stock y para anular —cada uno vuelve al suyo— pero en la
 * lista aparecería como «6 × Recarga» y «4 × Recarga», dos renglones para una
 * sola cosa que se pidió una vez.
 *
 * Quien mira la pantalla pidió diez. El `GROUP BY` lo dice así.
 *
 * ── Por qué solo el nombre y la cantidad ────────────────────────────────────
 *
 * La línea completa tiene los cuatro precios congelados (RN-VEN-04). Esos son
 * para el comprobante —`GET /ventas/:id`, que los devuelve enteros— y en una
 * lista solo serían ruido: nadie audita un descuento de reojo mientras busca la
 * venta de las tres de la tarde.
 *
 * Una venta con `tipo = 'dano_base'` no aparece en el mapa, y es correcto: un
 * recargo por daño NO tiene líneas, hay un trigger que lo impide.
 */
type LineaResumida = {
  productoNombre: string
  cantidad: number
  precioFinal: string
  precioManual: boolean
}

/**
 * Una venta como la muestran las pantallas: con el nombre del cliente, su
 * documento armado, quién la registró y sus líneas con el nombre del producto.
 *
 * ── Por qué es UNA función y no dos consultas parecidas ─────────────────────
 *
 * La lista la construía a mano y `GET /ventas/:id` devolvía la fila cruda de
 * `ventas`. Las dos «funcionaban», porque la única pantalla que corregía una
 * venta la tomaba de la lista. Cuando Seguimientos quiso abrir el mismo
 * mostrador pidiéndola por id, el modal abrió sin cliente: `correccionDesde`
 * necesita `clienteNombre` y ahí no venía.
 *
 * Dos proyecciones de la misma cosa se separan en silencio, y el que se rompe
 * es el que se usa menos.
 */
async function ventasDelListado(condicion: SQL | undefined) {
  const consulta = db
    .select({
      id: ventas.id,
      clienteId: ventas.clienteId,
      clienteNombre: clientes.nombre,
      clienteTipoDocumento: clientes.tipoDocumento,
      clienteNumeroDocumento: clientes.numeroDocumento,
      tipoClienteAlMomento: ventas.tipoClienteAlMomento,
      medioDePago: ventas.medioDePago,
      canal: ventas.canal,
      tipo: ventas.tipo,
      estado: ventas.estado,
      total: ventas.total,
      codigoDescuentoId: ventas.codigoDescuentoId,
      requiereFacturaElectronica: ventas.requiereFacturaElectronica,
      registradoPor: ventas.registradoPor,
      registradoPorNombre: users.name,
      createdAt: ventas.createdAt,
      anuladaPor: ventas.anuladaPor,
      anuladaEn: ventas.anuladaEn,
      motivoAnulacion: ventas.motivoAnulacion,
      corrigeAId: ventas.corrigeAId,
      corregidaPorId: ventas.corregidaPorId,
      botellonesEntregados: ventas.botellonesEntregados,
      botellonesRecibidos: ventas.botellonesRecibidos,
      direccionId: ventas.direccionId,
      direccionEtiqueta: direcciones.etiqueta,
    })
    .from(ventas)
    .leftJoin(clientes, eq(clientes.id, ventas.clienteId))
    .leftJoin(direcciones, eq(direcciones.id, ventas.direccionId))
    .leftJoin(users, eq(users.id, ventas.registradoPor))
    .orderBy(desc(ventas.createdAt))
    .limit(100)

  const filas = await (condicion ? consulta.where(condicion) : consulta)
  if (filas.length === 0) return []

  const porVenta = await lineasResumidasDe(filas.map((venta) => venta.id))

  return filas.map(({ clienteTipoDocumento, clienteNumeroDocumento, ...venta }) => ({
    ...venta,
    clienteDocumento:
      clienteTipoDocumento && clienteNumeroDocumento
        ? documentoParaMostrar(clienteTipoDocumento, clienteNumeroDocumento)
        : null,
    lineas: porVenta.get(venta.id) ?? [],
  }))
}

async function lineasResumidasDe(ventaIds: string[]): Promise<Map<string, LineaResumida[]>> {
  const lineas = await db
    .select({
      ventaId: lineasDeVenta.ventaId,
      /*
       * El id viaja además del nombre — RN-VEN-16.
       *
       * El nombre es para leer; el id es para VOLVER A ARMAR la venta cuando se
       * la corrige. Sin él, el modal de corrección tendría que adivinar a qué
       * producto del catálogo corresponde cada línea por su nombre, y dos
       * productos que se renombraron parecido bastan para corregir la venta
       * contra el equivocado.
       */
      productoId: lineasDeVenta.productoId,
      productoNombre: productos.nombre,
      cantidad: sql<number>`sum(${lineasDeVenta.cantidad})::int`,
      /*
       * ── El precio va al listado, no solo a la bitácora — RN-VEN-15 ────────
       *
       * `ventas:precio_manual` guarda el delta, pero vive en Auditoría: hay que
       * acordarse de ir. Esta lista es la que alguien mira todos los días, y
       * hasta acá una venta a $3.800 se dibujaba idéntica a una a $10.000.
       *
       * Un control que exige acordarse no es un control.
       *
       * ── Por qué entran en el GROUP BY en vez de agregarse ─────────────────
       *
       * Dentro de una venta, un producto tiene UN precio: el carrito se indexa
       * por `productoId`, así que no hay dos entradas del mismo producto a
       * precios distintos. Agruparlos no parte ninguna fila.
       *
       * Y si esa invariante alguna vez se rompiera, agregarlos con un `max()`
       * lo escondería detrás de un número plausible; agruparlos devuelve DOS
       * filas y se ve. Entre un error visible y uno callado, visible.
       */
      precioFinal: lineasDeVenta.precioFinal,
      precioManual: lineasDeVenta.precioManual,
    })
    .from(lineasDeVenta)
    .innerJoin(productos, eq(productos.id, lineasDeVenta.productoId))
    .where(inArray(lineasDeVenta.ventaId, ventaIds))
    .groupBy(
      lineasDeVenta.ventaId,
      lineasDeVenta.productoId,
      productos.nombre,
      lineasDeVenta.precioFinal,
      lineasDeVenta.precioManual,
    )
    // Por nombre y no por `id`: los UUID son aleatorios, así que sin esto una
    // venta de tres productos se reordena sola entre dos recargas.
    .orderBy(productos.nombre)

  const porVenta = new Map<string, LineaResumida[]>()

  for (const { ventaId, ...linea } of lineas) {
    const acumuladas = porVenta.get(ventaId)
    if (acumuladas) acumuladas.push(linea)
    else porVenta.set(ventaId, [linea])
  }

  return porVenta
}

/**
 * Traduce un error de negocio a su status y lo deja en la bitácora.
 *
 * ── El `resource` se pasa, no se deduce ─────────────────────────────────────
 *
 * Antes salía de un ternario anidado sobre el texto de `action`
 * (`action.startsWith('cobros') ? …`). Funcionaba, y era una bomba de tiempo: un
 * `action` nuevo que no empezara con ninguno de esos prefijos se auditaba como
 * `ventas` **en silencio**, y la bitácora —que existe justamente para poder
 * confiar en ella— tendría filas apuntando al módulo equivocado.
 *
 * El recurso ya lo sabe quien llama, porque es el mismo que le pasó a
 * `requirePermission`. Pedirlo cuesta un argumento y saca el acoplamiento a
 * cómo se escribe un string.
 */
async function manejarError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  resource: 'ventas' | 'cobros' | 'configuracion',
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
