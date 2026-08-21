import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { auditLog, productos } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { resetDb } from '@/test/db'
import {
  buscarProducto,
  crearProducto,
  desactivarProducto,
  editarPrecios,
  editarProducto,
  listarProductos,
  reactivarProducto,
} from '../service'

const PACA_600 = {
  nombre: 'Paca de 20 bolsas de 600 ml',
  presentacion: 'paca' as const,
  contenidoMl: 600,
  unidades: 20,
  precioResidencial: '12000.00',
  precioComercial: '11000.00',
  precioMinimo: '9000.00',
}

const BOTELLON = {
  nombre: 'Recarga de botellón de 20 L',
  presentacion: 'botellon' as const,
  contenidoMl: 20000,
  unidades: 1,
  precioResidencial: '10000.00',
  precioComercial: '10000.00',
  precioMinimo: '10000.00',
}

const CONTEXTO = {
  userId: null,
  rolEjercido: ['admin'],
  requestId: 'req-de-prueba',
}

/** Captura el error de negocio esperado, o falla si la operación termina bien. */
async function errorDeNegocioDe(operacion: Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await operacion
  } catch (err) {
    if (err instanceof ErrorDeNegocio) return err
    throw err
  }
  throw new Error('Se esperaba un ErrorDeNegocio, pero la operación terminó bien')
}

