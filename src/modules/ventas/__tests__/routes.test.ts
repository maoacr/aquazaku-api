import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, productos, ventas } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'
import { usuarioAutenticado, direccionDe } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let productoId: string
let clienteId: string
let direccionId: string

const HOY = new Date().toISOString().slice(0, 10)

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

  const [producto] = await db
    .insert(productos)
    .values({
      codigo: 'BOT_20L',
      nombre: 'Recarga de botellón de 20 L',
      presentacion: 'botellon',
      contenidoMl: 20000,
      unidades: 1,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })
    .returning()
  productoId = producto!.id

  await crearLoteConEntrada(
    { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
    db,
  )

  const [cliente] = await db
    .insert(clientes)
    .values({
      nombreLibre: 'Yeimy',
      tipoDocumento: 'CC',
      numeroDocumento: '79123456',
      verificacionEstado: 'verificado',
      verificadoEn: new Date(),
      verificacionMetodo: 'admin_oficial',
      creditoHabilitado: true,
    })
    .returning()
  clienteId = cliente!.id
  direccionId = await direccionDe(clienteId)
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

const como = async (rol: Role, pedido: Omit<InjectOptions, 'headers'>) => {
  const usuario = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie: usuario.cookie } })
}

const UNA_VENTA = { medioDePago: 'efectivo', items: [{ productoId: '', cantidad: 2 }] }
/*
 * Con cliente va SIEMPRE la dirección — RN-VEN-18. Va acá para que los casos
 * que miran alcance, filtros o auditoría no tengan que hablar de direcciones.
 */
const conProducto = (extra: Record<string, unknown> = {}) => ({
  ...UNA_VENTA,
  items: [{ productoId, cantidad: 2 }],
  ...('clienteId' in extra && extra.clienteId ? { direccionId } : {}),
  ...extra,
})

/**
 * Fechar una venta hacia atrás deja rastro propio — RN-VEN-14.
 *
 * ── Por qué se prueba acá y no en el servicio ───────────────────────────────
 *
 * La bitácora la escribe la RUTA. Un test del servicio pasaría con la auditoría
 * borrada, y la promesa se perdería sin que nada avise — que es exactamente cómo
 * se pierden las promesas.
 *
 * ── Y por qué importa que exista ────────────────────────────────────────────
 *
 * RN-VEN-14 acepta a propósito que un reporte ya emitido cambie. Lo único que
 * acota ese costo es poder reconstruir quién movió una venta de un mes a otro.
 * Sin esta fila, un total que no cuadra contra una copia impresa no tiene
 * explicación.
 */
describe('POST /ventas con fecha anterior', () => {
  const ayer = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
      new Date(Date.now() - 86_400_000),
    )

  it('la venta queda fechada ayer', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ ocurrioEn: ayer() }),
    })

    expect(res.statusCode).toBe(201)

    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
      new Date(res.json().venta.createdAt),
    )
    expect(dia).toBe(ayer())
  })

  it('deja una fila de `ventas:crear_retroactiva` con las dos fechas', async () => {
    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ ocurrioEn: ayer() }),
    })

    const [fila] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:crear_retroactiva'))

    expect(fila).toBeDefined()
    expect((fila!.payload as { ocurrioEn: string }).ocurrioEn).toBe(ayer())
    expect((fila!.payload as { registradaEl: string }).registradaEl).not.toBe(ayer())
  })

  it('una venta de hoy no deja esa fila: no hay nada excepcional que contar', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const filas = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:crear_retroactiva'))

    expect(filas).toHaveLength(0)
  })

  it('el futuro se rechaza con 422 y dice por qué', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ ocurrioEn: '2099-01-01' }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().mensaje).toMatch(/todavía no/i)
  })
})

describe('POST /ventas', () => {
  it('el `pos` vende: es quien está en el mostrador', async () => {
    const res = await como('pos', { method: 'POST', url: '/ventas', payload: conProducto() })

    expect(res.statusCode).toBe(201)
    expect(res.json().venta.total).toBe('20000.00')
  })

  it('el `contador` mira pero no vende', async () => {
    expect((await como('contador', { method: 'GET', url: '/ventas' })).statusCode).toBe(200)

    const res = await como('contador', { method: 'POST', url: '/ventas', payload: conProducto() })
    expect(res.statusCode).toBe(403)
  })

  it('un intento denegado queda auditado', async () => {
    await como('contador', { method: 'POST', url: '/ventas', payload: conProducto() })

    const [ultimo] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('ventas')
  })

  it('vender más de lo que hay responde 422 con el número real', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 999 }] }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('STOCK_INSUFICIENTE')
    expect(res.json().mensaje).toMatch(/quedan 100/)
  })

  it('a crédito sin cliente lo atrapa Zod antes que el servicio', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ medioDePago: 'credito' }),
    })

    // El CHECK de la base también lo impediría; acá falla antes, y está bien.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})

