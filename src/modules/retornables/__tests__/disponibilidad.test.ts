import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { bases, clientes, direcciones, movimientosBase } from '@/db/schema'
import {
  DIAS_DE_ENTREGA,
  comprarBases,
  disponibilidadDeBases,
  prestarBase,
  retornarBase,
} from '@/modules/retornables/bases'
import { marcarBaseDanada } from '@/modules/retornables/dano'
import { resetDb } from '@/test/db'

/**
 * ¿Alcanzan las bases hasta el próximo pedido? — RN-BAS-13.
 *
 * ── Por qué el umbral se calcula y no se configura ──────────────────────────
 *
 * Un pedido de bases tarda **7 días** en llegar. Avisar cuando quedan cero es
 * avisar tarde por diseño: para entonces ya se le dijo que no a un cliente y
 * todavía faltan siete días.
 *
 * La pregunta correcta no es «¿cuál es el mínimo?» sino «¿cuántas se prestan
 * mientras llega el pedido?». Y esa el sistema la sabe: cada préstamo queda con
 * su fecha. Un umbral fijo habría que inventarlo hoy, sin operación todavía, y
 * quedaría viejo el día que el negocio cambie de tamaño.
 */

let direccionId: string

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
    })
    .returning()

  const [direccion] = await db
    .insert(direcciones)
    .values({ clienteId: cliente!.id, etiqueta: 'La casa', direccion: 'Calle 5 #3-20' })
    .returning()
  direccionId = direccion!.id
})

afterAll(async () => {
  await closeDb()
})

/** Presta `cuantas` de las bases que estén libres, cada una a la misma dirección. */
async function prestar(cuantas: number): Promise<void> {
  const libres = await db.select().from(bases)

  for (const base of libres.slice(0, cuantas)) {
    /*
     * Una dirección puede tener varias bases, así que alcanza con prestarlas
     * todas al mismo lugar: lo que se mide es el ritmo, no dónde fueron.
     */
    await prestarBase(base.id, direccionId, null)
  }
}

describe('la ventana es la demora del proveedor', () => {
  it('son 7 días, y el número viaja para que la pantalla no lo copie', () => {
    expect(DIAS_DE_ENTREGA).toBe(7)
  })
})

describe('cuántas bases quedan libres', () => {
  it('cuenta las que están en bodega, no el total del parque', async () => {
    await comprarBases(5, null)
    await prestar(2)

    const { libres } = await disponibilidadDeBases()

    expect(libres).toBe(3)
  })

  /*
   * Una base dañada ocupa lugar en la bodega y NO se puede prestar: `prestarBase`
   * la rechaza. Contarla como disponible haría que el aviso calle justo cuando
   * hace falta.
   */
  it('una base dañada en bodega no está disponible', async () => {
    const compradas = await comprarBases(3, null)

    /*
     * Se daña por el camino real. `UPDATE bases SET estado='danada'` a secas lo
     * rechaza el constraint `bases_dano_completo`: una base dañada sin quién la
     * marcó, cuándo, y cuál fue el recargo no es un estado que exista.
     */
    await prestarBase(compradas[0]!.id, direccionId, null)
    await marcarBaseDanada(
      {
        baseId: compradas[0]!.id,
        monto: '80000.00',
        motivo: 'se partió el soporte del grifo en el local',
        medioDePago: 'efectivo',
      },
      null,
    )
    await retornarBase(compradas[0]!.id, null)

    expect((await disponibilidadDeBases()).libres).toBe(2)
  })

  it('una descartada tampoco', async () => {
    const compradas = await comprarBases(3, null)
    await db.update(bases).set({ activa: false }).where(eq(bases.id, compradas[0]!.id))

    expect((await disponibilidadDeBases()).libres).toBe(2)
  })
})

describe('el ritmo sale de los préstamos de la ventana', () => {
  it('cuenta los préstamos de los últimos 7 días', async () => {
    await comprarBases(10, null)
    await prestar(3)

    expect((await disponibilidadDeBases()).prestadasEnLaVentana).toBe(3)
  })

  /*
   * Lo viejo no predice lo que viene. Un préstamo de hace un mes no dice nada
   * sobre si las bases alcanzan hasta el pedido que llega en siete días.
   */
  it('lo de antes de la ventana no cuenta', async () => {
    const compradas = await comprarBases(10, null)

    /*
     * El movimiento viejo se INSERTA con su fecha, no se retrofecha: el libro es
     * append-only y el rol de la aplicación tiene revocado el `UPDATE`
     * (migración 0009). Que el test tenga que respetarlo es la señal de que la
     * garantía es real y no un comentario.
     */
    await db.insert(movimientosBase).values({
      baseId: compradas[0]!.id,
      tipo: 'prestamo',
      direccionId,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    })

    expect((await disponibilidadDeBases()).prestadasEnLaVentana).toBe(0)
  })
})

describe('el aviso', () => {
  it('calla cuando las libres alcanzan el ritmo', async () => {
    await comprarBases(10, null)
    await prestar(2)

    const estado = await disponibilidadDeBases()

    expect(estado.libres).toBe(8)
    expect(estado.prestadasEnLaVentana).toBe(2)
    expect(estado.alcanza).toBe(true)
  })

  /*
   * Quedan 2 libres y se prestaron 8 en la semana: no llegan al próximo pedido.
   * Ese es el momento de comprar, no cuando quedan cero.
   */
  it('avisa cuando quedan menos de las que se prestan en la ventana', async () => {
    await comprarBases(10, null)
    await prestar(8)

    const estado = await disponibilidadDeBases()

    expect(estado.libres).toBe(2)
    expect(estado.prestadasEnLaVentana).toBe(8)
    expect(estado.alcanza).toBe(false)
  })

  /*
   * ── El caso de arranque ───────────────────────────────────────────────────
   *
   * Sin préstamos todavía, el ritmo es cero y no hay nada que avisar. Eso es
   * correcto y no un agujero: un aviso que suena el primer día, antes de que
   * exista operación, es un aviso que se aprende a ignorar.
   */
  it('sin operación todavía, no avisa', async () => {
    await comprarBases(40, null)

    expect(await disponibilidadDeBases()).toMatchObject({
      libres: 40,
      prestadasEnLaVentana: 0,
      alcanza: true,
    })
  })

  /*
   * Cero libres SÍ avisa aunque el ritmo también sea cero. No se puede prestar
   * lo que no hay, y ahí el aviso no depende de ninguna estimación.
   */
  it('sin bases libres avisa igual, sin importar el ritmo', async () => {
    /*
     * El parque entero está afuera desde hace rato: ningún préstamo cae en la
     * ventana. Las bases se insertan ya prestadas para no generar movimientos
     * recientes — es el estado de régimen de un negocio que colocó todo y no
     * repuso.
     */
    await db.insert(bases).values([
      { idSticker: '0001', direccionId },
      { idSticker: '0002', direccionId },
    ])

    const estado = await disponibilidadDeBases()

    expect(estado.libres).toBe(0)
    expect(estado.prestadasEnLaVentana).toBe(0)
    expect(estado.alcanza).toBe(false)
  })
})
