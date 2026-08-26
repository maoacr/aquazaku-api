import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { movimientosAgua } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import {
  CAPACIDAD,
  NIVELES,
  ajustarAgua,
  bandaDe,
  nivelDe,
  reconciliar,
  registrarIngreso,
  saldoDe,
} from '@/modules/produccion/agua'
import { resetDb } from '@/test/db'

/**
 * El balance del agua y la reconciliación.
 *
 * Lo que se prueba acá no es la aritmética: es que el sistema **no invente
 * precisión**. Un tanque cuyo nivel se estima a ojo en cuartos no puede
 * reportarse en litros exactos, y el saldo calculado no puede sobrescribirse
 * con una lectura visual.
 */

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

/** Mete litros directo al libro, para armar un saldo sin pasar por un cierre. */
async function sembrarSaldo(tanque: 'crudo' | 'procesado', litros: number) {
  await db
    .insert(movimientosAgua)
    .values({ tanque, litros, tipo: 'ajuste', motivo: 'saldo inicial para la prueba' })
}

describe('las bandas de nivel — RN-PRD-11 y RN-PRD-15', () => {
  /**
   * El ejemplo que está escrito en el dominio.
   *
   * Si este test falla, o cambió la capacidad o cambió el criterio de bandas —
   * y en los dos casos hay que actualizar la regla, no el test.
   */
  it('MEDIO en el tanque de 13.000 L es 4.875 – 8.125, como dice RN-PRD-15', () => {
    expect(bandaDe('crudo', 'medio')).toMatchObject({ desde: 4875, hasta: 8125 })
  })

  it('las bandas se TOCAN: no hay saldo que caiga fuera de todas', () => {
    // Si no se tocaran, habría litros de los que el sistema no sabría qué decir.
    const bandas = NIVELES.map((n) => bandaDe('crudo', n))

    for (let i = 0; i < bandas.length - 1; i += 1) {
      expect(bandas[i]!.hasta).toBe(bandas[i + 1]!.desde)
    }
  })

  it('los extremos se recortan a la capacidad real', () => {
    // `vacio` no puede empezar en negativo ni `lleno` pasarse del tanque.
    expect(bandaDe('crudo', 'vacio').desde).toBe(0)
    expect(bandaDe('crudo', 'lleno').hasta).toBe(CAPACIDAD.crudo)
    expect(bandaDe('procesado', 'lleno').hasta).toBe(CAPACIDAD.procesado)
  })

  it('cada banda contiene su propio nominal', () => {
    for (const nivel of NIVELES) {
      const banda = bandaDe('crudo', nivel)
      expect(nivelDe('crudo', Math.round((banda.desde + banda.hasta) / 2))).toBe(nivel)
    }
  })

  /**
   * ── Las fronteras ────────────────────────────────────────────────────────
   *
   * Es donde una reconciliación se equivoca: un `>` en vez de un `>=` deja un
   * litro huérfano entre dos bandas, y esa discrepancia aparece una vez cada
   * tanto sin patrón — la peor de encontrar.
   */
  it('el límite exacto entre dos bandas pertenece a la de arriba', () => {
    // 4.875 es el fin de `un_cuarto` y el inicio de `medio`.
    expect(nivelDe('crudo', 4875)).toBe('medio')
    // 8.125 es el fin de `medio` y el inicio de `tres_cuartos`.
    expect(nivelDe('crudo', 8125)).toBe('tres_cuartos')
  })

  it('un litro menos que el límite cae en la banda de abajo', () => {
    expect(nivelDe('crudo', 4874)).toBe('un_cuarto')
    expect(nivelDe('crudo', 8124)).toBe('medio')
  })

  it('cero es vacío y la capacidad es lleno', () => {
    expect(nivelDe('crudo', 0)).toBe('vacio')
    expect(nivelDe('crudo', CAPACIDAD.crudo)).toBe('lleno')
  })
})

describe('la reconciliación NO escribe — RN-PRD-14', () => {
  it('cuando el saldo cae en la banda observada, cuadra', async () => {
    await sembrarSaldo('crudo', 6500)

    const r = await reconciliar('crudo', 'medio')

    expect(r.cuadra).toBe(true)
    expect(r.ajusteSugerido).toBe(0)
  })

  it('un saldo justo en la frontera de la banda cuadra igual', async () => {
    // Los extremos son inclusivos: 4.875 ES medio tanque.
    await sembrarSaldo('crudo', 4875)

    expect((await reconciliar('crudo', 'medio')).cuadra).toBe(true)
  })

  it('cuando cae afuera, marca la discrepancia y sugiere el ajuste', async () => {
    await sembrarSaldo('crudo', 2000)

    const r = await reconciliar('crudo', 'medio')

    expect(r.cuadra).toBe(false)
    expect(r.nivelCalculado).toBe('un_cuarto')
    expect(r.nivelObservado).toBe('medio')
    // Hasta el CENTRO de la banda observada: 6.500 − 2.000.
    expect(r.ajusteSugerido).toBe(4500)
  })

  /**
   * El error obvio y el peor: reemplazar el saldo por la lectura.
   *
   * «Medio tanque» de 13.000 L es un rango de 3.250 litros. Poner el centro de
   * ese rango pierde información y encima parece más preciso.
   */
  it('reconciliar no toca el libro ni el saldo', async () => {
    await sembrarSaldo('crudo', 2000)

    await reconciliar('crudo', 'lleno')

    expect((await saldoDe('crudo')).litros).toBe(2000)
    expect(await db.select().from(movimientosAgua)).toHaveLength(1)
  })
})