/**
 * ── El contrato incluye lo que NO existe ────────────────────────────────────
 *
 * Una venta confirmada no se edita — RN-VEN-02. Es la regla que más se pide
 * romper por comodidad y la que más caro sale romper.
 */
describe('una venta no se edita', () => {
  it('no existe PATCH', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    expect(
      (await comoAdmin({
        method: 'PATCH',
        url: `/ventas/${venta.venta.id}`,
        payload: { total: '1.00' },
      })).statusCode,
    ).toBe(404)
  })

  it('no existe DELETE', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/ventas/${venta.venta.id}` })).statusCode,
    ).toBe(404)
  })
})

/**
 * ── Corregir es un sub-recurso, no una edición — RN-VEN-16 ──────────────────
 *
 * Que exista `POST /ventas/:id/correccion` no afloja nada de lo de arriba: el
 * `PATCH` sigue sin existir y el trigger sigue rechazando cualquier `UPDATE`
 * que toque el monto. Lo que este endpoint agrega es el reemplazo hecho de una
 * sola vez, con las dos filas enlazadas.
 */
describe('corregir una venta', () => {
  it('devuelve la nueva y la reemplazada, enlazadas', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({ motivo: 'se cargó el producto equivocado en el mostrador' }),
    })

    expect(res.statusCode).toBe(201)
    const { venta, reemplazada } = res.json()
    expect(reemplazada.id).toBe(original.venta.id)
    expect(reemplazada.estado).toBe('corregida')
    expect(reemplazada.corregidaPorId).toBe(venta.id)
    expect(venta.corrigeAId).toBe(original.venta.id)
  })

  /**
   * El permiso es `ventas:corregir`, que solo tiene el admin. Un `pos` con
   * `ventas:anular` sobre lo propio NO lo hereda: corregir escribe una venta
   * con la fecha de otra, y eso esquiva el tope de 90 días de RN-VEN-14.
   */
  it('un pos no puede, ni sobre su propia venta', async () => {
    const pos = await usuarioAutenticado('pos')
    const original = (
      await app.inject({
        method: 'POST',
        url: '/ventas',
        payload: conProducto(),
        headers: { cookie: pos.cookie },
      })
    ).json()

    const res = await app.inject({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({ motivo: 'me equivoqué de producto al cargarla' }),
      headers: { cookie: pos.cookie },
    })

    expect(res.statusCode).toBe(403)
  })

  /**
   * RN-ACC-04 — el rechazo de permiso deja fila en la bitácora.
   *
   * `requirePermission` emite `result: 'denied'` antes de salir, así que un
   * `pos` que intente corregir queda registrado igual que un éxito. Esto es lo
   * que hace auditable el intento de backdoor contra el piso de 90 días.
   */
  it('un intento denegado de seller queda en la bitácora con result=denied', async () => {
    const pos = await usuarioAutenticado('pos')
    const original = (
      await app.inject({
        method: 'POST',
        url: '/ventas',
        payload: conProducto(),
        headers: { cookie: pos.cookie },
      })
    ).json()

    const res = await app.inject({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({ motivo: 'intento de seller para auditar 403' }),
      headers: { cookie: pos.cookie },
    })

    expect(res.statusCode).toBe(403)

    const [fila] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:corregir'))

    expect(fila?.result).toBe('denied')
  })

  it('sin motivo suficiente rebota en la validación', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({ motivo: 'mal' }),
    })

    expect(res.statusCode).toBe(400)
  })

  /**
   * `ocurrioEn` opcional en la corrección — RN-VEN-16 fecha corregible.
   *
   * Por default la corrección hereda el instante de la venta que reemplaza;
   * cuando el admin manda un `ocurrioEn` válido, ese día nuevo le gana a la
   * herencia. Cuando es futuro o a más de 90 días, el piso de RN-VEN-14
   * corto-circuita con 422 — la original sigue `confirmada`.
   */
  it('acepta una fecha válida distinta a la original y la persiste', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({
        motivo: 'se cargó con la fecha equivocada: era de tres días atrás',
        ocurrioEn: '2026-08-20',
      }),
    })

    expect(res.statusCode).toBe(201)
    /*
     * 2026-08-20 al mediodía de Bogotá es 2026-08-20T17:00:00.000Z — el helper
     * ancla a `T12:00:00-05:00`, y la zona se serializa a UTC.
     */
    expect(res.json().venta.createdAt).toBe('2026-08-20T17:00:00.000Z')
  })

  it('rechaza `ocurrioEn` futuro con 422 VENTA_EN_EL_FUTURO', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({
        motivo: 'intento de fecha futura debe ser rechazado por RN-VEN-14',
        ocurrioEn: '2099-01-01',
      }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('VENTA_EN_EL_FUTURO')
  })

  it('rechaza `ocurrioEn` a más de 90 días con 422 VENTA_DEMASIADO_VIEJA', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({
        motivo: 'intento de fecha más vieja que el piso de 90 días',
        ocurrioEn: '2026-01-01',
      }),
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('VENTA_DEMASIADO_VIEJA')
  })

  it('deja una fila de bitácora con el antes y el después', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({
        items: [{ productoId, cantidad: 5 }],
        motivo: 'se cargaron 2 y habían salido 5',
      }),
    })

    const [fila] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:corregir'))

    const payload = fila?.payload as { totalAnterior: string; totalNuevo: string }
    expect(payload.totalAnterior).toBe(original.venta.total)
    expect(payload.totalNuevo).not.toBe(original.venta.total)
  })

  /**
   * RN-VEN-16-AUDIT — la corrección con override registra **ambas** fechas.
   *
   * La clave singular `ocurrioEn` desapareció del payload de
   * `ventas:corregir`. Si reaparece, la UI de auditoría la confundiría con la
   * fecha nueva y el reporte mezclaría las dos cosas.
   */
  it('la auditoría registra ambas fechas cuando hay override, y borra la singular', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({
        motivo: 'verifico que la auditoría registra ambas fechas distintas',
        ocurrioEn: '2026-08-20',
      }),
    })

    const [fila] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:corregir'))

    const payload = fila?.payload as Record<string, unknown>
    expect(payload.ocurrioEnAnterior).toBe(original.venta.createdAt)
    expect(payload.ocurrioEnNuevo).not.toBe(payload.ocurrioEnAnterior)
    expect(payload.ocurrioEnNuevo).toBe('2026-08-20T17:00:00.000Z')
    expect(payload.ocurrioEn).toBeUndefined()
  })

  /**
   * Sin override, la auditoría registra la misma fecha en ambos campos.
   *
   * La nueva venta hereda el instante exacto de la vieja, y los dos campos del
   * payload valen lo mismo — pero están **ambos** presentes, no uno solo.
   */
  it('la auditoría registra la misma fecha en ambos campos cuando no hay override', async () => {
    const original = (
      await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })
    ).json()

    await comoAdmin({
      method: 'POST',
      url: `/ventas/${original.venta.id}/correccion`,
      payload: conProducto({
        motivo: 'verifico que hereda y la auditoría lo refleja en los dos campos',
      }),
    })

    const [fila] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:corregir'))

    const payload = fila?.payload as Record<string, unknown>
    expect(payload.ocurrioEnAnterior).toBe(payload.ocurrioEnNuevo)
    expect(payload.ocurrioEn).toBeUndefined()
  })
})

/**
 * ── El alcance sale de la matriz, no de la ruta ─────────────────────────────
 *
 * `pos` y `seller` ven y anulan lo PROPIO; `admin`, todo.
 */
describe('el alcance de ver y anular', () => {
  it('un `pos` solo ve sus ventas', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const res = await como('pos', { method: 'GET', url: '/ventas' })

    expect(res.json()).toHaveLength(0)
  })

  it('el `admin` ve todas', async () => {
    await como('pos', { method: 'POST', url: '/ventas', payload: conProducto() })

    expect((await comoAdmin({ method: 'GET', url: '/ventas' })).json()).toHaveLength(1)
  })

  it('un `pos` no anula la venta de otro', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    const res = await como('pos', {
      method: 'POST',
      url: `/ventas/${venta.venta.id}/anulacion`,
      payload: { motivo: 'me equivoqué de producto al cargar' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('NO_ES_SU_VENTA')
  })

  it('sin motivo no se anula, ni siendo admin', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/ventas/${venta.venta.id}/anulacion`,
      payload: { motivo: 'x' },
    })

    expect(res.statusCode).toBe(400)
  })
})

