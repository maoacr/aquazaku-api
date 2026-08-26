import { desc } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, insumos, productos } from '@/db/schema'
import type { Role } from '@/modules/authz/matrix'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

let app: FastifyInstance
let admin: { usuario: { id: string }; cookie: string }

const CATALOGO = [
  { codigo: 'BOT_20L', nombre: 'Recarga de botellón de 20 L', presentacion: 'botellon' as const, contenidoMl: 20000, unidades: 1 },
  { codigo: 'P20U_600ML', nombre: 'Paca de 20 bolsas de 600 ml', presentacion: 'paca' as const, contenidoMl: 600, unidades: 20 },
  { codigo: 'P50U_300ML', nombre: 'Paca de 50 bolsas de 300 ml', presentacion: 'paca' as const, contenidoMl: 300, unidades: 50 },
]

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

  await db.insert(productos).values(
    CATALOGO.map((p) => ({
      ...p,
      precioResidencial: '10000.00',
      precioComercial: '9000.00',
      precioMinimo: '8000.00',
    })),
  )
  await db.insert(insumos).values([
    { codigo: 'TAPA_20L', nombre: 'Tapa para botellón de 20 L', minimo: 200, saldo: 500 },
    { codigo: 'SELLO_BOTELLON', nombre: 'Sello termoencogible', minimo: 200, saldo: 500 },
  ])
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

const UN_CIERRE = {
  fecha: '2026-08-26',
  minutosProcesando: 120,
  pacas600: 10,
  pacas300: 5,
  botellonesLlenados: 30,
}

describe('POST /produccion/cierres', () => {
  it('el `pos` registra el cierre: es quien opera la planta', async () => {
    const res = await como('pos', {
      method: 'POST',
      url: '/produccion/cierres',
      payload: UN_CIERRE,
    })

    expect(res.statusCode).toBe(201)
    // Tres lotes: dos pacas y los botellones — RN-PRD-23.
    expect(res.json().lotes).toHaveLength(3)
  })

  /**
   * El contador es un TESTIGO, no un operador.
   *
   * Que pudiera cerrar el día haría que la separación de funciones dejara de
   * significar algo: existe justamente para que haya alguien que mire la
   * contabilidad sin poder alterarla.
   */
  it('el `contador` mira pero no cierra', async () => {
    expect((await como('contador', { method: 'GET', url: '/produccion' })).statusCode).toBe(200)

    const res = await como('contador', {
      method: 'POST',
      url: '/produccion/cierres',
      payload: UN_CIERRE,
    })
    expect(res.statusCode).toBe(403)
  })

  it('el `seller` no ve ni cierra: no toca la planta', async () => {
    expect((await como('seller', { method: 'GET', url: '/produccion' })).statusCode).toBe(403)
  })

  it('un intento denegado queda auditado', async () => {
    await como('seller', { method: 'POST', url: '/produccion/cierres', payload: UN_CIERRE })

    const [ultimo] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('produccion')
  })

  it('rechaza un segundo cierre para la misma fecha', async () => {
    await comoAdmin({ method: 'POST', url: '/produccion/cierres', payload: UN_CIERRE })

    const res = await comoAdmin({ method: 'POST', url: '/produccion/cierres', payload: UN_CIERRE })
    // El UNIQUE(fecha) sube como error de base, no como ErrorDeNegocio.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  /**
   * 422 y no 400: la petición está bien formada. Lo que falta es un dato del
   * NEGOCIO que nadie midió. Un 400 diría «lo escribiste mal» y mandaría a
   * revisar el formulario en vez de ir a medir.
   */
  it('rechaza lavados sin la medición, con 422 y un mensaje accionable', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/produccion/cierres',
      payload: { ...UN_CIERRE, botellonesLavados: 20 },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('SIN_LITROS_DE_LAVADO')
    expect(res.json().mensaje).toMatch(/medirlo una vez/)
  })

  it('rechaza un cierre sin tiempo de procesamiento', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/produccion/cierres',
      payload: { ...UN_CIERRE, minutosProcesando: 0 },
    })

    // Zod lo atrapa antes que el servicio: es forma.
    expect(res.statusCode).toBe(400)
  })

  it('un día sin envasar es un cierre válido', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/produccion/cierres',
      payload: { fecha: '2026-08-27', minutosProcesando: 60 },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().lotes).toHaveLength(0)
  })
})

/**
 * ── El contrato incluye lo que NO existe ────────────────────────────────────
 *
 * Un cierre no se edita — RN-PRD-08. Editarlo cambiaría a la vez el agua, el
 * stock y los insumos sin dejar rastro de qué decía antes.
 */