describe('el ingreso de la red se registra SIN cantidad', () => {
  /**
   * El hueco declarado como hueco.
   *
   * No hay medidor ni regleta. Registrar el hecho sin cantidad es lo que
   * mantiene separado lo medido de lo estimado: si acá se pusiera un número a
   * ojo, el día que el saldo no cuadre nadie sabría si el problema fue el
   * consumo, la merma o esa estimación.
   */
  it('el movimiento va en cero litros', async () => {
    const movimiento = await registrarIngreso('crudo', null)

    expect(movimiento.litros).toBe(0)
    expect(movimiento.tipo).toBe('ingreso_red')
  })

  it('y por lo tanto NO mueve el saldo', async () => {
    await sembrarSaldo('crudo', 3000)
    await registrarIngreso('crudo', null)

    expect((await saldoDe('crudo')).litros).toBe(3000)
  })

  it('el saldo sube después, con un ajuste que exige motivo', async () => {
    await sembrarSaldo('crudo', 3000)
    await registrarIngreso('crudo', null)

    const saldo = await ajustarAgua(
      'crudo',
      3500,
      'llegó agua de la red y el tanque quedó a medio llenar',
      null,
    )

    expect(saldo.litros).toBe(6500)
    expect(saldo.nivelCalculado).toBe('medio')
  })
})

describe('el ajuste exige explicación y respeta los límites físicos', () => {
  it('rechaza un motivo corto', async () => {
    await sembrarSaldo('crudo', 3000)

    await expect(ajustarAgua('crudo', 500, 'x', null)).rejects.toMatchObject({
      code: 'MOTIVO_REQUERIDO',
    })
  })

  it('rechaza un ajuste de cero', async () => {
    await expect(
      ajustarAgua('crudo', 0, 'no encontré diferencia en el conteo', null),
    ).rejects.toMatchObject({ code: 'AJUSTE_INVALIDO' })
  })

  it('rechaza dejar el tanque en negativo', async () => {
    await sembrarSaldo('crudo', 1000)

    await expect(
      ajustarAgua('crudo', -5000, 'el conteo dio mucho menos de lo esperado', null),
    ).rejects.toMatchObject({ code: 'SALDO_NEGATIVO' })
  })

  /**
   * Un saldo por encima de la capacidad significa que el libro perdió el rastro
   * de una salida. Taparlo con un ajuste al alza esconde el problema en vez de
   * resolverlo — y el mensaje dice justamente eso.
   */
  it('rechaza pasar de la capacidad, y dice por qué', async () => {
    await sembrarSaldo('crudo', 12_000)

    try {
      await ajustarAgua('crudo', 5000, 'el tanque se ve más lleno de lo que dice', null)
      throw new Error('debería haber fallado')
    } catch (err) {
      expect(err).toBeInstanceOf(ErrorDeNegocio)
      expect((err as ErrorDeNegocio).code).toBe('SOBRE_CAPACIDAD')
      expect((err as ErrorDeNegocio).message).toMatch(/falta registrar una salida/)
    }
  })

  it('un ajuste válido queda en el libro con su motivo', async () => {
    await sembrarSaldo('crudo', 3000)
    await ajustarAgua('crudo', -500, 'conteo del lunes: había menos de lo calculado', null)

    const movimientos = await db.select().from(movimientosAgua)
    const ajuste = movimientos.find((m) => m.litros === -500)

    expect(ajuste?.tipo).toBe('ajuste')
    expect(ajuste?.motivo).toMatch(/conteo del lunes/)
  })
})

describe('los dos tanques tienen capacidades distintas', () => {
  it('la misma fracción da bandas distintas', () => {
    // 13.000 contra 4.000: un «medio» no significa lo mismo en los dos.
    expect(bandaDe('crudo', 'medio').hasta).toBe(8125)
    expect(bandaDe('procesado', 'medio').hasta).toBe(2500)
  })

  it('los saldos son independientes', async () => {
    await sembrarSaldo('crudo', 6500)
    await sembrarSaldo('procesado', 1000)

    expect((await saldoDe('crudo')).litros).toBe(6500)
    expect((await saldoDe('procesado')).litros).toBe(1000)
  })
})