/**
 * ── Cada fila de la lista tiene que explicarse sola ─────────────────────────
 *
 * La pantalla de ventas promete «qué salió, a quién y cómo se pagó». De las
 * tres, la fila cruda contesta una: `clienteId` y `registradoPor` son UUIDs, y
 * las líneas viven en otra tabla.
 *
 * Resolverlo desde `web/` costaría una consulta por fila —o traerse la tabla de
 * clientes entera, que es justo lo que el mostrador dejó de hacer—. Así que los
 * nombres viajan resueltos, igual que en el libro de movimientos de stock.
 */
describe('GET /ventas — cada fila se explica sola', () => {
  it('trae el nombre del cliente y el de quien la registró', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.clienteNombre).toBe('Yeimy')
    expect(fila.registradoPorNombre).toBe('Usuario de prueba')
  })

  /*
   * El caso NORMAL del mostrador: alguien compra un botellón y se va. `null` no
   * es un dato que faltó cargar — es la venta sin cliente que la tabla permite
   * a propósito (ver el comentario de `ventas.clienteId`).
   */
  it('una venta sin cliente llega con `clienteNombre` en null', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.clienteId).toBeNull()
    expect(fila.clienteNombre).toBeNull()
  })

  it('trae qué se vendió: el nombre del producto y cuántos', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.lineas).toEqual([
      {
        /* El id viaja además del nombre: es con lo que el modal de corrección
           vuelve a armar la venta — RN-VEN-16. */
        productoId,
        productoNombre: 'Recarga de botellón de 20 L',
        cantidad: 2,
        precioFinal: '10000.00',
        precioManual: false,
      },
    ])
  })

  /*
   * ── Una línea es un par producto+LOTE, y eso no se muestra ────────────────
   *
   * Pedir 150 cuando el primer lote tiene 100 parte la venta en dos líneas del
   * MISMO producto (FEFO). El lote importa para el stock y para anular; en la
   * lista sería «100 × Recarga» y «50 × Recarga», dos renglones para una sola
   * cosa que se pidió una vez.
   */
  it('dos lotes del mismo producto son UNA línea en la lista', async () => {
    await crearLoteConEntrada(
      { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
      db,
    )

    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 150 }] }),
    })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.lineas).toEqual([
      {
        /* El id viaja además del nombre: es con lo que el modal de corrección
           vuelve a armar la venta — RN-VEN-16. */
        productoId,
        productoNombre: 'Recarga de botellón de 20 L',
        cantidad: 150,
        precioFinal: '10000.00',
        precioManual: false,
      },
    ])
  })

  /*
   * Un recargo por daño es una venta con `tipo = 'dano_base'` y SIN líneas —hay
   * un trigger que lo impide, migración 0009—. Sin el `tipo` en la respuesta, la
   * pantalla lo dibujaría como una venta a la que se le perdieron los productos.
   */
  it('un recargo por daño llega con su tipo y sin líneas', async () => {
    await db
      .insert(ventas)
      .values({
        clienteId,
        direccionId,
        medioDePago: 'efectivo',
        tipo: 'dano_base',
        total: '35000.00',
      })

    const [fila] = (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.tipo).toBe('dano_base')
    expect(fila.lineas).toEqual([])
  })

  /*
   * Los botellones despachados y recibidos viven en la lista — RN-VEN-17.
   *
   * El modal de corrección los pre-carga con los valores originales desde
   * `GET /ventas` (no desde `GET /ventas/:id`, porque la lista alimenta la
   * corrección). Sin estos dos campos en el listado, la corrección abría con
   * los contadores en cero aunque la venta original hubiera movido
   * botellones.
   */
  it('trae los botellones despachados y recibidos de la transacción', async () => {
    /*
     * El cap es `entregados <= cantidad_de_botellones` (RN-VEN-17) — la
     * venta lleva 5 y despacha 3 / recibe 2, así el server no rechaza con
     * BOTELLONES_SIN_RESPALDO.
     */
    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: {
        ...conProducto({ clienteId }),
        items: [{ productoId, cantidad: 5 }],
        botellonesEntregados: 3,
        botellonesRecibidos: 2,
      },
    })

    const [fila] = await (await comoAdmin({ method: 'GET', url: '/ventas' })).json()

    expect(fila.botellonesEntregados).toBe(3)
    expect(fila.botellonesRecibidos).toBe(2)
  })

  /*
   * Una venta CORREGIDA NO aparece en la lista — RN-VEN-16 + cambio UX.
   *
   * La corrección NO es un PATCH: crea una venta nueva y marca la vieja
   * como `estado='corregida'`. Sin este filtro, la lista mostraría dos
   * filas para una sola operación lógica. La nueva venta hereda el
   * `createdAt` de la vieja, así que aparece en su misma posición
   * temporal — eso es lo que permite que la fila "no salte" cuando se
   * corrige.
   */
  it('después de corregir, la vieja NO aparece: solo la nueva', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })
    const vieja = (await (await comoAdmin({ method: 'GET', url: '/ventas' })).json())[0]

    await comoAdmin({
      method: 'POST',
      url: `/ventas/${vieja.id}/correccion`,
      payload: {
        motivo: 'se cobraron 8.000 y quedaron 10.000 por unidad',
        medioDePago: 'efectivo',
        items: [{ productoId, cantidad: 2 }],
      },
    })

    const filas = (await (await comoAdmin({ method: 'GET', url: '/ventas' })).json())

    expect(filas).toHaveLength(1)
    expect(filas[0].id).not.toBe(vieja.id)
    expect(filas[0].corrigeAId).toBe(vieja.id)
  })
})

