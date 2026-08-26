import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { auditLog, insumos } from '@/db/schema'
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

/** Un insumo por unidad, ya cargado. Devuelve su id. */
async function unaTapa(): Promise<string> {
  const res = await comoAdmin({
    method: 'POST',
    url: '/insumos',
    payload: { codigo: 'TAPA_20L', nombre: 'Tapa para botellón de 20 L', minimo: 200 },
  })
  return res.json().id
}

describe('GET /insumos', () => {
  it('devuelve el catálogo con el aviso de mínimo resuelto', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 500 } })

    const res = await comoAdmin({ method: 'GET', url: '/insumos' })

    expect(res.statusCode).toBe(200)
    const [insumo] = res.json()
    expect(insumo.saldo).toBe(500)
    // El servicio ya resolvió la comparación: la pantalla no repite la regla.
    expect(insumo.bajoMinimo).toBe(false)
  })

  it('el `pos` lo ve: sin insumos no puede producir', async () => {
    await unaTapa()

    const res = await como('pos', { method: 'GET', url: '/insumos' })

    expect(res.statusCode).toBe(200)
  })

  it('el `contador` lo ve para cerrar los números', async () => {
    await unaTapa()

    const res = await como('contador', { method: 'GET', url: '/insumos' })

    expect(res.statusCode).toBe(200)
  })

  /**
   * El `seller` contacta clientes y registra ventas: no toca la planta.
   *
   * Ocultar el link del menú es cosmética (RN-ACC-02) — la barrera real es
   * esta, y por eso se verifica acá y no en `web/`.
   */
  it('el `seller` recibe 403', async () => {
    const res = await como('seller', { method: 'GET', url: '/insumos' })

    expect(res.statusCode).toBe(403)
  })

  it('sin sesión, 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/insumos' })

    expect(res.statusCode).toBe(401)
  })

  it('no lista los inactivos salvo que se pidan', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'PATCH', url: `/insumos/${id}`, payload: { activo: false } })

    expect((await comoAdmin({ method: 'GET', url: '/insumos' })).json()).toHaveLength(0)
    expect(
      (await comoAdmin({ method: 'GET', url: '/insumos?estado=todos' })).json(),
    ).toHaveLength(1)
  })
})

describe('POST /insumos/:id/entrada', () => {
  it('el `pos` puede registrar una compra', async () => {
    const id = await unaTapa()

    const res = await como('pos', {
      method: 'POST',
      url: `/insumos/${id}/entrada`,
      payload: { cantidad: 500 },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ ok: true, saldo: 500 })
  })

  it('el `seller` recibe 403 y queda auditado', async () => {
    const id = await unaTapa()

    const res = await como('seller', {
      method: 'POST',
      url: `/insumos/${id}/entrada`,
      payload: { cantidad: 500 },
    })

    expect(res.statusCode).toBe(403)

    const [ultimo] = await db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(1)

    expect(ultimo?.result).toBe('denied')
    expect(ultimo?.resource).toBe('insumos')
  })

  it('rechaza mandar unidades y kilos a la vez', async () => {
    // Si no coinciden, una de las dos es un error de carga y el sistema no
    // tiene forma de saber cuál.
    const id = await unaTapa()

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/entrada`,
      payload: { cantidad: 500, kilos: 5 },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rechaza no mandar ninguna de las dos', async () => {
    const id = await unaTapa()

    const res = await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: {} })

    expect(res.statusCode).toBe(400)
  })

  /**
   * La conversión bloqueada por la medición que falta — pregunta 37.
   *
   * Es 422 y no 400: la petición está bien formada, lo que falta es un dato del
   * NEGOCIO que nadie midió todavía. Un 400 diría «lo escribiste mal».
   */
  it('rechaza kilos con 422 cuando el insumo no tiene equivalencia', async () => {
    const id = await unaTapa()

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/entrada`,
      payload: { kilos: 12 },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('SIN_EQUIVALENCIA')
    // El mensaje tiene que decir QUÉ hacer, no solo que no se pudo.
    expect(res.json().mensaje).toMatch(/pesar un paquete y contarlo/)
  })

  it('con la equivalencia cargada, convierte', async () => {
    const id = await unaTapa()
    await comoAdmin({
      method: 'PATCH',
      url: `/insumos/${id}`,
      payload: { equivalenciaPorKilo: 100 },
    })

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/entrada`,
      payload: { kilos: 12.5 },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().saldo).toBe(1250)
  })
})

describe('POST /insumos/:id/ajuste', () => {
  it('exige un motivo que sirva', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 500 } })

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/ajuste`,
      payload: { diferencia: -8, motivo: 'x' },
    })

    // Zod atrapa el largo antes que el servicio: es forma, no regla.
    expect(res.statusCode).toBe(400)
  })

  it('descuenta con motivo', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 500 } })

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/ajuste`,
      payload: { diferencia: -8, motivo: 'conteo físico del lunes, faltaban 8 tapas' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, saldo: 492 })
  })

  it('un ajuste de cero no ajusta nada', async () => {
    const id = await unaTapa()

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/ajuste`,
      payload: { diferencia: 0, motivo: 'no encontré diferencia en el conteo' },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('POST /insumos/:id/descarte', () => {
  it('con causa `otro` exige explicar', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 500 } })

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/descarte`,
      payload: { cantidad: 5, causa: 'otro', observaciones: 'x' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('OBSERVACIONES_REQUERIDAS')
  })

  it('las demás causas se explican solas', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 500 } })

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/descarte`,
      payload: { cantidad: 5, causa: 'mal_manejo_cliente' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().saldo).toBe(495)
  })

  it('descartar más de lo que hay devuelve ok:false, no un error', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 10 } })

    const res = await comoAdmin({
      method: 'POST',
      url: `/insumos/${id}/descarte`,
      payload: { cantidad: 50, causa: 'vencido' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: false, disponible: 10 })
  })
})

/**
 * ── El contrato incluye lo que NO existe ────────────────────────────────────
 *
 * No hay ninguna ruta que edite el saldo a mano. Se mueve mediante documentos
 * con motivo y responsable, o no se mueve. Que estas rutas no existan es parte
 * del diseño, y sin este test nadie se enteraría de que alguien las agregó.
 */
describe('el saldo no se edita a mano', () => {
  it('no existe PUT sobre el saldo', async () => {
    const id = await unaTapa()

    const res = await comoAdmin({
      method: 'PUT',
      url: `/insumos/${id}/saldo`,
      payload: { saldo: 9999 },
    })

    expect(res.statusCode).toBe(404)
  })

  it('PATCH del insumo NO toca el saldo aunque se lo manden', async () => {
    const id = await unaTapa()
    await comoAdmin({ method: 'POST', url: `/insumos/${id}/entrada`, payload: { cantidad: 500 } })

    await comoAdmin({ method: 'PATCH', url: `/insumos/${id}`, payload: { saldo: 9999 } })

    const [insumo] = await db.select().from(insumos).where(eq(insumos.id, id))
    expect(insumo?.saldo).toBe(500)
  })
})

describe('un insumo que no existe', () => {
  it('GET devuelve 404', async () => {
    const res = await comoAdmin({
      method: 'GET',
      url: '/insumos/00000000-0000-0000-0000-000000000000',
    })

    expect(res.statusCode).toBe(404)
  })

  it('cargarle una entrada devuelve 404', async () => {
    const res = await comoAdmin({
      method: 'POST',
      url: '/insumos/00000000-0000-0000-0000-000000000000/entrada',
      payload: { cantidad: 10 },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('INSUMO_NO_ENCONTRADO')
  })
})
