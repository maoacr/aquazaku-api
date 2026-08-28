import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, movimientosBotellon } from '@/db/schema'
import { PG_ERROR, pgErrorOf, resetDb } from '@/test/db'

/**
 * El parque de botellones, del lado de la base — RN-ENV-09.
 *
 * ── Por qué este invariante NO puede vivir solo en el servicio ──────────────
 *
 * Un botellón que sale sin quedar anotado a nombre de nadie no deja una fila
 * rota: deja una fila que **falta**. Y la ley de conservación de RN-ENV-02 no
 * detecta esas — sigue cerrando mientras el botellón está afuera y el sistema lo
 * cree en la bodega.
 *
 * Por eso el CHECK ataca el problema por el otro lado: la fila del cliente no
 * puede existir sin cliente. Es lo que obliga a que el registro nazca completo.
 */

const CONSTRAINT = 'movimientos_botellon_con_responsable'

let clienteId: string

beforeEach(async () => {
  await resetDb()

  const [cliente] = await db
    .insert(clientes)
    .values({ nombre: 'Yeimy', tipoDocumento: 'CC', numeroDocumento: '79123456' })
    .returning()
  clienteId = cliente!.id
})

afterAll(async () => {
  await closeDb()
})

describe('ningún botellón sale del parque sin responsable — RN-ENV-09', () => {
  it('rechaza una entrega que no dice a quién', async () => {
    const error = await pgErrorOf(
      db.insert(movimientosBotellon).values({ cantidad: 3, tipo: 'entrega' }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe(CONSTRAINT)
  })

  it('rechaza un retorno que no dice a quién descontárselo', async () => {
    const error = await pgErrorOf(
      db.insert(movimientosBotellon).values({ cantidad: -3, tipo: 'retorno' }),
    )

    expect(error.code).toBe(PG_ERROR.CHECK_VIOLATION)
    expect(error.constraint).toBe(CONSTRAINT)
  })

  /*
   * ── Las contrapartidas de bodega SÍ van sin cliente ───────────────────────
   *
   * Cada movimiento son dos filas y solo una es del cliente. La otra es la
   * bodega, que no es un cliente.
   *
   * Estos dos casos son la razón por la que el CHECK cruza tipo y signo en vez
   * de pedirle `cliente_id` a toda fila positiva: eso habría roto el retorno.
   */
  it('acepta la salida de bodega de una entrega, que va sin cliente', async () => {
    await expect(
      db.insert(movimientosBotellon).values({ cantidad: -3, tipo: 'entrega' }),
    ).resolves.toBeDefined()
  })

  it('acepta el ingreso a bodega de un retorno, que también va sin cliente', async () => {
    await expect(
      db.insert(movimientosBotellon).values({ cantidad: 3, tipo: 'retorno' }),
    ).resolves.toBeDefined()
  })

  it('acepta la entrega y el retorno cuando nombran al cliente', async () => {
    await expect(
      db.insert(movimientosBotellon).values([
        { cantidad: 3, tipo: 'entrega', clienteId },
        { cantidad: -3, tipo: 'retorno', clienteId },
      ]),
    ).resolves.toBeDefined()
  })

  /*
   * Compras, descartes y ajustes de bodega son movimientos del parque contra sí
   * mismo. No hay tenedor del otro lado a quién nombrar, y exigirlo obligaría a
   * inventar un cliente «planta» que después aparecería en los saldos.
   */
  it('no le pide responsable a lo que mueve el parque contra sí mismo', async () => {
    await expect(
      db.insert(movimientosBotellon).values([
        { cantidad: 100, tipo: 'compra' },
        { cantidad: -3, tipo: 'descarte', motivo: 'tres con el cuello partido en la descarga' },
        { cantidad: 2, tipo: 'ajuste', motivo: 'aparecieron dos detrás de la estiba del fondo' },
      ]),
    ).resolves.toBeDefined()
  })
})
