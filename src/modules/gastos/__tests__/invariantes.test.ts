import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { cuentasDeDinero, movimientosDeDinero } from '@/db/schema'
import { CAJAS_INICIALES } from '@/modules/gastos/cajas'
import { PG_ERROR, appSql, ownerSql, pgErrorOf, resetDb } from '@/test/db'

/**
 * Los invariantes del dinero, verificados contra la BASE — ADR-0006.
 *
 * El servicio ya valida y explica; esto comprueba que la garantía sobreviva a
 * lo que no pasa por el servicio: una migración, un script de corrección, un
 * `psql` a las once de la noche. Sin estos tests el `CHECK` podría faltar en la
 * migración y nadie se enteraría — el servicio seguiría validando y todo
 * parecería bien.
 */

let cajaMenor: string
let cajaMayor: string

beforeEach(async () => {
  await resetDb()
  const cuentas = await db.select().from(cuentasDeDinero)
  cajaMenor = cuentas.find((c) => c.tipo === 'caja_menor')!.id
  cajaMayor = cuentas.find((c) => c.tipo === 'caja_mayor')!.id
})

afterAll(async () => {
  await closeDb()
})

/** Un movimiento escrito directo contra la base, sin pasar por el servicio. */
const crudo = (valores: Record<string, unknown>) =>
  db.insert(movimientosDeDinero).values({
    cuentaId: cajaMenor,
    tipo: 'ingreso',
    tipoDeIngreso: 'otro',
    monto: '1000.00',
    ocurridoEl: '2026-11-12',
    concepto: 'un movimiento crudo',
    ...valores,
  } as typeof movimientosDeDinero.$inferInsert)

