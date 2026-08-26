import { desc } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')
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

const UN_CLIENTE = {
  nombre: 'Yeimy Rodríguez',
  tipoDocumento: 'CC',
  numeroDocumento: '79.123.456',
}

async function crear(payload: object = UN_CLIENTE) {
  const res = await comoAdmin({ method: 'POST', url: '/clientes', payload })
  return res.json()
}

describe('POST /clientes', () => {
  it('el `seller` registra clientes: es quien los consigue', async () => {
    const res = await como('seller', { method: 'POST', url: '/clientes', payload: UN_CLIENTE })

    expect(res.statusCode).toBe(201)
    expect(res.json().numeroDocumento).toBe('79123456')
  })

  /** RN-CLI-13: el documento se exige. Lo que puede esperar es la verificación. */
  it('sin documento no hay alta', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/clientes',
      payload: { nombre: 'Alguien', tipoDocumento: 'CC' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('el `contador` mira pero no registra', async () => {
    expect((await como('contador', { method: 'GET', url: '/clientes' })).statusCode).toBe(200)

    const res = await como('contador', { method: 'POST', url: '/clientes', payload: UN_CLIENTE })
    expect(res.statusCode).toBe(403)
  })

  it('un intento denegado queda auditado', async () => {
    await como('contador', { method: 'POST', url: '/clientes', payload: UN_CLIENTE })

    const [ultimo] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('clientes')
  })

  /**
   * El cruce CC/NIT viaja en la respuesta del 201, no como error: el alta
   * ocurrió y quien registra decide qué hacer con el aviso.
   */
  it('el cruce CC/NIT llega como aviso, con el cliente ya creado', async () => {
    await crear()

    const res = await comoAdmin({
      method: 'POST',
      url: '/clientes',
      payload: { nombre: 'Yeimy SAS', tipoDocumento: 'NIT', numeroDocumento: '79123456' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().aviso.clienteExistente.nombre).toBe('Yeimy Rodríguez')
  })
})

/**
 * ── El DV se calcula y viaja armado; en la base está el número pelado ───────
 */
describe('el documento que se muestra', () => {
  it('un NIT llega con su dígito de verificación', async () => {
    const cliente = await crear({
      nombre: 'Panadería del Centro',
      tipoDocumento: 'NIT',
      numeroDocumento: '900123456',
    })

    expect(cliente.documento).toBe('900123456-8')
    expect(cliente.numeroDocumento).toBe('900123456')
  })

  it('una cédula, sin guion: no es un NIT', async () => {
    expect((await crear()).documento).toBe('79123456')
  })
})

describe('la verificación', () => {
  it('el `pos` verifica en el mostrador, y el método sale de su rol', async () => {
    const cliente = await crear()

    const res = await como('pos', {
      method: 'POST',
      url: `/clientes/${cliente.id}/verificacion`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().verificacionMetodo).toBe('pos_manual')
  })

  it('el `contador` no verifica: mira y no modifica', async () => {
    const cliente = await crear()

    expect(
      (await como('contador', { method: 'POST', url: `/clientes/${cliente.id}/verificacion` }))
        .statusCode,
    ).toBe(403)
  })
})

describe('el crédito', () => {
  it('solo el `admin` lo habilita', async () => {
    const cliente = await crear()
    await comoAdmin({ method: 'POST', url: `/clientes/${cliente.id}/verificacion` })

    expect(
      (await como('pos', {
        method: 'PUT',
        url: `/clientes/${cliente.id}/credito`,
        payload: { habilitado: true },
      })).statusCode,
    ).toBe(403)

    const res = await comoAdmin({
      method: 'PUT',
      url: `/clientes/${cliente.id}/credito`,
      payload: { habilitado: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().creditoHabilitado).toBe(true)
  })

  /**
   * 422 y no 400: la petición está bien formada. Lo que falta es un estado del
   * NEGOCIO, y el mensaje dice qué hacer.
   */
  it('sin verificar se rechaza con 422 y un mensaje accionable', async () => {
    const cliente = await crear()

    const res = await comoAdmin({
      method: 'PUT',
      url: `/clientes/${cliente.id}/credito`,
      payload: { habilitado: true },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('VERIFICACION_REQUERIDA')
    expect(res.json().mensaje).toMatch(/coteje su documento/)
  })
})

/**
 * ── El contrato incluye lo que NO existe ────────────────────────────────────
 *
 * Un cliente no se borra (RN-CLI-02): se desactiva. Borrarlo dejaría ventas y
 * botellones apuntando a nadie.
 */
describe('un cliente no se borra', () => {
  it('no existe DELETE', async () => {
    const cliente = await crear()

    expect(
      (await comoAdmin({ method: 'DELETE', url: `/clientes/${cliente.id}` })).statusCode,
    ).toBe(404)
  })

  it('se desactiva y sale del listado por defecto', async () => {
    const cliente = await crear()

    await comoAdmin({
      method: 'PATCH',
      url: `/clientes/${cliente.id}/estado`,
      payload: { activo: false },
    })

    expect((await comoAdmin({ method: 'GET', url: '/clientes' })).json()).toHaveLength(0)
    expect(
      (await comoAdmin({ method: 'GET', url: '/clientes?estado=todos' })).json(),
    ).toHaveLength(1)
  })
})

describe('la ficha', () => {
  /**
   * Los cuatro saldos de RN-CLI-06 dependen de M6 y M7. Van en `null`, no en
   * cero: un cero diría «no debe nada» y la verdad es «todavía no existe el
   * módulo que registra deudas».
   */
  it('los cuatro saldos dicen que no hay de dónde calcularlos', async () => {
    const cliente = await crear()

    const ficha = (await comoAdmin({ method: 'GET', url: `/clientes/${cliente.id}` })).json()

    expect(ficha.saldos).toEqual({
      deuda: null,
      botellones: null,
      bases: null,
      cargosPendientes: null,
    })
  })

  it('trae las direcciones del cliente', async () => {
    const cliente = await crear()
    await comoAdmin({
      method: 'POST',
      url: `/clientes/${cliente.id}/direcciones`,
      payload: { etiqueta: 'La casa', direccion: 'Calle 5 #3-20' },
    })

    const ficha = (await comoAdmin({ method: 'GET', url: `/clientes/${cliente.id}` })).json()

    expect(ficha.direcciones).toHaveLength(1)
    expect(ficha.direcciones[0].etiqueta).toBe('La casa')
  })
})
