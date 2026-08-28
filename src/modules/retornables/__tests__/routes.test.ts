import { desc } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes, direcciones } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }
let clienteId: string
let direccionId: string

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

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
  await app?.close()
  await closeDb()
})

const comoAdmin = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

const como = async (rol: Role, pedido: Omit<InjectOptions, 'headers'>) => {
  const usuario = await usuarioAutenticado(rol)
  return app.inject({ ...pedido, headers: { cookie: usuario.cookie } })
}

const comprar = (cantidad = 100) =>
  comoAdmin({
    method: 'POST',
    url: '/botellones/compra',
    payload: { cantidad, motivo: 'compra inicial del parque' },
  })

describe('los botellones', () => {
  it('el `pos` los mueve: es quien atiende el mostrador', async () => {
    await comprar()

    const res = await como('pos', {
      method: 'POST',
      url: '/botellones/entrega',
      payload: { clienteId, cantidad: 5 },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ enBodega: 95, enPoderDelCliente: 5 })
  })

  /**
   * El `seller` los VE y no los opera. Lo dice la matriz, y hoy tiene sentido:
   * quien entrega en la calle trabaja por ruta, y las rutas son M8.
   */
  it('el `seller` mira pero no entrega', async () => {
    await comprar()

    expect((await como('seller', { method: 'GET', url: '/botellones' })).statusCode).toBe(200)

    const res = await como('seller', {
      method: 'POST',
      url: '/botellones/entrega',
      payload: { clienteId, cantidad: 5 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un intento denegado queda auditado con SU recurso', async () => {
    await como('seller', {
      method: 'POST',
      url: '/botellones/entrega',
      payload: { clienteId, cantidad: 5 },
    })

    const [ultimo] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('botellones')
  })

  it('entregar más de lo que hay responde 422 con el número real', async () => {
    await comprar(10)

    const res = await comoAdmin({
      method: 'POST',
      url: '/botellones/entrega',
      payload: { clienteId, cantidad: 50 },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('BODEGA_INSUFICIENTE')
    expect(res.json().mensaje).toMatch(/hay 10 botellones/)
  })

  /**
   * ── La ley de conservación viaja en la respuesta ──────────────────────────
   *
   * El dominio pidió que fallara «ruidosamente». Un endpoint que la calcula y no
   * la dice la deja tan silenciosa como no calcularla.
   */
  it('el estado del parque incluye si la ley cierra', async () => {
    await comprar()
    await comoAdmin({
      method: 'POST',
      url: '/botellones/entrega',
      payload: { clienteId, cantidad: 5 },
    })

    const estado = (await comoAdmin({ method: 'GET', url: '/botellones' })).json()

    expect(estado).toMatchObject({ enBodega: 95, cuadra: true, registrados: 100 })
  })

  it('descartar sin motivo se rechaza', async () => {
    await comprar()

    const res = await comoAdmin({
      method: 'POST',
      url: '/botellones/descarte',
      payload: { cantidad: 3, motivo: 'x' },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('las bases', () => {
  const darDeAlta = (idSticker = '0913') =>
    comoAdmin({ method: 'POST', url: '/bases', payload: { idSticker } })

  it('se dan de alta con su sticker', async () => {
    const res = await darDeAlta()

    expect(res.statusCode).toBe(201)
    expect(res.json().idSticker).toBe('0913')
  })

  /*
   * ── El sistema propone, el sticker manda — RN-BAS-10 ──────────────────────
   */
  it('sin sticker, el sistema pone el próximo', async () => {
    await darDeAlta('0040')

    const res = await comoAdmin({ method: 'POST', url: '/bases', payload: {} })

    expect(res.statusCode).toBe(201)
    expect(res.json().idSticker).toBe('0041')
  })

  it('un sticker que no son cuatro dígitos lo frena el esquema, con 400', async () => {
    const res = await darDeAlta('913')

    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json())).toContain('cuatro dígitos')
  })

  /*
   * La compra espeja `POST /botellones/compra`: los dos activos entran al parque
   * con una cantidad. Cargar 40 de a una son 40 operaciones que pueden cortarse
   * por la mitad, con los stickers ya impresos.
   */
  it('la compra numera consecutivo y entra entera', async () => {
    await darDeAlta('0040')

    const res = await comoAdmin({ method: 'POST', url: '/bases/compra', payload: { cantidad: 3 } })

    expect(res.statusCode).toBe(201)
    expect(res.json().map((b: { idSticker: string }) => b.idSticker)).toEqual([
      '0041',
      '0042',
      '0043',
    ])
  })

  it('una compra de cero no es una compra', async () => {
    const res = await comoAdmin({ method: 'POST', url: '/bases/compra', payload: { cantidad: 0 } })

    expect(res.statusCode).toBe(400)
  })

  /*
   * La propuesta se expone por endpoint en vez de calcularse en la pantalla: la
   * regla del consecutivo vive en un solo lugar. Una copia en el componente
   * propondría un número ya tomado el día que la regla cambie, y el alta
   * fallaría con un duplicado que el operario no pidió.
   */
  it('el próximo código se consulta antes de dar de alta', async () => {
    await darDeAlta('0040')

    const res = await comoAdmin({ method: 'GET', url: '/bases/proximo-codigo' })

    expect(res.statusCode).toBe(200)
    expect(res.json().proximo).toBe('0041')
  })

  it('se prestan a una DIRECCIÓN', async () => {
    const base = (await darDeAlta()).json()

    const res = await comoAdmin({
      method: 'POST',
      url: `/bases/${base.id}/prestamo`,
      payload: { direccionId },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().direccionId).toBe(direccionId)

    const enDireccion = (await comoAdmin({
      method: 'GET',
      url: `/direcciones/${direccionId}/bases`,
    })).json()
    expect(enDireccion).toHaveLength(1)
  })

  it('el historial dice dónde estuvo', async () => {
    const base = (await darDeAlta()).json()
    await comoAdmin({ method: 'POST', url: `/bases/${base.id}/prestamo`, payload: { direccionId } })
    await comoAdmin({ method: 'POST', url: `/bases/${base.id}/retorno` })

    const historial = (await comoAdmin({ method: 'GET', url: `/bases/${base.id}/historial` })).json()

    expect(historial.map((m: { tipo: string }) => m.tipo)).toEqual(['alta', 'prestamo', 'retorno'])
  })

  it('el `contador` mira y no presta', async () => {
    const base = (await darDeAlta()).json()

    expect((await como('contador', { method: 'GET', url: '/bases' })).statusCode).toBe(200)
    expect(
      (await como('contador', {
        method: 'POST',
        url: `/bases/${base.id}/prestamo`,
        payload: { direccionId },
      })).statusCode,
    ).toBe(403)
  })
})

/**
 * ── El daño genera una venta que NO es deuda ────────────────────────────────
 *
 * Es la resolución de la contradicción entre RN-BAS-08 y RN-CLI-06, vista desde
 * afuera: el recargo existe como venta y la deuda no lo cuenta.
 */
describe('el recargo por daño', () => {
  const danar = async (medioDePago = 'credito') => {
    const base = (await comoAdmin({ method: 'POST', url: '/bases', payload: { idSticker: '0913' } })).json()
    await comoAdmin({ method: 'POST', url: `/bases/${base.id}/prestamo`, payload: { direccionId } })

    return comoAdmin({
      method: 'POST',
      url: `/bases/${base.id}/dano`,
      payload: {
        monto: '80000.00',
        motivo: 'el operario vio la base partida al recoger los botellones',
        medioDePago,
      },
    })
  }

  it('crea la venta y marca la base', async () => {
    const res = await danar()

    expect(res.statusCode).toBe(201)
    expect(res.json().recargo.tipo).toBe('dano_base')
    expect(res.json().base.estado).toBe('danada')
  })

  it('no aparece en la deuda del cliente', async () => {
    await danar()

    const deuda = (await comoAdmin({ method: 'GET', url: `/clientes/${clienteId}/deuda` })).json()

    expect(deuda.deuda).toBe('0.00')
  })

  it('sin monto no se cobra: el dominio no dice cuánto vale reponerla', async () => {
    const base = (await comoAdmin({ method: 'POST', url: '/bases', payload: { idSticker: '0001' } })).json()
    await comoAdmin({ method: 'POST', url: `/bases/${base.id}/prestamo`, payload: { direccionId } })

    const res = await comoAdmin({
      method: 'POST',
      url: `/bases/${base.id}/dano`,
      payload: { motivo: 'el operario vio la base partida', medioDePago: 'efectivo' },
    })

    expect(res.statusCode).toBe(400)
  })
})