describe('las dos cajas nacen con el sistema', () => {
  /*
   * El espejo de la semilla. La migración 0030 es la autoridad y
   * `CAJAS_INICIALES` la copia que usan los tests: si alguien cambia una y no la
   * otra, la copia dejaría de reponer lo que producción tiene.
   */
  it('la base tiene exactamente las de `CAJAS_INICIALES`', async () => {
    const cuentas = await db.select().from(cuentasDeDinero)

    expect(cuentas).toHaveLength(CAJAS_INICIALES.length)
    expect(cuentas.map((c) => ({ nombre: c.nombre, tipo: c.tipo })).sort((a, b) => a.nombre.localeCompare(b.nombre))).toEqual(
      [...CAJAS_INICIALES].map((c) => ({ nombre: c.nombre, tipo: c.tipo })).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    )
  })

  it('nacen en cero: el saldo inicial lo carga quien cuenta la plata', async () => {
    const movimientos = await db.select().from(movimientosDeDinero)

    expect(movimientos).toHaveLength(0)
  })

  it('no entra una tercera caja menor', async () => {
    const error = await pgErrorOf(
      db.insert(cuentasDeDinero).values({ nombre: 'Caja menor del mostrador', tipo: 'caja_menor' }),
    )

    expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    expect(error.message).toContain('cuentas_dinero_una_sola_caja_por_tipo')
  })

  it('pero sí entran varias cuentas bancarias', async () => {
    await db.insert(cuentasDeDinero).values([
      { nombre: 'Bancolombia ahorros', tipo: 'banco', banco: 'Bancolombia', numero: '1234', tipoDeCuentaBancaria: 'ahorros' },
      { nombre: 'Davivienda corriente', tipo: 'banco', banco: 'Davivienda', numero: '5678', tipoDeCuentaBancaria: 'corriente' },
    ])

    expect(await db.select().from(cuentasDeDinero)).toHaveLength(4)
  })

  it('dos cuentas con el mismo nombre parten el historial: se rechaza', async () => {
    const error = await pgErrorOf(
      db.insert(cuentasDeDinero).values({ nombre: 'caja MENOR', tipo: 'banco', banco: 'X', numero: '1', tipoDeCuentaBancaria: 'ahorros' }),
    )

    expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
  })

  it('una cuenta bancaria sin número no se puede conciliar: se rechaza', async () => {
    const error = await pgErrorOf(
      db.insert(cuentasDeDinero).values({ nombre: 'Banco sin número', tipo: 'banco', banco: 'Bancolombia' }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('cuentas_dinero_banco_con_sus_datos')
  })

  it('una caja con banco miente sobre dónde está la plata: se rechaza', async () => {
    const error = await pgErrorOf(
      db.insert(cuentasDeDinero).values({ nombre: 'Caja con banco', tipo: 'caja_mayor', banco: 'Bancolombia', numero: '1', tipoDeCuentaBancaria: 'ahorros' }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe('cuentas_dinero_banco_con_sus_datos')
  })
})

describe('el signo lo pone el tipo, y no se puede contradecir', () => {
  it('un egreso nace con efecto negativo aunque el monto sea positivo', async () => {
    const [m] = await crudo({ tipo: 'egreso', tipoDeIngreso: null, tipoDeEgreso: 'otro' }).returning()

    expect(m!.monto).toBe('1000.00')
    expect(m!.efecto).toBe('-1000.00')
  })

  it('un ingreso nace con efecto positivo', async () => {
    const [m] = await crudo({}).returning()

    expect(m!.efecto).toBe('1000.00')
  })

  /*
   * La columna generada es lo que hace que anular no necesite escribir en
   * ninguna otra tabla: el efecto se recalcula solo y el movimiento sale del
   * saldo por aritmética.
   */
  it('anular pone el efecto en cero sin tocar el monto', async () => {
    const [m] = await crudo({ tipo: 'egreso', tipoDeIngreso: null, tipoDeEgreso: 'otro' }).returning()

    const [anulado] = await db
      .update(movimientosDeDinero)
      .set({ anulado: true, motivoAnulacion: 'un motivo suficientemente largo' })
      .where(eq(movimientosDeDinero.id, m!.id))
      .returning()

    expect(anulado!.efecto).toBe('0.00')
    expect(anulado!.monto).toBe('1000.00')
  })

  it('el efecto no se puede escribir a mano: es generada', async () => {
    const sql = appSql()
    try {
      const error = await pgErrorOf(
        sql`INSERT INTO movimientos_de_dinero (cuenta_id, tipo, tipo_de_ingreso, monto, efecto, ocurrido_el, concepto)
            VALUES (${cajaMenor}, 'ingreso', 'otro', '1000.00', '999999.00', '2026-11-12', 'intento de forzar el efecto')`,
      )

      // Postgres rechaza escribir una columna GENERATED ALWAYS.
      expect(error.code).toBe('428C9')
    } finally {
      await sql.end()
    }
  })
})

describe('un movimiento de cero no es un movimiento', () => {
  it('monto cero se rechaza', async () => {
    const error = await pgErrorOf(crudo({ monto: '0.00' }))

    expect(error.constraint).toBe('movimientos_dinero_monto_positivo')
  })

  it('monto negativo se rechaza: el signo lo pone el tipo', async () => {
    const error = await pgErrorOf(crudo({ monto: '-500.00' }))

    expect(error.constraint).toBe('movimientos_dinero_monto_positivo')
  })

  it('un concepto en blanco se rechaza: es lo único que se lee en la lista', async () => {
    const error = await pgErrorOf(crudo({ concepto: '   ' }))

    expect(error.constraint).toBe('movimientos_dinero_concepto_no_vacio')
  })
})

describe('cada tipo trae su contexto y solo el suyo', () => {
  it('un egreso sin tipo de egreso se rechaza', async () => {
    const error = await pgErrorOf(crudo({ tipo: 'egreso', tipoDeIngreso: null }))

    expect(error.constraint).toBe('movimientos_dinero_egreso_con_su_tipo')
  })

  it('un ingreso con tipo de egreso se rechaza: se leería como gasto y sumaría', async () => {
    const error = await pgErrorOf(crudo({ tipoDeEgreso: 'nomina' }))

    expect(error.constraint).toBe('movimientos_dinero_egreso_con_su_tipo')
  })

  it('un saldo inicial no lleva tipo de ingreso ni de egreso', async () => {
    const error = await pgErrorOf(crudo({ tipo: 'saldo_inicial' }))

    expect(error.constraint).toBe('movimientos_dinero_ingreso_con_su_tipo')
  })

  it('una factura sobre un ingreso se rechaza: el papel es del gasto', async () => {
    const error = await pgErrorOf(crudo({ numeroDeFactura: 'FV-001' }))

    expect(error.constraint).toBe('movimientos_dinero_datos_de_egreso_solo_en_egresos')
  })

  it('una clasificación contable sobre un ingreso se rechaza', async () => {
    const error = await pgErrorOf(crudo({ clasificacion: 'gasto' }))

    expect(error.constraint).toBe('movimientos_dinero_datos_de_egreso_solo_en_egresos')
  })
})

describe('un solo saldo inicial por cuenta', () => {
  it('el segundo vigente se rechaza en la BASE, no solo en el servicio', async () => {
    await crudo({ tipo: 'saldo_inicial', tipoDeIngreso: null }).returning()

    const error = await pgErrorOf(crudo({ tipo: 'saldo_inicial', tipoDeIngreso: null }))

    expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    expect(error.message).toContain('movimientos_dinero_un_solo_saldo_inicial')
  })

  it('anulado el primero, el segundo entra', async () => {
    const [primero] = await crudo({ tipo: 'saldo_inicial', tipoDeIngreso: null }).returning()
    await db
      .update(movimientosDeDinero)
      .set({ anulado: true, motivoAnulacion: 'conté mal el cajón la primera vez' })
      .where(eq(movimientosDeDinero.id, primero!.id))

    const [segundo] = await crudo({ tipo: 'saldo_inicial', tipoDeIngreso: null }).returning()

    expect(segundo!.efecto).toBe('1000.00')
  })

  it('cada cuenta tiene el suyo', async () => {
    await crudo({ tipo: 'saldo_inicial', tipoDeIngreso: null }).returning()
    const [otra] = await crudo({
      cuentaId: cajaMayor,
      tipo: 'saldo_inicial',
      tipoDeIngreso: null,
    }).returning()

    expect(otra!.cuentaId).toBe(cajaMayor)
  })
})

describe('el traslado no puede quedar a medias ni ir a sí mismo', () => {
  it('trasladar a la misma cuenta se rechaza: es una fila que miente', async () => {
    const error = await pgErrorOf(
      crudo({
        tipo: 'traslado_salida',
        tipoDeIngreso: null,
        trasladoId: '11111111-1111-1111-1111-111111111111',
        cuentaContraparteId: cajaMenor,
      }),
    )

    expect(error.constraint).toBe('movimientos_dinero_traslado_a_otra_cuenta')
  })

  it('una pata sin su `traslado_id` se rechaza: no se podría emparejar', async () => {
    const error = await pgErrorOf(
      crudo({ tipo: 'traslado_salida', tipoDeIngreso: null, cuentaContraparteId: cajaMayor }),
    )

    expect(error.constraint).toBe('movimientos_dinero_traslado_con_sus_dos_datos')
  })

  it('dos patas del mismo traslado en la misma cuenta se rechazan', async () => {
    const traslado = '22222222-2222-2222-2222-222222222222'
    await crudo({
      tipo: 'traslado_salida',
      tipoDeIngreso: null,
      trasladoId: traslado,
      cuentaContraparteId: cajaMayor,
    }).returning()

    const error = await pgErrorOf(
      crudo({
        tipo: 'traslado_salida',
        tipoDeIngreso: null,
        trasladoId: traslado,
        cuentaContraparteId: cajaMayor,
      }),
    )

    expect(error.code).toBe(PG_ERROR.UNIQUE_VIOLATION)
    expect(error.message).toContain('movimientos_dinero_una_pata_por_cuenta')
  })
})

describe('un movimiento no se edita y no se borra', () => {
  it('cambiarle el monto lo rechaza el trigger', async () => {
    const [m] = await crudo({}).returning()

    const error = await pgErrorOf(
      db.update(movimientosDeDinero).set({ monto: '999.00' }).where(eq(movimientosDeDinero.id, m!.id)),
    )

    expect(error.message).toContain('no se edita')
  })

  it('cambiarle la cuenta lo rechaza el trigger', async () => {
    const [m] = await crudo({}).returning()

    const error = await pgErrorOf(
      db.update(movimientosDeDinero).set({ cuentaId: cajaMayor }).where(eq(movimientosDeDinero.id, m!.id)),
    )

    expect(error.message).toContain('no se edita')
  })

  it('anular lo ya anulado lo rechaza el trigger', async () => {
    const [m] = await crudo({}).returning()
    await db
      .update(movimientosDeDinero)
      .set({ anulado: true, motivoAnulacion: 'una primera anulación válida' })
      .where(eq(movimientosDeDinero.id, m!.id))

    const error = await pgErrorOf(
      db
        .update(movimientosDeDinero)
        .set({ motivoAnulacion: 'otro motivo distinto del primero' })
        .where(eq(movimientosDeDinero.id, m!.id)),
    )

    expect(error.message).toContain('no se modifica')
  })

  it('anular sin motivo se rechaza: el motivo es lo que explica el descuadre', async () => {
    const [m] = await crudo({}).returning()

    const error = await pgErrorOf(
      db.update(movimientosDeDinero).set({ anulado: true }).where(eq(movimientosDeDinero.id, m!.id)),
    )

    expect(error.constraint).toBe('movimientos_dinero_anulacion_con_motivo')
  })

  /*
   * El trigger protege de un bug; esto, de un `psql`. Borrar un movimiento
   * cambiaría el saldo sin dejar rastro — el descuadre imposible de rastrear
   * meses después, porque el libro ya no tendría la fila que lo explica.
   */
  it('la aplicación no puede BORRAR un movimiento', async () => {
    const [m] = await crudo({}).returning()
    const sql = appSql()
    try {
      const error = await pgErrorOf(sql`DELETE FROM movimientos_de_dinero WHERE id = ${m!.id}`)

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    } finally {
      await sql.end()
    }
  })

  it('la aplicación no puede BORRAR una cuenta', async () => {
    const sql = appSql()
    try {
      const error = await pgErrorOf(sql`DELETE FROM cuentas_de_dinero WHERE id = ${cajaMenor}`)

      expect(error.code).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)
    } finally {
      await sql.end()
    }
  })

  /*
   * El `CHECK` no perdona a nadie: el `REVOKE` limita al rol de la aplicación,
   * pero el invariante tiene que valer también para el dueño, que es el que
   * corre las migraciones y los scripts de corrección.
   */
  it('el trigger frena también al DUEÑO de la tabla', async () => {
    const [m] = await crudo({}).returning()
    const sql = ownerSql()
    try {
      const error = await pgErrorOf(
        sql`UPDATE movimientos_de_dinero SET monto = '999.00' WHERE id = ${m!.id}`,
      )

      expect(error.message).toContain('no se edita')
    } finally {
      await sql.end()
    }
  })
})
