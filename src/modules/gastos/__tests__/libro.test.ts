import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { type Ejecutor, closeDb, db } from '@/db/client'
import { auditLog, cuentasDeDinero, movimientosDeDinero, proveedores } from '@/db/schema'
import { hoyEnLaPlanta } from '@/lib/dia'
import { cuentasConSaldo, saldoDe } from '@/modules/gastos/cuentas'
import {
  anularMovimiento,
  gastosPorTipo,
  listarMovimientos,
  registrarEgreso,
  registrarIngreso,
  registrarSaldoInicial,
} from '@/modules/gastos/libro'
import { poolConcurrente, resetDb } from '@/test/db'

/**
 * El libro de dinero — M17.
 *
 * Lo que se prueba acá es que la plata cuadre: que el saldo sea siempre la suma
 * del libro, que ninguna cuenta quede en negativo por ninguna vía, y que anular
 * revierta exactamente lo que el movimiento había hecho.
 */

const UN_CONTEXTO = { userId: null, rolEjercido: ['admin'], requestId: 'req-de-prueba' }
const HOY = hoyEnLaPlanta()

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

/** Deja plata en la caja para poder gastarla. */
const fondear = (cuentaId: string, monto: string) =>
  registrarSaldoInicial(
    { cuentaId, monto, ocurridoEl: HOY, concepto: 'lo que había en el cajón' },
    null,
    UN_CONTEXTO,
  )

const gastar = (cuentaId: string, monto: string, extra: object = {}, conexion?: Ejecutor) =>
  registrarEgreso(
    {
      cuentaId,
      tipoDeEgreso: 'servicio',
      monto,
      ocurridoEl: HOY,
      concepto: 'un gasto de prueba',
      ...extra,
    },
    null,
    UN_CONTEXTO,
    conexion,
  )

describe('el saldo es la suma del libro, no una columna', () => {
  it('una cuenta sin movimientos vale cero y aparece igual en la lista', async () => {
    const cuentas = await cuentasConSaldo()

    expect(cuentas).toHaveLength(2)
    expect(cuentas.map((c) => c.saldo)).toEqual(['0.00', '0.00'])
  })

  it('un ingreso suma y un egreso resta', async () => {
    await fondear(cajaMenor, '500000')
    await gastar(cajaMenor, '120000')

    expect(await saldoDe(cajaMenor)).toBe(38000000)
  })

  /*
   * El invariante central del módulo. Si esto falla, el saldo dejó de ser
   * explicable por el libro y el módulo no sirve para lo único que tiene que
   * servir.
   */
  it('el saldo de la cuenta siempre iguala la suma de sus efectos', async () => {
    await fondear(cajaMenor, '1000000')
    await registrarIngreso(
      {
        cuentaId: cajaMenor,
        tipoDeIngreso: 'recaudo_de_ventas',
        monto: '250000',
        ocurridoEl: HOY,
        concepto: 'el efectivo del lunes',
      },
      null,
      UN_CONTEXTO,
    )
    await gastar(cajaMenor, '80000')
    await gastar(cajaMenor, '45500.50')

    const filas = await db
      .select()
      .from(movimientosDeDinero)
      .where(eq(movimientosDeDinero.cuentaId, cajaMenor))

    const sumaDelLibro = filas.reduce((t, f) => t + Math.round(Number(f.efecto) * 100), 0)

    expect(await saldoDe(cajaMenor)).toBe(sumaDelLibro)
    // 1.000.000 + 250.000 − 80.000 − 45.500,50
    expect(sumaDelLibro).toBe(112449950)
  })

  it('el efecto lo pone el tipo: el egreso nace negativo sin que nadie lo firme', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')

    expect(egreso.monto).toBe('120000.00')
    expect(egreso.efecto).toBe('-120000.00')
  })

  it('cada cuenta lleva su propio saldo', async () => {
    await fondear(cajaMenor, '300000')
    await fondear(cajaMayor, '2000000')
    await gastar(cajaMenor, '100000')

    expect(await saldoDe(cajaMenor)).toBe(20000000)
    expect(await saldoDe(cajaMayor)).toBe(200000000)
  })
})