describe('un cierre no se edita', () => {
  it('no existe PATCH', async () => {
    await comoAdmin({ method: 'POST', url: '/produccion/cierres', payload: UN_CIERRE })

    const res = await comoAdmin({
      method: 'PATCH',
      url: '/produccion/2026-08-26',
      payload: { pacas600: 999 },
    })

    expect(res.statusCode).toBe(404)
  })

  it('no existe DELETE', async () => {
    await comoAdmin({ method: 'POST', url: '/produccion/cierres', payload: UN_CIERRE })

    expect(
      (await comoAdmin({ method: 'DELETE', url: '/produccion/2026-08-26' })).statusCode,
    ).toBe(404)
  })
})

describe('los tanques', () => {
  it('devuelve los dos saldos con su nivel', async () => {
    const res = await comoAdmin({ method: 'GET', url: '/tanques' })

    expect(res.statusCode).toBe(200)
    const saldos = res.json()
    expect(saldos.map((s: { tanque: string }) => s.tanque)).toEqual(['crudo', 'procesado'])
    expect(saldos[0]).toHaveProperty('nivelCalculado')
  })

  /**
   * ── La separación que da sentido a tener DOS permisos ────────────────────
   *
   * El `pos` puede registrar que llegó agua —es un hecho que observa— pero NO
   * ajustar un saldo que no cuadra. Quien opera no debería poder tapar su
   * propia discrepancia.
   */
  it('el `pos` puede registrar que llegó agua', async () => {
    const res = await como('pos', {
      method: 'POST',
      url: '/tanques/reposicion',
      payload: { tanque: 'crudo' },
    })

    expect(res.statusCode).toBe(201)
    // Sin cantidad: registra el HECHO — RN-PRD-11.
    expect(res.json().litros).toBe(0)
  })

  it('pero el `pos` NO puede ajustar el saldo', async () => {
    const res = await como('pos', {
      method: 'POST',
      url: '/tanques/ajuste',
      payload: { tanque: 'crudo', litros: 5000, motivo: 'el tanque se ve más lleno' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('el `admin` sí puede ajustar, con motivo', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/tanques/ajuste',
      payload: {
        tanque: 'crudo',
        litros: 6500,
        motivo: 'llegó agua de la red y el tanque quedó a medio llenar',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().litros).toBe(6500)
    expect(res.json().nivelCalculado).toBe('medio')
  })

  it('el ajuste sin motivo se rechaza', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/tanques/ajuste',
      payload: { tanque: 'crudo', litros: 500, motivo: 'x' },
    })

    expect(res.statusCode).toBe(400)
  })

  /**
   * La reposición NO acepta litros, y eso es la regla hecha contrato.
   *
   * Si los aceptara, alguien los mandaría a ojo y el sistema convertiría un
   * hueco conocido en un número que parece medido.
   */
  it('la reposición ignora una cantidad si se la mandan', async () => {
    await comoAdmin({
      method: 'POST',
      url: '/tanques/reposicion',
      payload: { tanque: 'crudo', litros: 9999 },
    })

    expect((await comoAdmin({ method: 'GET', url: '/tanques' })).json()[0].litros).toBe(0)
  })
})

describe('la reconciliación es una consulta', () => {
  it('dice si cuadra, sin escribir', async () => {
    await comoAdmin({
      method: 'POST',
      url: '/tanques/ajuste',
      payload: { tanque: 'crudo', litros: 6500, motivo: 'carga inicial para la prueba' },
    })

    const res = await comoAdmin({
      method: 'GET',
      url: '/tanques/reconciliacion?tanque=crudo&nivel=medio',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ cuadra: true, ajusteSugerido: 0 })

    // Y el saldo no se movió.
    expect((await comoAdmin({ method: 'GET', url: '/tanques' })).json()[0].litros).toBe(6500)
  })

  it('marca la discrepancia cuando el ojo y el libro no coinciden', async () => {
    const res = await comoAdmin({
      method: 'GET',
      url: '/tanques/reconciliacion?tanque=crudo&nivel=lleno',
    })

    expect(res.json().cuadra).toBe(false)
    expect(res.json().ajusteSugerido).toBeGreaterThan(0)
  })

  /**
   * El `contador` ve la PRODUCCIÓN pero no los tanques, y es coherente.
   *
   * Cierra los libros, y el agua no es un costo variable: es tarifa plana
   * (RN-PRD-10). Lo que necesita es cuánto se produjo, no cuánta agua queda en
   * un tanque — ese dato es operativo, no contable.
   *
   * Este test tenía el nombre al revés de lo que verifica. Corregido: decía
   * «puede consultarla» y asertaba un 403.
   */
  it('el `contador` NO ve los tanques: el agua no es un dato contable', async () => {
    const res = await como('contador', {
      method: 'GET',
      url: '/tanques/reconciliacion?tanque=crudo&nivel=medio',
    })

    expect(res.statusCode).toBe(403)

    // Pero sí ve la producción, que es lo que necesita para cerrar los números.
    expect((await como('contador', { method: 'GET', url: '/produccion' })).statusCode).toBe(200)
  })
})
