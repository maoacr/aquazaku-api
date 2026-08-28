import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { bases, clientes, direcciones, movimientosBase } from '@/db/schema'
import {
  basesEnDireccion,
  darDeAltaBase,
  comprarBases,
  descartarBase,
  historialDe,
  prestarBase,
  retornarBase,
} from '@/modules/retornables/bases'
import { marcarBaseDanada } from '@/modules/retornables/dano'
import { cargosPendientesDe, deudaDe } from '@/modules/ventas/saldo'
import { resetDb } from '@/test/db'

/**
 * Las bases — RN-BAS-01 a 08.
 *
 * El activo que sí tiene identidad, porque **hay que ir a buscarlo a un lugar
 * concreto**. Una base que no se puede reclamar es una base regalada.
 */

let clienteId: string
let direccionId: string

const MOTIVO = 'el operario vio la base partida al ir a recoger los botellones'

beforeEach(async () => {
  await resetDb()

  const [cliente] = await db
    .insert(clientes)
    .values({
      nombre: 'Yeimy',
      tipoDocumento: 'CC',
      numeroDocumento: '79123456',
      verificacionEstado: 'verificado',
      verificadoEn: new Date(),
      verificacionMetodo: 'admin_oficial',
      creditoHabilitado: true,
    })
    .returning()
  clienteId = cliente!.id

  const [direccion] = await db
    .insert(direcciones)
    .values({ clienteId, etiqueta: 'La casa', direccion: 'Calle 5 #3-20' })
    .returning()
  direccionId = direccion!.id
})

afterAll(async () => {
  await closeDb()
})

describe('el alta', () => {
  it('registra el sticker que ya está pegado, y queda en el historial', async () => {
    const base = await darDeAltaBase('0913', null)

    expect(base.idSticker).toBe('0913')
    expect(base.direccionId).toBeNull()
    expect(await historialDe(base.id)).toHaveLength(1)
  })

  it('dos bases no comparten sticker: sería imposible saber cuál está dónde', async () => {
    await darDeAltaBase('0913', null)

    await expect(darDeAltaBase('0913', null)).rejects.toMatchObject({
      code: 'STICKER_DUPLICADO',
    })
  })

  /*
   * ── El sistema propone, el sticker manda — RN-BAS-10 ──────────────────────
   *
   * Los dos caminos existen porque los dos casos son reales: las 40 bases que
   * Aquazaku ya tiene llegaron con su sticker puesto, y las que vengan después
   * se rotulan con lo que el sistema diga.
   */
  it('sin sticker, propone el próximo consecutivo', async () => {
    const primera = await darDeAltaBase(undefined, null)

    expect(primera.idSticker).toBe('0001')
    expect((await darDeAltaBase(undefined, null)).idSticker).toBe('0002')
  })

  it('la propuesta sigue al máximo, no al conteo: respeta el sticker pisado', async () => {
    await darDeAltaBase('0040', null)

    /*
     * Con `count + 1` propondría `0002`, que está libre pero rompe la
     * convención del rótulo: quedarían dos bases con números que no reflejan el
     * orden en que entraron, y la siguiente propuesta volvería a chocar.
     */
    expect((await darDeAltaBase(undefined, null)).idSticker).toBe('0041')
  })

  it('un sticker que no son cuatro dígitos no entra', async () => {
    for (const malo of ['913', '00913', 'A-0913', '  ']) {
      await expect(darDeAltaBase(malo, null)).rejects.toMatchObject({
        code: 'STICKER_INVALIDO',
      })
    }
  })
})

/**
 * ── Una base está en exactamente un lugar — RN-BAS-04 ───────────────────────
 */