describe('ninguna cuenta queda en negativo', () => {
  it('un gasto mayor al saldo se rechaza, y el mensaje dice qué falta', async () => {
    await fondear(cajaMenor, '50000')

    await expect(gastar(cajaMenor, '80000')).rejects.toMatchObject({
      code: 'SALDO_INSUFICIENTE',
      status: 422,
    })
    expect(await saldoDe(cajaMenor)).toBe(5000000)
  })

  it('gastar exactamente el saldo sí se puede: deja la caja en cero', async () => {
    await fondear(cajaMenor, '50000')
    await gastar(cajaMenor, '50000')

    expect(await saldoDe(cajaMenor)).toBe(0)
  })

  it('una caja vacía no paga nada', async () => {
    await expect(gastar(cajaMenor, '1000')).rejects.toMatchObject({ code: 'SALDO_INSUFICIENTE' })
  })

  /**
   * El caso que el `FOR UPDATE` existe para cubrir.
   *
   * ── Por qué va por `pool.db` y no por el `db` de siempre ────────────────
   *
   * El pool de la aplicación corre con `max: 1` en tests. Lanzados contra él,
   * los cinco egresos **se encolan**: el segundo lee el saldo ya descontado y
   * falla por su cuenta, así que el test pasaría igual sin el bloqueo — lo
   * comprobé borrando el `FOR UPDATE` y quedó verde. Era un test de
   * secuencialidad con nombre de test de concurrencia, justo lo que advierte
   * `poolConcurrente`.
   *
   * Con cinco conexiones reales, sin el bloqueo los cinco leen el mismo saldo
   * de 100.000 y los cinco pasan: la caja queda en −300.000.
   */
  it('cinco gastos simultáneos contra el mismo saldo no lo sobregiran', async () => {
    await fondear(cajaMenor, '100000')

    const pool = poolConcurrente(5)
    try {
      const intentos = await Promise.allSettled(
        Array.from({ length: 5 }, () => gastar(cajaMenor, '80000', {}, pool.db)),
      )

      const pasaron = intentos.filter((i) => i.status === 'fulfilled').length

      // Con 100.000 en la caja y gastos de 80.000, entra exactamente uno.
      expect(pasaron).toBe(1)
      expect(await saldoDe(cajaMenor)).toBe(2000000)
    } finally {
      await pool.cerrar()
    }
  })
})

describe('el saldo inicial se carga una sola vez', () => {
  it('el segundo se rechaza: sería la misma plata contada dos veces', async () => {
    await fondear(cajaMenor, '500000')

    await expect(fondear(cajaMenor, '500000')).rejects.toMatchObject({
      code: 'SALDO_INICIAL_YA_CARGADO',
      status: 422,
    })
    expect(await saldoDe(cajaMenor)).toBe(50000000)
  })

  it('después de anularlo se puede volver a cargar', async () => {
    const primero = await fondear(cajaMenor, '500000')
    await anularMovimiento(primero.id, 'conté mal el cajón, eran 400.000', UN_CONTEXTO)

    await fondear(cajaMenor, '400000')

    expect(await saldoDe(cajaMenor)).toBe(40000000)
  })

  it('cada cuenta tiene el suyo', async () => {
    await fondear(cajaMenor, '100000')
    await fondear(cajaMayor, '900000')

    expect(await saldoDe(cajaMayor)).toBe(90000000)
  })
})

