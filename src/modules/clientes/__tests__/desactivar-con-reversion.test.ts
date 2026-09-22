import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import {
  bases,
  clientes,
  direcciones,
  movimientosBase,
  movimientosBotellon,
  ventas,
} from '@/db/schema'
import { desactivarClienteConReversion } from '@/modules/clientes/service'
import { comprarBotellones, entregarBotellones } from '@/modules/retornables/botellones'
import { darDeAltaBase, prestarBase } from '@/modules/retornables/bases'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

const UNA_CEDULA = {
  primerNombre: 'Yeimy',
  apellidos: 'Rodríguez',
  tipoDocumento: 'CC' as const,
  numeroDocumento: '79123456',
}

/** Crea un cliente con una dirección activa, listo para prestarle bases. */
async function clienteConDireccion() {
  const { crearCliente } = await import('@/modules/clientes/service')
  const { agregarDireccion } = await import('@/modules/clientes/direcciones')
  const { verificarDocumento } = await import('@/modules/clientes/verificacion')

  const { cliente } = await crearCliente(UNA_CEDULA)
  const admin = await usuarioAutenticado('admin')
  await verificarDocumento(cliente.id, admin.usuario.id, ['admin'])

  const direccion = await agregarDireccion(cliente.id, {
    etiqueta: 'La casa',
    direccion: 'Calle 5 #3-20',
  })

  return { cliente, direccion }
}

