import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/db/client'
import { auditLog, clientes } from '@/db/schema'
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

const UNA_CEDULA = {
  primerNombre: 'Yeimy',
  apellidos: 'Rodríguez',
  tipoDocumento: 'CC' as const,
  numeroDocumento: '79123456',
}

/** Lo que la ruta le pasa al servicio para que escriba la bitácora. */
const unContexto = (userId: string | null = null) => ({
  userId,
  rolEjercido: ['admin'] as const,
  requestId: 'req-de-prueba',
})

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
    await expect(
      crearCliente({ ...UNA_CEDULA, primerNombre: '   ', apellidos: '   ' }),
    ).rejects.toMatchObject({
      code: 'NOMBRE_REQUERIDO',
    })
  })
})

describe('el mismo número con los dos tipos — RN-CLI-08', () => {
  it('el duplicado REAL no entra: mismo tipo y mismo número', async () => {
    await crearCliente(UNA_CEDULA)

    await expect(crearCliente({ ...UNA_CEDULA, primerNombre: 'Otro' })).rejects.toThrow()
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
      nombreLibre: 'Yeimy Rodríguez SAS',
      primerNombre: undefined,
      apellidos: undefined,
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
      crearCliente({ ...UNA_CEDULA, primerNombre: 'Otro', numeroDocumento: '079123456' }),
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

    await expect(configurarCredito(cliente.id, { habilitado: true }, unContexto())).rejects.toMatchObject({
      code: 'VERIFICACION_REQUERIDA',
    })
  })

  it('verificado sí, y sin tope por defecto', async () => {
    const verificado = await clienteVerificado()

    const conCredito = await configurarCredito(verificado.id, { habilitado: true }, unContexto())

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
    await configurarCredito(verificado.id, { habilitado: true }, unContexto())

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
    await configurarCredito(verificado.id, { habilitado: true, limite: 500000 }, unContexto())

    const sinCredito = await configurarCredito(verificado.id, { habilitado: false }, unContexto())

    expect(sinCredito.creditoLimite).toBeNull()
  })

  it('un límite de cero no es un límite', async () => {
    const verificado = await clienteVerificado()

    await expect(
      configurarCredito(verificado.id, { habilitado: true, limite: 0 }, unContexto()),
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

  /**
   * ── Qué es obligatorio, después de M14 ────────────────────────────────────
   *
   * Antes lo eran la etiqueta Y la línea de dirección. Ahora la ubicación se
   * puede dar de cuatro formas —nomenclatura, línea libre, indicaciones o el
   * pin del mapa— porque Aquazaku reparte en pueblos donde hay direcciones que
   * no se dejan descomponer.
   *
   * Lo que no cambió: **la etiqueta**. Es lo que el operador busca en una lista
   * cuando tiene que elegir a cuál de los tres locales va.
   */
  it('sin etiqueta no entra: es lo que se busca en la lista', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await expect(
      agregarDireccion(cliente.id, { etiqueta: '', direccion: 'Calle 5' }),
    ).rejects.toMatchObject({ code: 'DIRECCION_SIN_ETIQUETA' })
  })

  /*
   * Si ningún campo de ubicación es obligatorio por separado, nada impediría
   * guardar una fila en blanco: una dirección a la que no se le puede entregar
   * nada, que ocupa lugar en la lista y que alguien va a tratar de usar.
   */
  it('con etiqueta pero sin nada que ubique, tampoco', async () => {
    const { cliente } = await crearCliente(UNA_CEDULA)

    await expect(agregarDireccion(cliente.id, { etiqueta: 'la casa' })).rejects.toMatchObject({
      code: 'DIRECCION_NO_UBICABLE',
    })
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

/**
 * El crédito y su fila en la bitácora son una sola escritura — ADR-0007.
 *
 * Habilitar crédito es una de las acciones que la ADR nombra sensibles: sin
 * bitácora, **no se ejecuta**. Eso no se cumple emitiendo después del `UPDATE`,
 * porque si el `INSERT` falla ahí el crédito ya quedó habilitado y lo único que
 * se puede devolver es un 500 — el cliente tendría crédito y nadie sabría quién
 * se lo dio.
 *
 * El tope es justamente la pregunta que esta bitácora contesta: una deuda que
 * creció sin control no se puede explicar si no se sabe quién subió el límite.
 */
describe('la bitácora del crédito vive en la transacción del cambio — ADR-0007', () => {
  /*
   * El modo de falla es artificial —un `user_id` que no es un UUID hace que
   * Postgres rechace el INSERT— pero el mecanismo que se prueba es el real: no
   * hay mock de `emit`. La bitácora falla de verdad, en la base, y lo que se
   * afirma es que el rollback se llevó el crédito con ella.
   */
  it('si la bitácora falla, el crédito NO queda habilitado', async () => {
    const verificado = await clienteVerificado()

    await expect(
      configurarCredito(
        verificado.id,
        { habilitado: true, limite: 500000 },
        { ...unContexto(), userId: 'no-soy-un-uuid' },
      ),
    ).rejects.toThrow()

    const [despues] = await db.select().from(clientes).where(eq(clientes.id, verificado.id))

    expect(despues!.creditoHabilitado).toBe(false)
    expect(despues!.creditoLimite).toBeNull()
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })

  it('cuando sale bien, el cambio y la fila quedan juntos', async () => {
    const verificado = await clienteVerificado()
    const admin = await usuarioAutenticado('admin')

    const conCredito = await configurarCredito(
      verificado.id,
      { habilitado: true, limite: 500000 },
      unContexto(admin.usuario.id),
    )

    expect(conCredito.creditoHabilitado).toBe(true)

    const filas = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'clientes:habilitar_credito'))

    expect(filas).toHaveLength(1)
    expect(filas[0]!.payload).toMatchObject({
      resourceId: verificado.id,
      habilitado: true,
      limite: '500000.00',
    })
  })
})