/**
 * ── Las ventas de UN cliente — `?clienteId` ────────────────────────────────
 *
 * La ficha de un cliente muestra sus últimas ventas, y la única forma de
 * armarla sin este filtro sería traerse las cien últimas del negocio y
 * descartar en `web/` las que no son suyas: un cliente que compró la semana
 * pasada quedaría sin una sola venta a la vista porque el corte de cien se lo
 * comió.
 *
 * El filtro es el MISMO parámetro que ya usa `GET /cobros?clienteId`. No es un
 * endpoint nuevo: es la misma lista, recortada.
 */
describe('GET /ventas?clienteId — las ventas de un cliente', () => {
  const otroCliente = async () => {
    const [otro] = await db
      .insert(clientes)
      .values({ nombreLibre: 'Wilmer', tipoDocumento: 'CC', numeroDocumento: '1098765432' })
      .returning()

    // Su propia dirección: la foránea compuesta impide entregarle a uno en la
    // dirección del otro (RN-VEN-18).
    return { clienteId: otro!.id, direccionId: await direccionDe(otro!.id) }
  }

  it('trae solo las de ese cliente', async () => {
    const otro = await otroCliente()
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId: otro.clienteId, direccionId: otro.direccionId }) })
    // La de mostrador: sin cliente, y no es de nadie.
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const filas = (await comoAdmin({ method: 'GET', url: `/ventas?clienteId=${clienteId}` })).json()

    expect(filas).toHaveLength(1)
    expect(filas[0].clienteNombre).toBe('Yeimy')
    expect(filas[0].lineas).toEqual([
      {
        /* El id viaja además del nombre: es con lo que el modal de corrección
           vuelve a armar la venta — RN-VEN-16. */
        productoId,
        productoNombre: 'Recarga de botellón de 20 L',
        cantidad: 2,
        precioFinal: '10000.00',
        precioManual: false,
      },
    ])
  })

  /*
   * El filtro RECORTA, no reemplaza: un `pos` filtrando por cliente sigue
   * viendo lo propio. Si las dos condiciones no se combinaran, este parámetro
   * sería una puerta de atrás a la matriz (RN-ACC-03) — y se abriría desde la
   * barra de direcciones.
   */
  it('el alcance del rol sigue mandando', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })

    const res = await como('pos', { method: 'GET', url: `/ventas?clienteId=${clienteId}` })

    expect(res.json()).toHaveLength(0)
  })

  it('sin el parámetro siguen llegando todas', async () => {
    const otro = await otroCliente()
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId }) })
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto({ clienteId: otro.clienteId, direccionId: otro.direccionId }) })

    expect((await comoAdmin({ method: 'GET', url: '/ventas' })).json()).toHaveLength(2)
  })
})