describe('anular revierte exactamente lo que el movimiento hizo', () => {
  it('anular un gasto devuelve la plata al saldo', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')

    await anularMovimiento(egreso.id, 'lo cargué en la caja equivocada', UN_CONTEXTO)

    expect(await saldoDe(cajaMenor)).toBe(50000000)
  })

  it('el anulado queda con efecto cero, no se borra', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')

    const anulado = await anularMovimiento(egreso.id, 'estaba mal el monto', UN_CONTEXTO)

    expect(anulado.anulado).toBe(true)
    expect(anulado.efecto).toBe('0.00')
    expect(anulado.monto).toBe('120000.00')
    expect(anulado.motivoAnulacion).toBe('estaba mal el monto')
  })

  /**
   * El caso que se olvida: anular en la otra dirección.
   *
   * Anular un ingreso del que ya se gastó la plata dejaría la cuenta en
   * negativo. La plata se gastó de verdad; lo que está mal es creer que ese
   * ingreso no existió.
   */
  it('no se anula un ingreso cuya plata ya se gastó', async () => {
    const ingreso = await fondear(cajaMenor, '500000')
    await gastar(cajaMenor, '400000')

    await expect(
      anularMovimiento(ingreso.id, 'me equivoqué al cargar el inicial', UN_CONTEXTO),
    ).rejects.toMatchObject({ code: 'ANULAR_DEJARIA_SALDO_NEGATIVO', status: 422 })

    expect(await saldoDe(cajaMenor)).toBe(10000000)
  })

  it('un movimiento anulado no se vuelve a anular', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')
    await anularMovimiento(egreso.id, 'primera anulación válida', UN_CONTEXTO)

    await expect(
      anularMovimiento(egreso.id, 'segunda anulación que no corresponde', UN_CONTEXTO),
    ).rejects.toMatchObject({ code: 'MOVIMIENTO_YA_ANULADO' })
  })

  it('el motivo corto se rechaza: es lo que va a explicar el descuadre', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')

    await expect(anularMovimiento(egreso.id, 'error', UN_CONTEXTO)).rejects.toMatchObject({
      code: 'MOTIVO_INSUFICIENTE',
    })
  })
})

describe('la fecha es cuándo ocurrió, y no puede ser mañana', () => {
  it('un gasto con fecha futura se rechaza', async () => {
    await fondear(cajaMenor, '500000')
    const manana = new Date(`${HOY}T12:00:00Z`)
    manana.setUTCDate(manana.getUTCDate() + 1)

    await expect(
      gastar(cajaMenor, '1000', { ocurridoEl: manana.toISOString().slice(0, 10) }),
    ).rejects.toMatchObject({ code: 'FECHA_FUTURA' })
  })

  it('un gasto de hace una semana entra: se registra tarde, pasó antes', async () => {
    await fondear(cajaMenor, '500000')
    const antes = new Date(`${HOY}T12:00:00Z`)
    antes.setUTCDate(antes.getUTCDate() - 7)
    const fecha = antes.toISOString().slice(0, 10)

    const egreso = await gastar(cajaMenor, '30000', { ocurridoEl: fecha })

    expect(egreso.ocurridoEl).toBe(fecha)
  })
})

describe('el monto va en positivo: el signo lo pone el tipo', () => {
  it('cero no mueve plata', async () => {
    await fondear(cajaMenor, '500000')

    await expect(gastar(cajaMenor, '0')).rejects.toMatchObject({ code: 'MONTO_INVALIDO' })
  })
})

describe('en qué se gastó la plata del período', () => {
  it('agrupa por tipo, de mayor a menor, y no cuenta los anulados', async () => {
    await fondear(cajaMayor, '5000000')
    await gastar(cajaMayor, '300000', { tipoDeEgreso: 'nomina', concepto: 'quincena de noviembre' })
    await gastar(cajaMayor, '150000', { tipoDeEgreso: 'nomina', concepto: 'quincena, el otro' })
    await gastar(cajaMayor, '90000', { tipoDeEgreso: 'energia', concepto: 'la luz' })
    const anulado = await gastar(cajaMayor, '700000', {
      tipoDeEgreso: 'equipo',
      concepto: 'un computador que devolvimos',
    })
    await anularMovimiento(anulado.id, 'lo devolvimos, nunca se pagó', UN_CONTEXTO)

    expect(await gastosPorTipo(HOY, HOY)).toEqual([
      { tipoDeEgreso: 'nomina', total: '450000.00', cuantos: 2 },
      { tipoDeEgreso: 'energia', total: '90000.00', cuantos: 1 },
    ])
  })

  it('no mezcla los ingresos: la pregunta es en qué se gastó', async () => {
    await fondear(cajaMenor, '500000')
    await registrarIngreso(
      {
        cuentaId: cajaMenor,
        tipoDeIngreso: 'aporte_socio',
        monto: '200000',
        ocurridoEl: HOY,
        concepto: 'un aporte del socio',
      },
      null,
      UN_CONTEXTO,
    )
    await gastar(cajaMenor, '70000', { tipoDeEgreso: 'transporte', concepto: 'gasolina del camión' })

    expect(await gastosPorTipo(HOY, HOY)).toEqual([
      { tipoDeEgreso: 'transporte', total: '70000.00', cuantos: 1 },
    ])
  })
})