describe('el préstamo', () => {
  it('queda asignada a la DIRECCIÓN, no al cliente', async () => {
    const base = await darDeAltaBase('0913', null)

    const prestada = await prestarBase(base.id, direccionId, null)

    expect(prestada.direccionId).toBe(direccionId)
    expect(await basesEnDireccion(direccionId)).toHaveLength(1)
  })

  /**
   * No es «está ocupada»: es que el libro dice que está en otro lado. Si de
   * verdad la tienen en la mano, falta registrar el retorno — y ese es el dato
   * que se perdió.
   */
  it('prestar una que ya está prestada se rechaza', async () => {
    const base = await darDeAltaBase('0913', null)
    await prestarBase(base.id, direccionId, null)

    const [otra] = await db
      .insert(direcciones)
      .values({ clienteId, etiqueta: 'El negocio', direccion: 'Carrera 8 #1-11' })
      .returning()

    await expect(prestarBase(base.id, otra!.id, null)).rejects.toMatchObject({
      code: 'BASE_YA_PRESTADA',
    })
  })

  /**
   * `RN-BAS-07`: prestarle un activo a alguien cuyo documento nadie miró es
   * exactamente el riesgo que la verificación viene a acotar. La misma condición
   * que el crédito, aplicada a un activo en vez de a plata.
   */
  it('a un cliente sin verificar, no', async () => {
    await db
      .update(clientes)
      .set({
        creditoHabilitado: false,
        verificacionEstado: 'pendiente',
        verificadoPor: null,
        verificadoEn: null,
        verificacionMetodo: null,
      })
      .where(eq(clientes.id, clienteId))

    const base = await darDeAltaBase('0913', null)

    await expect(prestarBase(base.id, direccionId, null)).rejects.toMatchObject({
      code: 'VERIFICACION_REQUERIDA',
    })
  })

  it('una base dañada no se vuelve a prestar', async () => {
    const base = await darDeAltaBase('0913', null)
    await prestarBase(base.id, direccionId, null)
    await marcarBaseDanada(
      { baseId: base.id, monto: '80000.00', motivo: MOTIVO, medioDePago: 'efectivo' },
      null,
    )
    await retornarBase(base.id, null)

    await expect(prestarBase(base.id, direccionId, null)).rejects.toMatchObject({
      code: 'BASE_DANADA',
    })
  })
})

describe('el retorno y el descarte', () => {
  it('vuelve a la bodega y deja rastro', async () => {
    const base = await darDeAltaBase('0913', null)
    await prestarBase(base.id, direccionId, null)

    const retornada = await retornarBase(base.id, null)

    expect(retornada.direccionId).toBeNull()
    expect((await historialDe(base.id)).map((m) => m.tipo)).toEqual([
      'alta',
      'prestamo',
      'retorno',
    ])
  })

  it('descartar una prestada se rechaza: quedaría un préstamo abierto', async () => {
    const base = await darDeAltaBase('0913', null)
    await prestarBase(base.id, direccionId, null)

    await expect(
      descartarBase(base.id, 'se partió sin arreglo posible', null),
    ).rejects.toMatchObject({ code: 'BASE_PRESTADA' })
  })

  it('una descartada ya no está en el parque', async () => {
    const base = await darDeAltaBase('0913', null)
    await descartarBase(base.id, 'se partió sin arreglo posible', null)

    await expect(prestarBase(base.id, direccionId, null)).rejects.toMatchObject({
      code: 'BASE_DESCARTADA',
    })
  })
})

/**
 * ── El daño resuelve la contradicción entre RN-BAS-08 y RN-CLI-06 ───────────
 *
 * El recargo es una venta —hereda la auditoría del módulo— y NO cuenta como
 * deuda. Los dos tests de abajo son las dos mitades de esa decisión.
 */