describe('los cobros', () => {
  const venderACredito = () =>
    comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ medioDePago: 'credito', clienteId }),
    })

  it('un cobro parcial deja la deuda restante', async () => {
    await venderACredito()

    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '5000.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().deudaRestante).toBe('15000.00')
    expect(res.json().quedaSaldada).toBe(false)
  })

  it('cobrar de más se rechaza con la deuda real', async () => {
    await venderACredito()

    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '99999.00', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('COBRO_MAYOR_QUE_LA_DEUDA')
  })

  /** `credito` no es un medio de PAGO: pagar deuda con deuda no la reduce. */
  it('no se cobra a crédito', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/cobros',
      payload: { clienteId, monto: '5000.00', medioDePago: 'credito' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('la deuda del cliente es consultable', async () => {
    await venderACredito()

    const res = await comoAdmin({ method: 'GET', url: `/clientes/${clienteId}/deuda` })

    expect(res.json().deuda).toBe('20000.00')
  })
})

describe('los códigos de descuento son del admin — RN-VEN-13', () => {
  const UN_CODIGO = {
    codigo: 'VERANO2026',
    tipo: 'porcentaje',
    valor: '10',
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2026-12-31',
  }

  it('el `pos` no los crea', async () => {
    expect(
      (await como('pos', { method: 'POST', url: '/descuentos', payload: UN_CODIGO })).statusCode,
    ).toBe(403)
  })

  it('el admin sí, y se aplica en la venta', async () => {
    expect(
      (await comoAdmin({ method: 'POST', url: '/descuentos', payload: UN_CODIGO })).statusCode,
    ).toBe(201)

    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ codigoDescuento: 'VERANO2026' }),
    })

    expect(res.json().venta.total).toBe('18000.00')
  })

  it('se desactivan, no se borran', async () => {
    const codigo = (await comoAdmin({ method: 'POST', url: '/descuentos', payload: UN_CODIGO })).json()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/descuentos/${codigo.id}` })).statusCode,
    ).toBe(404)

    const res = await comoAdmin({ method: 'PATCH', url: `/descuentos/${codigo.id}/desactivar` })
    expect(res.json().activo).toBe(false)
  })
})

describe('la devolución', () => {
  it('vuelve al stock y queda colgada de la venta', async () => {
    const venta = (await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })).json()
    const detalle = (await comoAdmin({ method: 'GET', url: `/ventas/${venta.venta.id}` })).json()

    const res = await comoAdmin({
      method: 'POST',
      url: '/devoluciones',
      payload: {
        lineaId: detalle.lineas[0].id,
        cantidad: 1,
        estadoProducto: 'sano',
        motivo: 'el cliente pidió de menos de lo que necesitaba',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().volvioAlStock).toBe(true)

    const conDevolucion = (await comoAdmin({ method: 'GET', url: `/ventas/${venta.venta.id}` })).json()
    expect(conDevolucion.devoluciones).toHaveLength(1)
  })
})

/**
 * El precio escrito a mano deja rastro propio — RN-VEN-15.
 *
 * ── Por qué se prueba acá y no en el servicio ───────────────────────────────
 *
 * Por lo mismo que la venta retroactiva: la bitácora la escribe la RUTA, y un
 * test del servicio pasaría con la auditoría borrada.
 *
 * ── Y por qué esta fila carga más peso que la otra ──────────────────────────
 *
 * Porque acá el permiso NO discrimina: cualquiera con `ventas:crear` —admin,
 * pos y seller— puede escribir un precio. Fue una decisión tomada a sabiendas,
 * y lo que la hace sostenible es que la fila guarde el precio de lista AL LADO
 * del cobrado. Sin el de lista no hay delta, y sin delta la bitácora dice «se
 * vendió a 3.800», que es justo lo que ya dice la venta.
 */
describe('POST /ventas con precio escrito a mano', () => {
  const filasDePrecioManual = () =>
    db.select().from(auditLog).where(eq(auditLog.action, 'ventas:precio_manual'))

  it('deja una fila con el precio de lista y el cobrado', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 2, precioManual: '3800' }] }),
    })

    expect(res.statusCode).toBe(201)

    const [fila] = await filasDePrecioManual()
    const items = (fila!.payload as { items: Record<string, unknown>[] }).items

    expect(items).toEqual([
      {
        productoId,
        cantidad: 2,
        precioDeLista: '10000.00',
        precioCobrado: '3800.00',
        subtotal: '7600.00',
      },
    ])
  })

  it('una venta a precio de lista no deja esa fila', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    expect(await filasDePrecioManual()).toHaveLength(0)
  })

  /**
   * FIFO parte un ítem en una línea POR LOTE. La bitácora registra el ACTO
   * HUMANO, y el acto fue uno: alguien tildó un checkbox y escribió un número.
   *
   * Auditar por línea convertiría esa única decisión en dos filas con cantidades
   * que nadie escribió, y quien lea esto en tres meses concluiría que hubo dos
   * precios manuales. Una bitácora que multiplica los hechos es peor que ninguna.
   */
  it('escribe UNA entrada por ítem aunque FIFO parta la venta en dos lotes', async () => {
    await crearLoteConEntrada(
      { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
      db,
    )

    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 120, precioManual: '3800' }] }),
    })

    const [fila] = await filasDePrecioManual()
    const items = (fila!.payload as { items: { cantidad: number }[] }).items

    expect(items).toHaveLength(1)
    expect(items[0]?.cantidad).toBe(120)
  })

  /**
   * El permiso es `ventas:crear`, que el seller tiene. Esto no es un descuido:
   * está acá para que el día que alguien quiera restringirlo, este test se ponga
   * rojo y la decisión se tome a propósito en vez de por deriva.
   */
  it('un seller también puede, y queda con su nombre en la fila', async () => {
    const res = await como('seller', {
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 1, precioManual: '3500' }] }),
    })

    expect(res.statusCode).toBe(201)

    const [fila] = await filasDePrecioManual()
    expect(fila?.userId).not.toBeNull()
  })
})

/**
 * El listado dice qué líneas llevaron precio escrito a mano — RN-VEN-15.
 *
 * ── Por qué no alcanza con la bitácora ──────────────────────────────────────
 *
 * `ventas:precio_manual` guarda el delta, pero vive en Auditoría: hay que
 * acordarse de ir. La lista de últimas ventas es la pantalla que alguien mira
 * de verdad, todos los días, y hasta acá una venta a $3.800 se dibujaba
 * idéntica a una a $10.000.
 *
 * Un control que exige acordarse no es un control. Y son ventas como cualquier
 * otra —suman al total, al reporte y al arqueo—, así que esconder que se
 * cobraron distinto es esconderlo en el único lugar donde se iba a ver.
 */
describe('GET /ventas marca las líneas con precio escrito a mano', () => {
  const listar = async () => {
    const res = await comoAdmin({ method: 'GET', url: '/ventas' })
    return res.json() as {
      id: string
      lineas: { productoNombre: string; cantidad: number; precioFinal: string; precioManual: boolean }[]
    }[]
  }

  it('devuelve `precioManual` y el precio cobrado', async () => {
    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 2, precioManual: '3800' }] }),
    })

    const [venta] = await listar()

    expect(venta?.lineas[0]).toMatchObject({
      cantidad: 2,
      precioFinal: '3800.00',
      precioManual: true,
    })
  })

  it('una venta a precio de lista viene con `precioManual` en false', async () => {
    await comoAdmin({ method: 'POST', url: '/ventas', payload: conProducto() })

    const [venta] = await listar()

    expect(venta?.lineas[0]).toMatchObject({ precioFinal: '10000.00', precioManual: false })
  })

  /**
   * FIFO parte un ítem en una línea POR LOTE, y el listado las agrupa por
   * producto. Las dos mitades llevan el mismo precio, así que la agrupación
   * tiene que devolver UNA fila con la cantidad completa — no dos con la misma
   * etiqueta, que se leerían como dos precios distintos.
   */
  it('agrupa las dos mitades de un ítem partido por FIFO en una sola línea', async () => {
    await crearLoteConEntrada(
      { productoId, fechaEmpaque: HOY, cantidad: 100, tipo: 'produccion', registradoPor: null },
      db,
    )

    await comoAdmin({
      method: 'POST',
      url: '/ventas',
      payload: conProducto({ items: [{ productoId, cantidad: 120, precioManual: '3800' }] }),
    })

    const [venta] = await listar()

    expect(venta?.lineas).toHaveLength(1)
    expect(venta?.lineas[0]).toMatchObject({ cantidad: 120, precioManual: true })
  })
})