describe('servicio de productos (M1)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('crear — RN-CAT-11', () => {
    it('genera el código a partir de la presentación, el contenido y las unidades', async () => {
      const creado = await crearProducto(PACA_600)

      expect(creado.codigo).toBe('P20U_600ML')
      expect(Number(creado.litros)).toBe(12)
      expect(creado.activo).toBe(true)
    })

    it('un producto idéntico al reintroducirlo es la segunda encarnación', async () => {
      await crearProducto(PACA_600)

      const segundo = await crearProducto(PACA_600)

      expect(segundo.codigo).toBe('P20U_600ML_2')
    })

    it('la paca de 24 no colisiona con la de 20 — no hace falta desempate', async () => {
      await crearProducto(PACA_600)

      const veinticuatro = await crearProducto({ ...PACA_600, unidades: 24 })

      expect(veinticuatro.codigo).toBe('P24U_600ML')
    })

    it('un producto desactivado sigue ocupando su código', async () => {
      const primero = await crearProducto(PACA_600)
      await desactivarProducto(primero.id)

      const segundo = await crearProducto(PACA_600)

      expect(segundo.codigo).toBe('P20U_600ML_2')
    })
  })

  describe('el piso de precio — RN-CAT-04', () => {
    it('rechaza un piso que supera el precio residencial, con mensaje legible', async () => {
      const error = await errorDeNegocioDe(
        crearProducto({ ...PACA_600, precioMinimo: '13000.00' }),
      )

      expect(error.code).toBe('PRECIO_MINIMO_INVALIDO')
      expect(error.status).toBe(422)
      expect(error.message).toContain('precio mínimo')
    })

    it('rechaza un piso que supera el precio comercial', async () => {
      const error = await errorDeNegocioDe(
        crearProducto({ ...PACA_600, precioComercial: '8000.00' }),
      )

      expect(error.code).toBe('PRECIO_MINIMO_INVALIDO')
    })

    it('acepta que el piso sea exactamente igual a los precios de lista', async () => {
      const creado = await crearProducto(BOTELLON)

      expect(creado.codigo).toBe('BOT_20L')
    })

    it('también valida al editar precios, no solo al crear', async () => {
      const creado = await crearProducto(PACA_600)

      const error = await errorDeNegocioDe(
        editarPrecios(
          creado.id,
          { precioResidencial: '5000.00', precioComercial: '11000.00', precioMinimo: '9000.00' },
          CONTEXTO,
        ),
      )

      expect(error.code).toBe('PRECIO_MINIMO_INVALIDO')
    })

    it('no deja el producto tocado cuando el piso es inválido', async () => {
      const creado = await crearProducto(PACA_600)

      await errorDeNegocioDe(
        editarPrecios(
          creado.id,
          { precioResidencial: '5000.00', precioComercial: '11000.00', precioMinimo: '9000.00' },
          CONTEXTO,
        ),
      )

      const sinCambios = await buscarProducto(creado.id)
      expect(sinCambios?.precioResidencial).toBe('12000.00')
    })
  })

  describe('editar precios deja rastro — RN-CAT-06 y RN-ACC-04', () => {
    it('registra el antes y el después, no solo que hubo un cambio', async () => {
      const creado = await crearProducto(PACA_600)

      await editarPrecios(
        creado.id,
        { precioResidencial: '13000.00', precioComercial: '12000.00', precioMinimo: '9000.00' },
        CONTEXTO,
      )

      const [entrada] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'productos:editar_precios'))
        .orderBy(desc(auditLog.id))

      const payload = entrada?.payload as {
        codigo: string
        antes: Record<string, string>
        despues: Record<string, string>
      }

      expect(entrada?.resourceId).toBe(creado.id)
      expect(entrada?.result).toBe('ok')
      expect(payload.codigo).toBe('P20U_600ML')
      expect(payload.antes.residencial).toBe('12000.00')
      expect(payload.despues.residencial).toBe('13000.00')
    })

    it('no escribe en la bitácora si el cambio fue rechazado', async () => {
      const creado = await crearProducto(PACA_600)

      await errorDeNegocioDe(
        editarPrecios(
          creado.id,
          { precioResidencial: '5000.00', precioComercial: '11000.00', precioMinimo: '9000.00' },
          CONTEXTO,
        ),
      )

      const entradas = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'productos:editar_precios'))

      expect(entradas).toHaveLength(0)
    })
  })

  describe('editar no toca precios — la matriz tiene que seguir significando algo', () => {
    it('cambiar el nombre deja los precios intactos', async () => {
      const creado = await crearProducto(PACA_600)

      const editado = await editarProducto(creado.id, { nombre: 'Paca chica' })

      expect(editado.nombre).toBe('Paca chica')
      expect(editado.precioResidencial).toBe('12000.00')
    })
  })

  describe('desactivar, no borrar — RN-CAT-02', () => {
    it('el producto desaparece del listado por defecto y sigue existiendo', async () => {
      const creado = await crearProducto(PACA_600)

      await desactivarProducto(creado.id)

      expect(await listarProductos()).toHaveLength(0)
      expect(await listarProductos('todos')).toHaveLength(1)
      expect((await buscarProducto(creado.id))?.activo).toBe(false)
    })

    it('desactivar uno ya inactivo avisa en vez de fallar en silencio', async () => {
      const creado = await crearProducto(PACA_600)
      await desactivarProducto(creado.id)

      const error = await errorDeNegocioDe(desactivarProducto(creado.id))

      expect(error.code).toBe('PRODUCTO_YA_INACTIVO')
      expect(error.status).toBe(409)
    })

    it('reactivar lo devuelve al listado', async () => {
      const creado = await crearProducto(PACA_600)
      await desactivarProducto(creado.id)

      await reactivarProducto(creado.id)

      expect(await listarProductos()).toHaveLength(1)
    })

    it('reactivar uno que ya está activo también avisa', async () => {
      const creado = await crearProducto(PACA_600)

      const error = await errorDeNegocioDe(reactivarProducto(creado.id))

      expect(error.code).toBe('PRODUCTO_YA_ACTIVO')
    })
  })

  describe('listar', () => {
    it('ordena por código para que la pantalla sea estable entre cargas', async () => {
      await crearProducto(BOTELLON)
      await crearProducto(PACA_600)
      await crearProducto({ ...PACA_600, unidades: 50, contenidoMl: 300 })

      const codigos = (await listarProductos()).map((p) => p.codigo)

      expect(codigos).toEqual(['BOT_20L', 'P20U_600ML', 'P50U_300ML'])
    })

    it('filtra solo los inactivos cuando se pide', async () => {
      const paca = await crearProducto(PACA_600)
      await crearProducto(BOTELLON)
      await desactivarProducto(paca.id)

      const inactivos = await listarProductos('inactivos')

      expect(inactivos.map((p) => p.codigo)).toEqual(['P20U_600ML'])
    })
  })

  describe('producto inexistente', () => {
    const idQueNoExiste = '00000000-0000-0000-0000-000000000000'

    it('buscar devuelve null', async () => {
      expect(await buscarProducto(idQueNoExiste)).toBeNull()
    })

    it('desactivar da 404 y no 500', async () => {
      const error = await errorDeNegocioDe(desactivarProducto(idQueNoExiste))

      expect(error.code).toBe('PRODUCTO_NO_ENCONTRADO')
      expect(error.status).toBe(404)
    })
  })
})