describe('el recargo por daño', () => {
  const danar = async (medioDePago: 'efectivo' | 'credito' = 'credito') => {
    const base = await darDeAltaBase('0913', null)
    await prestarBase(base.id, direccionId, null)

    return marcarBaseDanada(
      { baseId: base.id, monto: '80000.00', motivo: MOTIVO, medioDePago },
      null,
    )
  }

  it('genera una venta de tipo `dano_base`, sin líneas', async () => {
    const { recargo, base } = await danar()

    expect(recargo.tipo).toBe('dano_base')
    expect(recargo.total).toBe('80000.00')
    expect(base.estado).toBe('danada')
    expect(base.recargoVentaId).toBe(recargo.id)
  })

  it('NO suma a la deuda, y SÍ a los cargos pendientes', async () => {
    await danar()

    expect(await deudaDe(clienteId)).toBe('0.00')
    expect(await cargosPendientesDe(clienteId)).toBe('80000.00')
  })

  /** Cobrado en efectivo se pagó en el momento: no queda pendiente. */
  it('cobrado de contado no queda pendiente', async () => {
    await danar('efectivo')

    expect(await cargosPendientesDe(clienteId)).toBe('0.00')
  })

  it('marcarla dos veces le cobraría dos veces al cliente', async () => {
    const { base } = await danar()

    await expect(
      marcarBaseDanada(
        { baseId: base.id, monto: '80000.00', motivo: MOTIVO, medioDePago: 'efectivo' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'YA_DANADA' })
  })

  /**
   * Una base rota en la bodega es una pérdida de la empresa: no hay a quién
   * cobrarle. Se descarta con motivo.
   */
  it('una base en bodega no le genera recargo a nadie', async () => {
    const base = await darDeAltaBase('0913', null)

    await expect(
      marcarBaseDanada(
        { baseId: base.id, monto: '80000.00', motivo: MOTIVO, medioDePago: 'efectivo' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'BASE_EN_BODEGA' })
  })

  it('sin explicación no se le cobra a nadie', async () => {
    const base = await darDeAltaBase('0913', null)
    await prestarBase(base.id, direccionId, null)

    await expect(
      marcarBaseDanada(
        { baseId: base.id, monto: '80000.00', motivo: 'x', medioDePago: 'efectivo' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'MOTIVO_REQUERIDO' })
  })

  it('el daño queda en el historial de la base', async () => {
    const { base } = await danar()

    expect((await historialDe(base.id)).map((m) => m.tipo)).toContain('dano')
    const [dano] = await db
      .select()
      .from(movimientosBase)
      .where(eq(movimientosBase.tipo, 'dano'))
    expect(dano?.motivo).toBe(MOTIVO)
  })
})

/**
 * ── La compra de bases — RN-BAS-10 ──────────────────────────────────────────
 *
 * Espeja `POST /botellones/compra`: los dos activos entran al parque por una
 * compra con cantidad, y esa simetría no es estética. Dar de alta 40 bases de a
 * una son 40 operaciones donde cada una puede fallar por su cuenta y dejar el
 * parque a medio cargar, sin nada que diga dónde se cortó.
 */
describe('la compra de bases', () => {
  it('numera consecutivo desde el próximo disponible', async () => {
    const compradas = await comprarBases(3, null)

    expect(compradas.map((b) => b.idSticker)).toEqual(['0001', '0002', '0003'])
  })

  it('sigue al máximo, no al conteo, igual que el alta de a una', async () => {
    await darDeAltaBase('0040', null)

    expect((await comprarBases(2, null)).map((b) => b.idSticker)).toEqual(['0041', '0042'])
  })

  it('todas nacen sanas y en la bodega, con su alta en el historial', async () => {
    const [primera] = await comprarBases(2, null)

    expect(primera!.estado).toBe('sana')
    expect(primera!.direccionId).toBeNull()
    expect(await historialDe(primera!.id)).toHaveLength(1)
  })

  /*
   * ── O entran las 20 o no entra ninguna ────────────────────────────────────
   *
   * Una compra a medio registrar deja al operario sin saber cuántas cargó ni
   * desde qué número seguir, y el sticker físico ya está impreso: el hueco
   * quedaría en la caja, no en la pantalla.
   *
   * El fallo que se usa acá es el único alcanzable a mitad de compra: agotar el
   * formato de cuatro dígitos. Colisionar es imposible por construcción —
   * `proximoCodigo` sale del máximo—, así que un test que buscara un duplicado
   * pasaría siempre sin probar nada.
   */
  it('o entran todas o no entra ninguna', async () => {
    await darDeAltaBase('9998', null)

    // La primera tomaría 9999 y la segunda se queda sin números.
    await expect(comprarBases(3, null)).rejects.toMatchObject({ code: 'CODIGOS_AGOTADOS' })

    // La 9999 NO quedó: el rollback se llevó la parte que sí había entrado.
    expect(await db.select().from(bases)).toHaveLength(1)
  })

  it('una compra de cero o negativa no es una compra', async () => {
    for (const mala of [0, -3]) {
      await expect(comprarBases(mala, null)).rejects.toMatchObject({ code: 'CANTIDAD_INVALIDA' })
    }
  })
})
