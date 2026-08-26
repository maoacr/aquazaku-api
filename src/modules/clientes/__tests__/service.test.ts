import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { clientes } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { configurarCredito } from '@/modules/clientes/credito'
import { agregarDireccion, direccionesDe } from '@/modules/clientes/direcciones'
import {
  cambiarEstado,
  crearCliente,
  editarCliente,
  listarClientes,
} from '@/modules/clientes/service'
import { revertirVerificacion, verificarDocumento } from '@/modules/clientes/verificacion'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await closeDb()
})

const UNA_CEDULA = { nombre: 'Yeimy Rodríguez', tipoDocumento: 'CC' as const, numeroDocumento: '79123456' }

/** Crea un cliente ya verificado, que es el punto de partida del crédito. */
async function clienteVerificado() {
  const { cliente } = await crearCliente(UNA_CEDULA)
  const admin = await usuarioAutenticado('admin')

  return verificarDocumento(cliente.id, admin.usuario.id, ['admin'])
}

describe('el alta exige documento — RN-CLI-13', () => {
  it('normaliza el número al guardarlo', async () => {
    const { cliente } = await crearCliente({ ...UNA_CEDULA, numeroDocumento: '79.123.456' })

    expect(cliente.numeroDocumento).toBe('79123456')
  })

  it('nace pendiente de verificar y sin crédito', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    expect(cliente.verificacionEstado).toBe('pendiente')
    expect(cliente.creditoHabilitado).toBe(false)
    expect(cliente.verificadoPor).toBeNull()
  })

  it('sin dígitos, se rechaza con un mensaje del negocio', async () => {
    await expect(
      crearCliente({ ...UNA_CEDULA, numeroDocumento: 'después lo traigo' }),
    ).rejects.toMatchObject({ code: 'DOCUMENTO_INVALIDO' })
  })

  it('sin nombre, tampoco', async () => {
    await expect(crearCliente({ ...UNA_CEDULA, nombre: '   ' })).rejects.toMatchObject({
      code: 'NOMBRE_REQUERIDO',
    })
  })
})

describe('el mismo número con los dos tipos — RN-CLI-08', () => {
  it('el duplicado REAL no entra: mismo tipo y mismo número', async () => {
    await crearCliente(UNA_CEDULA)

    await expect(crearCliente({ ...UNA_CEDULA, nombre: 'Otro' })).rejects.toThrow()
  })

  /**
   * ── Por qué esto ADVIERTE en vez de rechazar ─────────────────────────────
   *
   * El NIT de una persona natural se basa en su cédula, así que el mismo número
   * como CC y como NIT puede ser la misma persona. También puede ser un
   * duplicado entrando por la puerta de atrás.
   *
   * La base no puede distinguir los dos casos. Adivinarlo sería peor que
   * preguntar, y bloquearlo haría imposible un caso legítimo.
   */
  it('el cruce CC/NIT avisa y deja seguir', async () => {
    await crearCliente(UNA_CEDULA)

    const { cliente, aviso } = await crearCliente({
      nombre: 'Yeimy Rodríguez SAS',
      tipoDocumento: 'NIT',
      numeroDocumento: '79123456',
    })

    expect(cliente.id).toBeDefined()
    expect(aviso?.clienteExistente.nombre).toBe('Yeimy Rodríguez')
    expect(aviso?.mensaje).toMatch(/parten su deuda/)
  })

  it('sin cruce, no hay aviso', async () => {
    const { aviso } = await crearCliente(UNA_CEDULA)

    expect(aviso).toBeNull()
  })

  /** Los ceros a la izquierda no crean una persona nueva. */
  it('`079123456` es el mismo documento que `79123456`', async () => {
    await crearCliente(UNA_CEDULA)

    await expect(
      crearCliente({ ...UNA_CEDULA, nombre: 'Otro', numeroDocumento: '079123456' }),
    ).rejects.toThrow()
  })
})

describe('la verificación deja quién, cuándo y cómo — RN-CLI-14', () => {
  it('escribe los cuatro campos juntos', async () => {
    const cliente = await clienteVerificado()

    expect(cliente.verificacionEstado).toBe('verificado')
    expect(cliente.verificadoPor).not.toBeNull()
    expect(cliente.verificadoEn).not.toBeNull()
    expect(cliente.verificacionMetodo).toBe('admin_oficial')
  })

  /**
   * El método sale del ROL, no de un parámetro. Si viniera del cliente HTTP, un
   * `seller` podría marcar `admin_oficial` y darle a su cotejo en la calle el
   * peso de una validación contra documento oficial.
   */
  it('el método lo decide el rol de quien verifica', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)
    const vendedor = await usuarioAutenticado('seller')

    const verificado = await verificarDocumento(cliente.id, vendedor.usuario.id, ['seller'])

    expect(verificado.verificacionMetodo).toBe('seller_manual')
  })

  it('verificar dos veces se rechaza: reemplazaría a quien respondió', async () => {
    const cliente = await clienteVerificado()

    await expect(verificarDocumento(cliente.id, null, ['admin'])).rejects.toMatchObject({
      code: 'YA_VERIFICADO',
    })
  })
})

