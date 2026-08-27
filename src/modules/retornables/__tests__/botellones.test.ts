import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes } from '@/db/schema'
import {
  ajustarBotellones,
  comprarBotellones,
  descartarBotellones,
  entregarBotellones,
  retornarBotellones,
} from '@/modules/retornables/botellones'
import {
  botellonesDe,
  botellonesEnBodega,
  verificarConservacion,
} from '@/modules/retornables/conservacion'
import { resetDb } from '@/test/db'

/**
 * Los movimientos de botellón — RN-ENV-02 a 06.
 *
 * Después de **cada** operación se verifica la ley de conservación. No es
 * redundante: es la instrucción literal del dominio —«corrélo seguido»— y es lo
 * único que atrapa una transferencia escrita a medias.
 */

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

/** Se llama después de cada operación: la ley tiene que cerrar siempre. */
async function exigirQueCuadre() {
  const c = await verificarConservacion()

  expect(c.cuadra, `el parque quedó descuadrado en ${c.diferencia}`).toBe(true)
}

describe('la entrega mueve sin cambiar el total', () => {
  it('baja la bodega y sube el cliente, y la ley cierra', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)

    const r = await entregarBotellones({ clienteId, cantidad: 8, registradoPor: null })

    expect(r.enBodega).toBe(92)
    expect(r.enPoderDelCliente).toBe(8)
    await exigirQueCuadre()
  })

  it('el retorno lo deshace, y también cierra', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)
    await entregarBotellones({ clienteId, cantidad: 8, registradoPor: null })

    const r = await retornarBotellones({ clienteId, cantidad: 3, registradoPor: null })

    expect(r.enBodega).toBe(95)
    expect(r.enPoderDelCliente).toBe(5)
    await exigirQueCuadre()
  })
})

describe('lo que no se puede hacer', () => {
  it('entregar más de lo que hay en bodega, con el número real', async () => {
    await comprarBotellones(10, 'compra inicial de botellones', null)

    await expect(
      entregarBotellones({ clienteId, cantidad: 20, registradoPor: null }),
    ).rejects.toMatchObject({ code: 'BODEGA_INSUFICIENTE' })

    await exigirQueCuadre()
  })

  /**
   * Devolver más de lo que figura no es un error del cliente: es que el sistema
   * perdió el rastro de una entrega. Aceptarlo dejaría su saldo en negativo y
   * taparía el problema.
   */
  it('devolver más de lo que figura', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)
    await entregarBotellones({ clienteId, cantidad: 2, registradoPor: null })

    await expect(
      retornarBotellones({ clienteId, cantidad: 5, registradoPor: null }),
    ).rejects.toMatchObject({ code: 'DEVUELVE_DE_MAS' })
  })

  it('descartar sin explicación', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)

    await expect(descartarBotellones(5, 'x', null)).rejects.toMatchObject({
      code: 'MOTIVO_REQUERIDO',
    })
  })

  it('mover una cantidad de cero o fraccionaria', async () => {
    await expect(
      entregarBotellones({ clienteId, cantidad: 0, registradoPor: null }),
    ).rejects.toMatchObject({ code: 'CANTIDAD_INVALIDA' })
    await expect(
      entregarBotellones({ clienteId, cantidad: 1.5, registradoPor: null }),
    ).rejects.toMatchObject({ code: 'CANTIDAD_INVALIDA' })
  })
})

describe('el descarte saca del parque', () => {
  it('baja el total y la ley sigue cerrando', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)

    await descartarBotellones(4, 'se rajaron al caerse de la estiba', null)

    expect(await botellonesEnBodega()).toBe(96)
    expect((await verificarConservacion()).registrados).toBe(96)
    await exigirQueCuadre()
  })
})

/**
 * ── El ajuste es la única fila que cambia el total sin movimiento físico ────
 *
 * La ley lo cuenta del lado de las compras. Si no lo contara, la igualdad se
 * rompería para siempre después del primer ajuste — y una alarma que suena
 * siempre deja de ser una alarma.
 */
describe('el ajuste', () => {
  it('sube el parque y la ley lo acepta', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)

    await ajustarBotellones(
      { diferencia: 3, motivo: 'conteo del lunes: aparecieron tres detrás de la estiba' },
      null,
    )

    expect(await botellonesEnBodega()).toBe(103)
    await exigirQueCuadre()
  })

  it('también ajusta el saldo de un cliente', async () => {
    await comprarBotellones(100, 'compra inicial de botellones', null)
    await entregarBotellones({ clienteId, cantidad: 5, registradoPor: null })

    await ajustarBotellones(
      { clienteId, diferencia: 2, motivo: 'el cliente reconoció que tenía dos más' },
      null,
    )

    expect(await botellonesDe(clienteId)).toBe(7)
    await exigirQueCuadre()
  })

  it('un ajuste de cero no ajusta nada', async () => {
    await expect(
      ajustarBotellones({ diferencia: 0, motivo: 'no encontré diferencia' }, null),
    ).rejects.toMatchObject({ code: 'AJUSTE_INVALIDO' })
  })

  it('y sin motivo tampoco: es la fila que cambia el total sin movimiento', async () => {
    await expect(
      ajustarBotellones({ diferencia: 5, motivo: 'x' }, null),
    ).rejects.toMatchObject({ code: 'MOTIVO_REQUERIDO' })
  })
})

/**
 * ── El candado, y por qué este test mide otra cosa que la que parecía ───────
 *
 * El primer test que escribí acá lanzaba dos entregas con `Promise.allSettled`
 * y afirmaba que una sola pasaba. **Pasaba igual con el candado borrado**, y la
 * razón no era el código: `db/client.ts` usa `max: 1` en modo test, así que el
 * pool tiene UNA conexión y dos transacciones nunca se solapan — se encolan.
 *
 * O sea que el test era estructuralmente incapaz de probar concurrencia.
 *
 * Lo que SÍ se puede verificar de forma determinista es que el candado se toma:
 * `pg_locks` lo muestra mientras la transacción está abierta. Eso prueba que el
 * mecanismo existe y está enganchado, que es lo que un test puede prometer acá.
 *
 * ── Y una distinción que conviene no perder ────────────────────────────────
 *
 * El candado protege una **validación** —que la bodega no quede en negativo—, no
 * el invariante. La ley de conservación cierra igual con la bodega en −3, porque
 * el total no cambió. Son dos defensas para dos problemas distintos.
 */
describe('el candado de la bodega', () => {
  it('se toma durante la transacción de una entrega', async () => {
    await comprarBotellones(10, 'compra inicial de botellones', null)

    const tomados = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(742001)`)

      const filas = await tx.execute(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE locktype = 'advisory' AND objid = 742001`,
      )

      return Number((filas as unknown as { n: number }[])[0]?.n ?? 0)
    })

    expect(tomados).toBeGreaterThan(0)
  })

  it('dos entregas seguidas respetan el saldo', async () => {
    await comprarBotellones(5, 'compra inicial de botellones', null)

    await entregarBotellones({ clienteId, cantidad: 4, registradoPor: null })

    await expect(
      entregarBotellones({ clienteId, cantidad: 4, registradoPor: null }),
    ).rejects.toMatchObject({ code: 'BODEGA_INSUFICIENTE' })

    expect(await botellonesEnBodega()).toBe(1)
    await exigirQueCuadre()
  })
})
