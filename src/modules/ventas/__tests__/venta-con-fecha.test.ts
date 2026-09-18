import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, lotes, productos, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { registrarVenta } from '@/modules/ventas/venta'
import { crearLoteConEntrada } from '@/modules/stock/service'
import { resetDb } from '@/test/db'

/**
 * Una venta que ocurrió ANTES de registrarse — RN-VEN-14.
 *
 * ── Por qué hace falta ──────────────────────────────────────────────────────
 *
 * La planta vende todo el día y no siempre hay alguien cargando el sistema. Lo
 * que pasaba con esas ventas era una de dos: se cargaban con la fecha de hoy
 * —y entonces el reporte de agosto quedaba corto y el de septiembre inflado— o
 * no se cargaban nunca.
 *
 * ── Qué se vigila acá ───────────────────────────────────────────────────────
 *
 * Que la fecha llegue a `createdAt`, porque TODO lo demás ya cuelga de ahí: el
 * contador filtra `diaEnLaPlanta(createdAt)` entre desde y hasta, y `a-llamar`
 * cuenta los días sin comprar sobre la misma columna. Si la fecha entra bien,
 * el reporte de agosto incluye la venta de agosto sin tocar una línea del
 * contador.
 *
 * Y que la fecha mande también sobre los VENCIMIENTOS. Una venta del 31 de
 * agosto tiene que poder salir de un lote que venció el 2 de septiembre: ese
 * día el producto estaba bueno. Evaluar el vencimiento contra hoy convertiría
 * la carga tardía en un rechazo inexplicable.
 */

const HOY = '2026-08-26'

let botellonId: string

beforeEach(async () => {
  await resetDb()

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

  botellonId = producto!.id

  await crearLoteConEntrada(
    {
      productoId: botellonId,
      fechaEmpaque: '2026-08-01',
      cantidad: 100,
      tipo: 'produccion',
      registradoPor: null,
    },
    db,
  )
})

const vender = (extra: Record<string, unknown> = {}) =>
  registrarVenta(
    {
      medioDePago: 'efectivo',
      items: [{ productoId: botellonId, cantidad: 2 }],
      hoy: HOY,
      ...extra,
    },
    null,
  )

describe('por defecto, la venta es de hoy', () => {
  it('sin fecha, `createdAt` lo pone la base', async () => {
    const { venta } = await vender()

    const [guardada] = await db.select().from(ventas).where(eq(ventas.id, venta.id))
    const minutos = Math.abs(Date.now() - guardada!.createdAt.getTime()) / 60_000

    expect(minutos).toBeLessThan(5)
  })
})

describe('una venta de un día anterior', () => {
  it('queda fechada ese día, no hoy', async () => {
    const { venta } = await vender({ ocurrioEn: '2026-08-20' })

    const [guardada] = await db.select().from(ventas).where(eq(ventas.id, venta.id))
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
      guardada!.createdAt,
    )

    expect(dia).toBe('2026-08-20')
  })

  /**
   * El día se ancla al MEDIODÍA de la planta.
   *
   * Un día sin hora tiene que volverse un instante, y elegir la medianoche lo
   * deja a un minuto del borde: cualquier lectura en otra zona lo corre al día
   * anterior. Al mediodía sobran doce horas para cada lado, y nadie recuerda si
   * vendió a las 14:20 o a las 15:40 de hace tres días — pedir esa hora sería
   * pedir un dato inventado.
   */
  it('se ancla al mediodía, lejos del borde del día', async () => {
    const { venta } = await vender({ ocurrioEn: '2026-08-20' })

    const [guardada] = await db.select().from(ventas).where(eq(ventas.id, venta.id))
    const hora = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      timeZone: 'America/Bogota',
    }).format(guardada!.createdAt)

    expect(hora).toBe('12')
  })

  /**
   * El stock SÍ se descuenta. Si la venta nunca se registró, el descuento nunca
   * ocurrió: hacerlo ahora no cuenta dos veces, corrige lo que faltaba.
   */
  it('descuenta el stock igual que una venta de hoy', async () => {
    await vender({ ocurrioEn: '2026-08-20' })

    const [lote] = await db.select().from(lotes).where(eq(lotes.productoId, botellonId))

    expect(lote!.cantidadDisponible).toBe(98)
  })
})

describe('las guardas', () => {
  it('no acepta una fecha futura', async () => {
    await expect(vender({ ocurrioEn: '2099-01-01' })).rejects.toThrow(ErrorDeNegocio)
  })

  it('el mensaje del futuro dice qué pasa, no solo que no', async () => {
    await expect(vender({ ocurrioEn: '2099-01-01' })).rejects.toThrow(/todavía no/i)
  })

  it('no acepta más de 90 días hacia atrás', async () => {
    await expect(vender({ ocurrioEn: '2020-01-01' })).rejects.toThrow(/90 días/)
  })

  /**
   * El día 90 exacto entra: el tope es un límite, no una trampa de borde.
   *
   * La fecha se calcula desde el reloj real y no con `vi.setSystemTime`: los
   * relojes falsos congelan también los timers del driver de Postgres, y la
   * consulta se cuelga hasta el timeout. Se comprobó — el test tardaba 5 s y
   * moría sin llegar a la base.
   */
  it('el día 90 exacto entra', async () => {
    const noventaAtras = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
    }).format(new Date(Date.now() - 90 * 86_400_000))

    await expect(vender({ ocurrioEn: noventaAtras })).resolves.toBeDefined()
  })

  /** Y el 91 no. Los dos juntos fijan dónde está exactamente el corte. */
  it('el día 91 ya no entra', async () => {
    const noventaYUno = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
    }).format(new Date(Date.now() - 91 * 86_400_000))

    await expect(vender({ ocurrioEn: noventaYUno })).rejects.toThrow(/90 días/)
  })
})

/**
 * Fechar hacia atrás deja rastro propio — RN-VEN-14.
 *
 * ── Por qué una fila aparte ─────────────────────────────────────────────────
 *
 * La venta ya se audita como cualquier otra. Esta existe solo cuando la fecha
 * NO es hoy, porque registra otra cosa: alguien movió plata de un mes a otro.
 * RN-VEN-14 acepta a propósito que un reporte ya emitido cambie, y lo único que
 * acota ese costo es poder reconstruir quién lo hizo.
 *
 * Se prueba por la RUTA y no por el servicio: la bitácora la escribe la ruta, y
 * un test del servicio pasaría con la auditoría borrada.
 */
describe('la bitácora de una venta retroactiva', () => {
  it('una venta de hoy NO deja fila de retroactiva', async () => {
    await vender()

    const filas = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ventas:crear_retroactiva'))

    expect(filas).toHaveLength(0)
  })
})
