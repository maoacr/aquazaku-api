import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { ZONA_DE_LA_PLANTA, diaEnLaPlanta } from '@/lib/dia'

/**
 * El día de Aquazaku es un día de Campo de la Cruz.
 *
 * ── Por qué este archivo pone la base en UTC ────────────────────────────────
 *
 * El bug vivió meses invisible porque en desarrollo la base corre en
 * `America/Bogota` y en producción —Supabase— corre en UTC. Lo encontró el CI,
 * que también está en UTC.
 *
 * Un test que solo falla en CI enseña a desconfiar del CI. Así que acá la
 * sesión se pone en UTC a propósito: **reproduce producción en la máquina de
 * quien escribe el código.**
 *
 * En modo test el pool es de UNA conexión, así que el `SET` alcanza a todo el
 * archivo.
 */

beforeAll(async () => {
  await db.execute(sql`SET TIME ZONE 'UTC'`)
})

afterAll(async () => {
  await closeDb()
})

/** El instante exacto del borde: 31 de agosto, 19:30 en la planta. */
const ATARDECER = sql`TIMESTAMPTZ '2026-08-31 19:30:00-05'`

describe('con la base en UTC, como producción', () => {
  it('la sesión efectivamente quedó en UTC', async () => {
    const [fila] = await db.execute<{ zona: string }>(sql`SELECT current_setting('TimeZone') AS zona`)

    expect(fila!.zona).toBe('UTC')
  })

  /*
   * Colombia es UTC−5. Una venta a las 19:30 ya es «mañana» en UTC, y ese es el
   * único hecho que hace falta para que un mes entero salga mal.
   */
  it('`::date` a secas se lleva la venta al día siguiente', async () => {
    const [fila] = await db.execute<{ dia: string }>(sql`SELECT (${ATARDECER})::date AS dia`)

    expect(String(fila!.dia)).toContain('2026-09-01')
  })

  it('`diaEnLaPlanta` la deja donde ocurrió', async () => {
    const [fila] = await db.execute<{ dia: string }>(
      sql`SELECT ${diaEnLaPlanta(ATARDECER)} AS dia`,
    )

    expect(String(fila!.dia)).toContain('2026-08-31')
  })

  /*
   * El caso que le llega al contador: pide agosto y la venta del último día a
   * las 19:30 tiene que estar. Sin el arreglo, ese movimiento aparece en el
   * reporte de septiembre — los totales cierran igual, y el descuadre solo se
   * ve conciliando contra el banco.
   */
  it('el último día del mes entra en el rango de ese mes', async () => {
    const [fila] = await db.execute<{ entra: boolean }>(
      sql`SELECT ${diaEnLaPlanta(ATARDECER)} BETWEEN '2026-08-01' AND '2026-08-31' AS entra`,
    )

    expect(fila!.entra).toBe(true)
  })
})

describe('la zona', () => {
  it('se declara una sola vez', () => {
    expect(ZONA_DE_LA_PLANTA).toBe('America/Bogota')
  })
})
