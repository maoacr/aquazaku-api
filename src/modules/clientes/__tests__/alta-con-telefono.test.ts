import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { clientes, telefonos } from '@/db/schema'
import { telefonosDe } from '@/modules/clientes/telefonos'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Un teléfono en el mismo momento del alta — RN-ENV-09.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * Una venta sin cliente es válida: quien compra una paca de bolsas no se lleva
 * ningún activo de la planta. Pero si se lleva un botellón sin devolver el
 * vacío, queda debiendo un envase de la empresa y hay que poder reclamárselo.
 * Ahí el registro deja de ser opcional.
 *
 * Y ese registro lo hace el `pos`, que es quien está en el mostrador. El `pos`
 * puede **crear** clientes pero no **editarlos**, así que el endpoint de
 * teléfonos —que pide `clientes:editar`— le respondía 403. Registraba a la
 * persona y se quedaba sin a qué número llamarla: el registro existía y no
 * servía para lo único que se hizo.
 */

let app: FastifyInstance

const alta = {
  nombre: 'Rosa Elena Padilla',
  tipoDocumento: 'CC' as const,
  numeroDocumento: '1.042.857.391',
}

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

describe('el pos registra a quien se lleva un botellón, entero', () => {
  it('crea el cliente y su teléfono en una sola petición', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes',
      headers: { cookie },
      payload: { ...alta, telefono: { numero: '300 123 4567', etiqueta: 'el celular' } },
    })

    expect(res.statusCode).toBe(201)

    const creado = res.json()
    expect(creado.telefono.numero).toBe('300 123 4567')
    expect(creado.telefono.etiqueta).toBe('el celular')
    expect(await telefonosDe(creado.id)).toHaveLength(1)
  })

  /**
   * La prueba de que el atajo NO ensanchó al `pos`.
   *
   * Puede cargar el número de alguien que está registrando; no puede tocar el
   * de un cliente que ya existía. Si esta expectativa se pone en verde con 201,
   * el rol creció sin que nadie lo decidiera.
   */
  it('pero sigue sin poder agregarle un teléfono a un cliente que ya existe', async () => {
    const { cookie } = await usuarioAutenticado('pos')
    const [cliente] = await db
      .insert(clientes)
      .values({ nombre: 'Ya estaba', tipoDocumento: 'CC', numeroDocumento: '900123456' })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: `/clientes/${cliente!.id}/telefonos`,
      headers: { cookie },
      payload: { numero: '3009998877' },
    })

    expect(res.statusCode).toBe(403)
  })
})

describe('el teléfono es opcional, y el alta sigue siendo la de siempre', () => {
  it('sin teléfono, el cliente se crea igual', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes',
      headers: { cookie },
      payload: alta,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().telefono).toBeNull()
  })

  /**
   * El mismo mínimo que el endpoint de teléfonos, porque es el mismo esquema.
   * Un número válido por una puerta e inválido por la otra sería el sistema
   * contradiciéndose sobre el mismo dato.
   *
   * 400 y no 422: la forma la rechaza `validar()` antes de que el servicio
   * exista. El 422 de esta casa es para las reglas de negocio.
   */
  it('un número demasiado corto no pasa', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    const res = await app.inject({
      method: 'POST',
      url: '/clientes',
      headers: { cookie },
      payload: { ...alta, telefono: { numero: '12345' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().detalle[0].campo).toBe('telefono.numero')
  })
})

/**
 * Cliente y teléfono entran juntos o no entra ninguno.
 *
 * Un cliente sin número es exactamente el registro que no sirve: se lo creó
 * para poder reclamarle un botellón y no quedó a qué llamar.
 */
describe('las dos escrituras son una sola', () => {
  it('si el teléfono no entra, el cliente tampoco queda', async () => {
    const { cookie } = await usuarioAutenticado('pos')

    // 60 es el máximo de la etiqueta en el esquema; la columna no tiene tope,
    // así que para forzar el fallo en la SEGUNDA escritura hay que saltearse
    // la validación y pegarle al servicio.
    const { crearCliente } = await import('@/modules/clientes/service')

    await expect(
      crearCliente({
        ...alta,
        // `numero` es NOT NULL en la base: el insert del teléfono revienta
        // después de que el del cliente ya se escribió.
        telefono: { numero: null as unknown as string },
      }),
    ).rejects.toThrow()

    expect(await db.select().from(clientes)).toHaveLength(0)
    expect(await db.select().from(telefonos)).toHaveLength(0)
    expect(cookie).toBeTruthy()
  })
})