describe('crédito exige verificación — RN-CLI-15', () => {
  it('a un cliente pendiente no se le habilita', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await expect(configurarCredito(cliente.id, { habilitado: true })).rejects.toMatchObject({
      code: 'VERIFICACION_REQUERIDA',
    })
  })

  it('verificado sí, y sin tope por defecto', async () => {
    const verificado = await clienteVerificado()

    const conCredito = await configurarCredito(verificado.id, { habilitado: true })

    expect(conCredito.creditoHabilitado).toBe(true)
    expect(conCredito.creditoLimite).toBeNull()
  })

  /**
   * ── La mitad del invariante que un guard de «habilitar» nunca cubre ───────
   *
   * Habilitar crédito y DESPUÉS desverificar deja la misma fila inconsistente
   * por el otro lado. Es el camino del que nadie se acuerda.
   */
  it('desverificar a alguien con crédito se rechaza', async () => {
    const verificado = await clienteVerificado()
    await configurarCredito(verificado.id, { habilitado: true })

    await expect(
      revertirVerificacion(verificado.id, 'la cédula que trajo era de otra persona'),
    ).rejects.toMatchObject({ code: 'CREDITO_ACTIVO' })
  })

  /**
   * Y si alguien esquiva el servicio, el `CHECK` sigue ahí. Este test escribe
   * DIRECTO contra la base para probar que el invariante no depende del código
   * de arriba — es la línea de ADR-0006.
   */
  it('el CHECK de la base lo impide aunque se esquive el servicio', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await expect(
      db.update(clientes).set({ creditoHabilitado: true }).where(eq(clientes.id, cliente.id)),
    ).rejects.toThrow()
  })

  it('deshabilitar borra el tope, para no heredarlo sin revisar', async () => {
    const verificado = await clienteVerificado()
    await configurarCredito(verificado.id, { habilitado: true, limite: 500000 })

    const sinCredito = await configurarCredito(verificado.id, { habilitado: false })

    expect(sinCredito.creditoLimite).toBeNull()
  })

  it('un límite de cero no es un límite', async () => {
    const verificado = await clienteVerificado()

    await expect(
      configurarCredito(verificado.id, { habilitado: true, limite: 0 }),
    ).rejects.toMatchObject({ code: 'LIMITE_INVALIDO' })
  })
})

describe('un cliente no se borra — RN-CLI-02', () => {
  it('se desactiva y sale del listado', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await cambiarEstado(cliente.id, false)

    expect(await listarClientes()).toHaveLength(0)
    expect(await listarClientes(false)).toHaveLength(1)
  })

  it('el DELETE está revocado en la base', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await expect(db.delete(clientes).where(eq(clientes.id, cliente.id))).rejects.toThrow()
  })
})

describe('las direcciones son entidades — RN-CLI-07', () => {
  it('un cliente puede tener varias', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await agregarDireccion(cliente.id, { etiqueta: 'La casa', direccion: 'Calle 5 #3-20' })
    await agregarDireccion(cliente.id, { etiqueta: 'El negocio', direccion: 'Carrera 8 #1-11' })

    expect(await direccionesDe(cliente.id)).toHaveLength(2)
  })

  it('sin etiqueta o sin dirección, no entra', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await expect(
      agregarDireccion(cliente.id, { etiqueta: '', direccion: 'Calle 5' }),
    ).rejects.toMatchObject({ code: 'DIRECCION_INCOMPLETA' })
  })

  it('a un cliente que no existe, tampoco', async () => {
    await expect(
      agregarDireccion('00000000-0000-0000-0000-000000000000', {
        etiqueta: 'x',
        direccion: 'y',
      }),
    ).rejects.toBeInstanceOf(ErrorDeNegocio)
  })
})

describe('el tipo cambia, porque un cliente abre un negocio — RN-CLI-16', () => {
  it('de residencial a comercial', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    const { cliente: editado } = await editarCliente(cliente.id, { tipo: 'comercial' })

    expect(editado.tipo).toBe('comercial')
  })
})