describe('el libro se puede leer', () => {
  it('trae el nombre de la cuenta resuelto y los anulados afuera', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')
    await anularMovimiento(egreso.id, 'cargado en la caja equivocada', UN_CONTEXTO)

    const filas = await listarMovimientos()

    expect(filas).toHaveLength(1)
    expect(filas[0]!.cuenta).toBe('Caja menor')
    expect(filas[0]!.tipo).toBe('saldo_inicial')
  })

  it('con `incluirAnulados` aparecen, con su motivo', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')
    await anularMovimiento(egreso.id, 'cargado en la caja equivocada', UN_CONTEXTO)

    const filas = await listarMovimientos({ incluirAnulados: true })

    expect(filas).toHaveLength(2)
    expect(filas.find((f) => f.id === egreso.id)!.motivoAnulacion).toBe(
      'cargado en la caja equivocada',
    )
  })

  it('un gasto con proveedor trae su nombre; uno sin proveedor no desaparece', async () => {
    const [prov] = await db.insert(proveedores).values({ nombre: 'Plásticos del Caribe' }).returning()
    await fondear(cajaMenor, '500000')
    await gastar(cajaMenor, '50000', { proveedorId: prov!.id, concepto: 'repuesto de la planta' })
    await gastar(cajaMenor, '30000', { beneficiario: 'el electricista', concepto: 'arreglo de luz' })

    const filas = await listarMovimientos({ tipo: 'egreso' })

    expect(filas).toHaveLength(2)
    expect(filas.map((f) => f.proveedor ?? f.beneficiario).sort()).toEqual([
      'Plásticos del Caribe',
      'el electricista',
    ])
  })

  it('filtra por cuenta', async () => {
    await fondear(cajaMenor, '100000')
    await fondear(cajaMayor, '900000')

    expect(await listarMovimientos({ cuentaId: cajaMayor })).toHaveLength(1)
  })
})

describe('la bitácora explica el movimiento sin ir a buscar nada — ADR-0007', () => {
  it('el gasto deja su fila con el saldo resultante', async () => {
    await fondear(cajaMenor, '500000')
    await gastar(cajaMenor, '120000')

    const filas = await db.select().from(auditLog).where(eq(auditLog.action, 'gastos:crear'))
    const egreso = filas.find(
      (f) => (f.payload as { operacion?: string } | null)?.operacion === 'egreso',
    )

    expect(egreso?.resource).toBe('gastos')
    expect(egreso?.payload).toMatchObject({
      operacion: 'egreso',
      tipoDeEgreso: 'servicio',
      cuenta: 'Caja menor',
      monto: '120000.00',
      saldoResultante: '380000.00',
    })
  })

  it('la anulación deja el efecto que revirtió', async () => {
    await fondear(cajaMenor, '500000')
    const egreso = await gastar(cajaMenor, '120000')
    await anularMovimiento(egreso.id, 'cargado en la caja equivocada', UN_CONTEXTO)

    const [fila] = await db.select().from(auditLog).where(eq(auditLog.action, 'gastos:anular'))

    expect(fila?.payload).toMatchObject({
      operacion: 'anulacion',
      motivo: 'cargado en la caja equivocada',
      efectoRevertido: '-120000.00',
      saldoResultante: '500000.00',
    })
  })
})
