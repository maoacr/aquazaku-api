import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes, direcciones } from '@/db/schema'
import { direccionesDe } from '@/modules/clientes/direcciones'
import { crearCliente } from '@/modules/clientes/service'
import { resetDb } from '@/test/db'

/**
 * La dirección en el mismo alta — M16.
 *
 * ── Por qué acá y no solo en `POST /clientes/:id/direcciones` ───────────────
 *
 * Ese endpoint pide `clientes:editar`, y el `pos` **no lo tiene**: puede crear
 * clientes, no modificarlos. Pero el `pos` es quien atiende el mostrador, y
 * RN-BAS-07 le da autonomía para prestar una base a un cliente verificado.
 *
 * El problema es que **una base se presta a una DIRECCIÓN, no a un cliente**
 * (RN-BAS-03). Así que hoy el `pos` puede prestar una base y no puede crear la
 * dirección a la que se presta. Ese cliente queda sin dónde ir a buscarla.
 *
 * Es exactamente el mismo argumento por el que el teléfono ya se acepta en el
 * alta, y la misma solución: aceptarla acá la cubre `clientes:crear`, sin darle
 * ningún poder nuevo sobre los clientes que ya existen.
 */

const BASE = {
  primerNombre: 'Rosa',
  apellidos: 'Padilla Gómez',
  tipoDocumento: 'CC' as const,
  numeroDocumento: '79123456',
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

describe('el alta acepta una dirección', () => {
  it('la guarda colgada del cliente recién creado', async () => {
    const { cliente } = await crearCliente({
      ...BASE,
      direccion: { etiqueta: 'La casa', direccion: 'Calle 5 #3-20' },
    })

    const suyas = await direccionesDe(cliente.id)

    expect(suyas).toHaveLength(1)
    expect(suyas[0]).toMatchObject({ etiqueta: 'La casa', clienteId: cliente.id })
  })

  it('la devuelve en el resultado, sin tener que volver a pedirla', async () => {
    const { direccion } = await crearCliente({
      ...BASE,
      direccion: { etiqueta: 'La casa', direccion: 'Calle 5 #3-20' },
    })

    expect(direccion).toMatchObject({ etiqueta: 'La casa' })
  })

  it('sin dirección, el alta sigue funcionando igual', async () => {
    const { cliente, direccion } = await crearCliente(BASE)

    expect(direccion).toBeNull()
    expect(await direccionesDe(cliente.id)).toHaveLength(0)
  })

  it('acepta la nomenclatura estructurada, no solo texto libre', async () => {
    const { direccion } = await crearCliente({
      ...BASE,
      direccion: {
        etiqueta: 'La casa',
        viaTipo: 'CL',
        viaNumero: '30',
        placaNumero: '12',
        municipio: 'Campo de la Cruz',
        departamento: 'Atlántico',
      },
    })

    expect(direccion).toMatchObject({ viaTipo: 'CL', viaNumero: '30' })
  })
})

/**
 * ── Todo o nada ─────────────────────────────────────────────────────────────
 *
 * Cliente, teléfono y dirección van en la MISMA transacción. Con escrituras
 * sueltas, una dirección inválida dejaría un cliente a medio cargar y quien
 * atiende no sabría qué quedó guardado: se registró a alguien para poder
 * reclamarle un envase, y el registro quedó incompleto sin avisar.
 */
describe('la transacción', () => {
  it('una dirección que no ubica no deja medio cliente', async () => {
    await expect(
      crearCliente({
        ...BASE,
        // Solo municipio no ubica nada: a «Suan» no se le puede entregar agua.
        direccion: { etiqueta: 'La casa', municipio: 'Suan' },
      }),
    ).rejects.toThrow()

    expect(await db.select().from(clientes)).toHaveLength(0)
    expect(await db.select().from(direcciones)).toHaveLength(0)
  })

  it('el teléfono y la dirección entran juntos o no entra ninguno', async () => {
    const { cliente, telefono, direccion } = await crearCliente({
      ...BASE,
      telefono: { numero: '300 123 4567', etiqueta: 'el celular' },
      direccion: { etiqueta: 'La casa', direccion: 'Calle 5 #3-20' },
    })

    expect(telefono).toMatchObject({ numero: '300 123 4567' })
    expect(direccion).toMatchObject({ etiqueta: 'La casa' })

    const [guardado] = await db.select().from(clientes).where(eq(clientes.id, cliente.id))
    expect(guardado).toBeDefined()
  })
})