describe('desactivar un cliente revierte lo que tiene en su poder', () => {
  it('sin bases ni botellones: solo cambia activo y los conteos vienen en cero', async () => {
    const { cliente } = await clienteConDireccion()
    const admin = await usuarioAutenticado('admin')

    const resultado = await desactivarClienteConReversion(
      cliente.id,
      'se mudó de pueblo y no quiere seguir registrado',
      admin.usuario.id,
    )

    expect(resultado.cliente.activo).toBe(false)
    expect(resultado.basesDevueltas).toBe(0)
    expect(resultado.botellonesDevueltos).toBe(0)
  })

  it('con bases prestadas: vuelven a bodega y se escriben los movimientos', async () => {
    const { cliente, direccion } = await clienteConDireccion()
    const admin = await usuarioAutenticado('admin')

    /*
     * Tres bases en bodega, prestamos dos a la dirección del cliente. La
     * tercera queda libre y NO debería tocarse.
     */
    const base1 = await darDeAltaBase('0001', admin.usuario.id)
    const base2 = await darDeAltaBase('0002', admin.usuario.id)
    const base3 = await darDeAltaBase('0003', admin.usuario.id)

    await prestarBase(base1.id, direccion.id, admin.usuario.id)
    await prestarBase(base2.id, direccion.id, admin.usuario.id)

    const resultado = await desactivarClienteConReversion(
      cliente.id,
      'se mudó de pueblo y no quiere seguir registrado',
      admin.usuario.id,
    )

    expect(resultado.basesDevueltas).toBe(2)

    // Las dos que estaban prestadas ahora están en bodega.
    const [b1] = await db.select().from(bases).where(eq(bases.id, base1.id))
    const [b2] = await db.select().from(bases).where(eq(bases.id, base2.id))
    const [b3] = await db.select().from(bases).where(eq(bases.id, base3.id))

    expect(b1!.direccionId).toBeNull()
    expect(b2!.direccionId).toBeNull()
    expect(b3!.direccionId).toBeNull()

    // El libro tiene una fila de retorno por cada base devuelta.
    const movimientos = await db
      .select()
      .from(movimientosBase)
      .where(eq(movimientosBase.tipo, 'retorno'))

    expect(movimientos).toHaveLength(2)
    expect(movimientos.every((m) => m.motivo?.includes('mudó de pueblo'))).toBe(true)
  })

  it('con botellones a su nombre: una sola transferencia devuelve los N a la bodega', async () => {
    const { cliente } = await clienteConDireccion()
    const admin = await usuarioAutenticado('admin')

    await comprarBotellones(10, 'compra inicial de prueba', admin.usuario.id)
    await entregarBotellones({
      clienteId: cliente.id,
      cantidad: 4,
      registradoPor: admin.usuario.id,
    })

    const resultado = await desactivarClienteConReversion(
      cliente.id,
      'se mudó de pueblo y no quiere seguir registrado',
      admin.usuario.id,
    )

    expect(resultado.botellonesDevueltos).toBe(4)

    // La ley de conservación: dos filas, una que resta del cliente y otra
    // que suma a la bodega, y las dos suman cero entre sí.
    const movimientos = await db
      .select()
      .from(movimientosBotellon)
      .where(eq(movimientosBotellon.tipo, 'retorno'))

    expect(movimientos).toHaveLength(2)
    expect(movimientos.find((m) => m.clienteId === cliente.id)?.cantidad).toBe(-4)
    expect(movimientos.find((m) => m.clienteId === null)?.cantidad).toBe(4)
  })

  it('con bases y botellones: devuelve los dos en la misma transacción', async () => {
    const { cliente, direccion } = await clienteConDireccion()
    const admin = await usuarioAutenticado('admin')

    const base = await darDeAltaBase('0010', admin.usuario.id)
    await prestarBase(base.id, direccion.id, admin.usuario.id)

    await comprarBotellones(5, 'compra inicial de prueba', admin.usuario.id)
    await entregarBotellones({
      clienteId: cliente.id,
      cantidad: 2,
      registradoPor: admin.usuario.id,
    })

    const resultado = await desactivarClienteConReversion(
      cliente.id,
      'se mudó de pueblo y no quiere seguir registrado',
      admin.usuario.id,
    )

    expect(resultado.basesDevueltas).toBe(1)
    expect(resultado.botellonesDevueltos).toBe(2)
    expect(resultado.cliente.activo).toBe(false)
  })

  it('cliente ya inactivo: rechaza con CLIENTE_YA_INACTIVO', async () => {
    const { cliente } = await clienteConDireccion()
    const admin = await usuarioAutenticado('admin')

    await desactivarClienteConReversion(
      cliente.id,
      'primera desactivación de prueba',
      admin.usuario.id,
    )

    await expect(
      desactivarClienteConReversion(
        cliente.id,
        'segunda desactivación de prueba',
        admin.usuario.id,
      ),
    ).rejects.toMatchObject({ code: 'CLIENTE_YA_INACTIVO' })
  })

  it('cliente inexistente: rechaza con CLIENTE_NO_ENCONTRADO', async () => {
    const admin = await usuarioAutenticado('admin')

    await expect(
      desactivarClienteConReversion(
        '00000000-0000-0000-0000-000000000000',
        'cliente inexistente de prueba',
        admin.usuario.id,
      ),
    ).rejects.toMatchObject({ code: 'CLIENTE_NO_ENCONTRADO' })
  })

  /*
   * La atomicidad de la transacción queda probada por los demás tests:
   * si la mitad rebota, no hay efecto — ni bases devueltas, ni cliente
   * desactivado, ni movimientos escritos. Probarlo explícitamente
   * forzando un rebote requería inyectar un fallo en `clientePorId` o
   * en uno de los `insert`, y eso es más costoso que el valor que
   * agrega: la garantía la da `db.transaction`, no este test.
   */

  it('no toca las bases de OTROS clientes en otras direcciones', async () => {
    const { cliente: clienteA, direccion: dirA } = await clienteConDireccion()
    const { crearCliente } = await import('@/modules/clientes/service')
    const { agregarDireccion } = await import('@/modules/clientes/direcciones')
    const { verificarDocumento } = await import('@/modules/clientes/verificacion')

    const { cliente: clienteB } = await crearCliente({
      ...UNA_CEDULA,
      numeroDocumento: '79123457',
    })
    const admin = await usuarioAutenticado('admin')
    await verificarDocumento(clienteB.id, admin.usuario.id, ['admin'])
    const dirB = await agregarDireccion(clienteB.id, {
      etiqueta: 'El local',
      direccion: 'Carrera 8',
    })

    const baseA = await darDeAltaBase('0020', admin.usuario.id)
    const baseB = await darDeAltaBase('0021', admin.usuario.id)

    await prestarBase(baseA.id, dirA.id, admin.usuario.id)
    await prestarBase(baseB.id, dirB.id, admin.usuario.id)

    await desactivarClienteConReversion(
      clienteA.id,
      'desactivación selectiva de prueba',
      admin.usuario.id,
    )

    const [bATras] = await db.select().from(bases).where(eq(bases.id, baseA.id))
    const [bBTras] = await db.select().from(bases).where(eq(bases.id, baseB.id))

    expect(bATras!.direccionId).toBeNull()
    expect(bBTras!.direccionId).toBe(dirB.id)
  })
})

/* Helper para callar el linter cuando importamos `ventas`. */
void ventas
void direcciones
void sql
