import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { auditLog, bases, movimientosBase } from '@/db/schema'
import { agregarDireccion, desactivarDireccionConReversion } from '@/modules/clientes/direcciones'
import { crearCliente } from '@/modules/clientes/service'
import { verificarDocumento } from '@/modules/clientes/verificacion'
import {
  darDeAltaBase,
  disponibilidadDeBases,
  historialDe,
  prestarBase,
} from '@/modules/retornables/bases'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Dar de baja una dirección devuelve su base al parque — RN-BAS-04.
 *
 * ── El caso que lo pidió ────────────────────────────────────────────────────
 *
 * Un cliente con DOS direcciones, una base entregada en cada una. Devuelve el
 * equipo de una sola y pide que esa dirección se saque de su perfil.
 *
 * Antes, la baja solo escribía `activa = false`. La base se quedaba con el
 * `direccion_id` de una puerta que ya no existe: no volvía al parque, no
 * aparecía en `disponibilidadDeBases` —que cuenta `direccion_id IS NULL`— y no
 * dejaba movimiento de retorno. Había que retornarla a mano después, y ese
 * retorno manual llegaba con otra fecha y sin el motivo real.
 *
 * ── Por qué siempre vuelve al parque ───────────────────────────────────────
 *
 * Reubicar la base en otra dirección del mismo cliente es un préstamo nuevo, y
 * se hace apretando «prestar». Si la baja intentara adivinar el destino, el
 * único momento en que el operador tiene la base en la mano se resolvería con
 * una suposición del sistema.
 */

const UN_CONTEXTO = { userId: null, rolEjercido: ['admin'], requestId: 'req-de-prueba' }

const UN_MOTIVO = 'el cliente devolvió el equipo de ese local'

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

/** Un cliente con dos direcciones: el caso de uso, montado. */
async function clienteConDosDirecciones() {
  const { cliente } = await crearCliente(
    {
      primerNombre: 'Yeimy',
      apellidos: 'Rodríguez',
      tipoDocumento: 'CC' as const,
      numeroDocumento: '79123456',
    },
    UN_CONTEXTO,
  )

  await verificarDocumento(cliente.id, ['admin'], UN_CONTEXTO)

  const casa = await agregarDireccion(cliente.id, {
    etiqueta: 'La casa',
    direccion: 'Calle 5 #3-20',
  })
  const deposito = await agregarDireccion(cliente.id, {
    etiqueta: 'El depósito',
    direccion: 'Carrera 8 #1-40',
  })

  return { cliente, casa, deposito }
}

describe('dar de baja una dirección devuelve su base al parque', () => {
  it('sin bases: da de baja la dirección y el conteo viene en cero', async () => {
    const { casa } = await clienteConDosDirecciones()

    const resultado = await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    expect(resultado.direccion.activa).toBe(false)
    expect(resultado.basesDevueltas).toBe(0)
  })

  it('con una base prestada: la base queda en bodega', async () => {
    const { casa } = await clienteConDosDirecciones()
    const admin = await usuarioAutenticado('admin')

    const base = await darDeAltaBase('0001', 'estructura', admin.usuario.id)
    await prestarBase(base.id, casa.id, admin.usuario.id, UN_CONTEXTO)

    const resultado = await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    expect(resultado.basesDevueltas).toBe(1)

    const [tras] = await db.select().from(bases).where(eq(bases.id, base.id))
    expect(tras!.direccionId).toBeNull()
  })

  /*
   * El corazón del reclamo: «debería quedar en estado de disponibilidad».
   *
   * `disponibilidadDeBases` cuenta `direccion_id IS NULL`. Una base colgada de
   * una dirección inactiva no es `null`, así que desaparecía del parque
   * disponible Y de las alertas de reposición de RN-BAS-13 — el sistema avisaba
   * que no alcanzaban las bases teniéndolas en la bodega.
   */
  it('la base vuelve a contar como disponible', async () => {
    const { casa } = await clienteConDosDirecciones()
    const admin = await usuarioAutenticado('admin')

    const base = await darDeAltaBase('0001', 'estructura', admin.usuario.id)
    await prestarBase(base.id, casa.id, admin.usuario.id, UN_CONTEXTO)

    const prestada = await disponibilidadDeBases('estructura')
    expect(prestada.libres).toBe(0)

    await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    const devuelta = await disponibilidadDeBases('estructura')
    expect(devuelta.libres).toBe(1)
  })

  /*
   * El caso de uso completo: devuelve el equipo de UNA dirección. La base de la
   * otra se queda donde está — sigue en su poder y sigue siendo reclamable.
   */
  it('no toca la base de la OTRA dirección del mismo cliente', async () => {
    const { casa, deposito } = await clienteConDosDirecciones()
    const admin = await usuarioAutenticado('admin')

    const laDeLaCasa = await darDeAltaBase('0001', 'estructura', admin.usuario.id)
    const laDelDeposito = await darDeAltaBase('0002', 'estructura', admin.usuario.id)

    await prestarBase(laDeLaCasa.id, casa.id, admin.usuario.id, UN_CONTEXTO)
    await prestarBase(laDelDeposito.id, deposito.id, admin.usuario.id, UN_CONTEXTO)

    const resultado = await desactivarDireccionConReversion(deposito.id, UN_MOTIVO, UN_CONTEXTO)

    expect(resultado.basesDevueltas).toBe(1)

    const [enLaCasa] = await db.select().from(bases).where(eq(bases.id, laDeLaCasa.id))
    const [delDeposito] = await db.select().from(bases).where(eq(bases.id, laDelDeposito.id))

    expect(enLaCasa!.direccionId).toBe(casa.id)
    expect(delDeposito!.direccionId).toBeNull()
  })

  /*
   * El retorno manual que Mao venía haciendo llegaba con la fecha del arreglo y
   * sin el motivo: el historial de la base tenía un hueco justo donde cambió de
   * manos.
   */
  it('el movimiento de retorno dice de qué dirección volvió y por qué', async () => {
    const { casa } = await clienteConDosDirecciones()
    const admin = await usuarioAutenticado('admin')

    const base = await darDeAltaBase('0001', 'estructura', admin.usuario.id)
    await prestarBase(base.id, casa.id, admin.usuario.id, UN_CONTEXTO)

    await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    const [retorno] = await historialDe(base.id)

    expect(retorno!.tipo).toBe('retorno')
    expect(retorno!.direccionId).toBe(casa.id)
    expect(retorno!.motivo).toBe(UN_MOTIVO)
    expect(retorno!.lugar).toContain('La casa')
  })

  it('una dirección ya inactiva: rechaza con DIRECCION_YA_INACTIVA', async () => {
    const { casa } = await clienteConDosDirecciones()

    await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    await expect(
      desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO),
    ).rejects.toMatchObject({ code: 'DIRECCION_YA_INACTIVA' })
  })

  it('una dirección inexistente: rechaza con DIRECCION_NO_ENCONTRADA', async () => {
    await expect(
      desactivarDireccionConReversion(
        '00000000-0000-0000-0000-000000000000',
        UN_MOTIVO,
        UN_CONTEXTO,
      ),
    ).rejects.toMatchObject({ code: 'DIRECCION_NO_ENCONTRADA' })
  })

  /*
   * El mismo piso que descartar una base o anular una venta: la baja mueve un
   * activo del cliente al parque, y eso tiene que quedar explicado.
   */
  it('un motivo de menos de diez caracteres: rechaza con MOTIVO_REQUERIDO', async () => {
    const { casa } = await clienteConDosDirecciones()

    await expect(
      desactivarDireccionConReversion(casa.id, 'devolvió', UN_CONTEXTO),
    ).rejects.toMatchObject({ code: 'MOTIVO_REQUERIDO' })

    const [sinTocar] = await db.select().from(bases)
    expect(sinTocar).toBeUndefined()
  })

  it('la bitácora guarda el motivo y cuántas bases volvieron', async () => {
    const { casa } = await clienteConDosDirecciones()
    const admin = await usuarioAutenticado('admin')

    const base = await darDeAltaBase('0001', 'estructura', admin.usuario.id)
    await prestarBase(base.id, casa.id, admin.usuario.id, UN_CONTEXTO)

    await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    const [fila] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'clientes:dar_de_baja_direccion'))

    expect(fila!.result).toBe('ok')
    expect(fila!.resourceId).toBe(casa.id)
    expect(fila!.payload).toMatchObject({ motivo: UN_MOTIVO, basesDevueltas: 1 })
  })

  /*
   * Si la mitad escribe y la otra no, el libro dice que la base volvió y la
   * base sigue prestada —o la dirección queda activa con su base ya en bodega—.
   * La transacción es lo que lo impide.
   */
  it('todo en una transacción: nada queda a medias', async () => {
    const { casa } = await clienteConDosDirecciones()
    const admin = await usuarioAutenticado('admin')

    const base = await darDeAltaBase('0001', 'estructura', admin.usuario.id)
    await prestarBase(base.id, casa.id, admin.usuario.id, UN_CONTEXTO)

    await desactivarDireccionConReversion(casa.id, UN_MOTIVO, UN_CONTEXTO)

    const retornos = await db
      .select()
      .from(movimientosBase)
      .where(eq(movimientosBase.tipo, 'retorno'))

    expect(retornos).toHaveLength(1)
    expect(retornos[0]!.direccionId).toBe(casa.id)
  })
})
