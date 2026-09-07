import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '@/app'
import { closeDb, db } from '@/db/client'
import { clientes } from '@/db/schema'
import { resetDb } from '@/test/db'
import { usuarioAutenticado } from '@/test/fixtures'

/**
 * Direcciones estructuradas y teléfonos — M14.
 *
 * Los dos huecos que apareció la primera demo con el cliente: la dirección era
 * un solo campo de texto, y no había ningún dato de contacto.
 */

let app: FastifyInstance
let admin: { cookie: string }
let clienteId: string

beforeEach(async () => {
  await resetDb()
  app = await buildApp()
  await app.ready()
  admin = await usuarioAutenticado('admin')

  const [c] = await db
    .insert(clientes)
    .values({
      nombre: 'Panadería del Centro',
      tipoDocumento: 'NIT',
      numeroDocumento: '900456789',
    })
    .returning()
  clienteId = c!.id
})

afterAll(async () => {
  await app?.close()
  await closeDb()
})

const como = (pedido: Omit<InjectOptions, 'headers'>) =>
  app.inject({ ...pedido, headers: { cookie: admin.cookie } })

const crearDireccion = (payload: Record<string, unknown>) =>
  como({ method: 'POST', url: `/clientes/${clienteId}/direcciones`, payload })

describe('una dirección con nomenclatura', () => {
  it('se guarda por partes y vuelve ya escrita', async () => {
    const res = await crearDireccion({
      etiqueta: 'el local',
      viaTipo: 'CL',
      viaNumero: '45',
      viaLetra: 'A',
      placaNumero: '12',
      placaSegundo: '34',
      municipio: 'Campo de la Cruz',
    })

    expect(res.statusCode).toBe(201)

    const ficha = await como({ method: 'GET', url: `/clientes/${clienteId}` })

    expect(ficha.json().direcciones[0].legible).toBe('CL 45 A # 12 - 34, Campo de la Cruz')
  })
})

/**
 * ── Ningún campo de ubicación es obligatorio ────────────────────────────────
 *
 * Aquazaku reparte en pueblos vecinos, y hay direcciones que son «Vereda La
 * Peña, casa de tabla azul». Exigir la estructura bloquearía el registro de un
 * cliente REAL, y el operador inventaría `CL 1 # 1-1` para poder guardar.
 */
describe('una dirección que no se descompone', () => {
  it('se guarda con la línea libre', async () => {
    const res = await crearDireccion({
      etiqueta: 'la casa',
      direccion: 'Vereda La Peña, casa de tabla azul',
      municipio: 'Suan',
    })

    expect(res.statusCode).toBe(201)
  })

  it('o solo con indicaciones', async () => {
    expect(
      (await crearDireccion({ etiqueta: 'la casa', indicaciones: 'al lado de la panadería' }))
        .statusCode,
    ).toBe(201)
  })

  it('o solo con el punto del mapa', async () => {
    const res = await crearDireccion({ etiqueta: 'la finca', latitud: 10.3769, longitud: -74.8825 })

    expect(res.statusCode).toBe(201)

    const ficha = await como({ method: 'GET', url: `/clientes/${clienteId}` })

    expect(ficha.json().direcciones[0].legible).toContain('10.37690')
  })
})

/**
 * ── Pero el conjunto tiene que ubicar ───────────────────────────────────────
 *
 * Si ningún campo es obligatorio por separado, nada impediría guardar una fila
 * en blanco: una dirección a la que no se le puede entregar nada, que ocupa
 * lugar en la lista y que alguien va a tratar de usar.
 */
describe('lo que se rechaza', () => {
  it('una dirección que no dice dónde queda', async () => {
    const res = await crearDireccion({ etiqueta: 'vacía' })

    expect(res.statusCode).toBe(422)
    expect(res.json().mensaje).toContain('no dice dónde queda')
  })

  it('campos con solo espacios cuentan como vacíos', async () => {
    const res = await crearDireccion({ etiqueta: 'vacía', municipio: '   ', direccion: '  ' })

    expect(res.statusCode).toBe(422)
  })

  it('sin etiqueta tampoco: es lo que el operador busca en una lista', async () => {
    const res = await crearDireccion({ etiqueta: '  ', municipio: 'Suan' })

    expect(res.statusCode).toBe(400)
  })

  it('media coordenada no ubica nada', async () => {
    const res = await crearDireccion({ etiqueta: 'la finca', latitud: 10.3769 })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('un pin fuera del planeta', async () => {
    const res = await crearDireccion({ etiqueta: 'x', latitud: 999, longitud: -74.8 })

    expect(res.statusCode).toBe(400)
  })
})

/**
 * ── Minúscula atrás, ortografía del DANE adelante ───────────────────────────
 *
 * Dos filas que dicen lo mismo tienen que ser iguales en la base, y buscar
 * «suan» tiene que encontrar «Suan». Pero «Campo de la Cruz» no se reconstruye
 * desde `campo de la cruz` con una regla: las preposiciones en minúscula
 * dependen de cuál palabra es. Por eso hay catálogo.
 */
describe('el municipio y el departamento', () => {
  it('se guardan en minúscula, se muestran bien escritos', async () => {
    await crearDireccion({
      etiqueta: 'la casa',
      direccion: 'la esquina',
      municipio: 'CAMPO DE LA CRUZ',
      departamento: 'atlantico',
    })

    const [d] = (await como({ method: 'GET', url: `/clientes/${clienteId}` })).json().direcciones

    expect(d.municipio).toBe('campo de la cruz')
    expect(d.departamento).toBe('atlantico')
    expect(d.legible).toBe('la esquina, Campo de la Cruz, Atlántico')
  })

  it('escrito sin tildes, se muestra con ellas', async () => {
    await crearDireccion({ etiqueta: 'x', direccion: 'y', municipio: 'santa lucia' })

    const [d] = (await como({ method: 'GET', url: `/clientes/${clienteId}` })).json().direcciones

    expect(d.legible).toContain('Santa Lucía')
  })

  /*
   * El DANE lista municipios, no veredas — y Aquazaku reparte en algunas. No
   * puede rechazarse lo que no está en el catálogo.
   */
  it('una vereda que el DANE no lista se acepta igual', async () => {
    const res = await crearDireccion({
      etiqueta: 'la finca',
      direccion: 'casa de tabla azul',
      municipio: 'vereda la peña',
    })

    expect(res.statusCode).toBe(201)
  })
})

describe('el catálogo geográfico', () => {
  it('lista los 33 departamentos', async () => {
    const res = await como({ method: 'GET', url: '/geografia/departamentos' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(33)
  })

  it('los municipios se filtran por departamento: son 1122 en total', async () => {
    const todos = (await como({ method: 'GET', url: '/geografia/municipios' })).json()
    const atlantico = (
      await como({ method: 'GET', url: '/geografia/municipios?departamento=08' })
    ).json()

    expect(todos).toHaveLength(1122)
    expect(atlantico).toHaveLength(23)
    expect(atlantico.map((m: { nombre: string }) => m.nombre)).toContain('Campo de la Cruz')
  })

  /*
   * Las coordenadas del DANE sirven para centrar el mapa en el municipio
   * elegido, que es mejor punto de partida que centrarlo en el país.
   */
  it('cada municipio trae sus coordenadas', async () => {
    const [m] = (
      await como({ method: 'GET', url: '/geografia/municipios?departamento=08' })
    ).json().filter((x: { codigo: string }) => x.codigo === '08137')

    expect(m.lat).toBeCloseTo(10.378, 2)
    expect(m.lng).toBeCloseTo(-74.881, 2)
  })

  /*
   * Es la división política de Colombia, publicada por el DANE. Exigir un
   * permiso para leerla sería tratar como secreto algo que está en
   * datos.gov.co — pero sin sesión no entra nadie.
   */
  it('sin sesión no se lee', async () => {
    expect((await app.inject({ method: 'GET', url: '/geografia/departamentos' })).statusCode).toBe(
      401,
    )
  })
})

describe('los teléfonos', () => {
  const crearTelefono = (payload: Record<string, unknown>) =>
    como({ method: 'POST', url: `/clientes/${clienteId}/telefonos`, payload })

  it('viajan con la ficha del cliente, no en otra petición', async () => {
    await crearTelefono({ numero: '3001234567', etiqueta: 'celular del dueño' })

    const ficha = await como({ method: 'GET', url: `/clientes/${clienteId}` })

    expect(ficha.json().telefonos).toHaveLength(1)
    expect(ficha.json().telefonos[0].etiqueta).toBe('celular del dueño')
  })

  it('un cliente puede tener varios', async () => {
    await crearTelefono({ numero: '3001234567', etiqueta: 'el dueño' })
    await crearTelefono({ numero: '6058791234', etiqueta: 'el local' })

    expect((await como({ method: 'GET', url: `/clientes/${clienteId}` })).json().telefonos).toHaveLength(2)
  })

  /*
   * Dos veces el mismo número se lee como dos contactos, y alguien va a llamar
   * dos veces al mismo lugar.
   */
  it('el mismo número dos veces se rechaza', async () => {
    await crearTelefono({ numero: '3001234567' })

    const res = await crearTelefono({ numero: '3001234567' })

    expect(res.statusCode).toBe(409)
    expect(res.json().mensaje).toContain('ya tiene el')
  })

  /*
   * «300 123 4567», «(605) 8791234» y «3001234567» son el mismo número escrito
   * como lo escribe la gente. Rechazar por prolijidad haría que el operador no
   * lo cargue — y ese es el dato que hace falta para cobrar.
   */
  it('acepta el formato que la gente escribe', async () => {
    expect((await crearTelefono({ numero: '300 123 4567' })).statusCode).toBe(201)
    expect((await crearTelefono({ numero: '(605) 879 1234' })).statusCode).toBe(201)
  })

  it('pero no algo que no puede ser un teléfono', async () => {
    expect((await crearTelefono({ numero: '123' })).statusCode).toBe(400)
  })

  it('se desactiva, no se borra: el historial de llamadas lo necesita', async () => {
    const creado = (await crearTelefono({ numero: '3001234567' })).json()

    await como({ method: 'PATCH', url: `/telefonos/${creado.id}/desactivar` })

    expect((await como({ method: 'GET', url: `/clientes/${clienteId}` })).json().telefonos).toHaveLength(0)
  })
})

/**
 * ── Editar reemplaza la dirección entera ────────────────────────────────────
 *
 * El formulario manda todo lo que tiene, y lo que el operador borró llega
 * ausente. Con un merge parcial, vaciar un campo sería imposible: mandar
 * «municipio: nada» se leería como «no lo toques», y el dato viejo quedaría
 * para siempre.
 */
describe('editar una dirección', () => {
  const crearYObtener = async (payload: Record<string, unknown>) => {
    await crearDireccion(payload)
    const [d] = (await como({ method: 'GET', url: `/clientes/${clienteId}` })).json().direcciones
    return d
  }

  it('cambia lo que se manda', async () => {
    const d = await crearYObtener({ etiqueta: 'la casa', direccion: 'la casa azul', municipio: 'suan' })

    const res = await como({
      method: 'PATCH',
      url: `/direcciones/${d.id}`,
      payload: { etiqueta: 'el local', direccion: 'la esquina', municipio: 'campo de la cruz' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().legible).toBe('la esquina, Campo de la Cruz')
    expect(res.json().etiqueta).toBe('el local')
  })

  it('un campo que se borró queda borrado, no con el valor viejo', async () => {
    const d = await crearYObtener({
      etiqueta: 'la casa',
      direccion: 'la casa azul',
      municipio: 'suan',
      indicaciones: 'al lado del parque',
    })

    const res = await como({
      method: 'PATCH',
      url: `/direcciones/${d.id}`,
      payload: { etiqueta: 'la casa', direccion: 'la casa azul', municipio: 'suan' },
    })

    expect(res.json().indicaciones).toBeNull()
  })

  /*
   * Una edición puede dejar la dirección sin nada que la ubique, igual que un
   * alta. Las reglas se comparten para que la edición no acepte lo que el alta
   * rechaza.
   */
  it('no puede dejarla sin nada que la ubique', async () => {
    const d = await crearYObtener({ etiqueta: 'la casa', direccion: 'la casa azul', municipio: 'suan' })

    const res = await como({
      method: 'PATCH',
      url: `/direcciones/${d.id}`,
      payload: { etiqueta: 'la casa', municipio: 'suan' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().mensaje).toContain('no dice dónde queda')
  })

  it('una que no existe responde 404', async () => {
    const res = await como({
      method: 'PATCH',
      url: '/direcciones/00000000-0000-0000-0000-000000000000',
      payload: { etiqueta: 'x', direccion: 'y' },
    })

    expect(res.statusCode).toBe(404)
  })
})

/**
 * ── El servicio y la base tienen que decir lo mismo ─────────────────────────
 *
 * `direcciones_ubicable` (migración 0014) lista qué campos ubican, y el
 * servicio repite esa lista para poder explicar el rechazo con un mensaje que
 * se lea.
 *
 * Cuando se separaron, el servicio aceptaba una dirección con solo municipio y
 * la base la rechazaba: el operador veía un error de constraint sin
 * explicación. Este test las mantiene atadas.
 */
describe('qué cuenta como «ubica»', () => {
  const soloCon = (campo: string, valor: unknown) =>
    crearDireccion({ etiqueta: 'x', [campo]: valor })

  it.each([
    ['viaTipo', 'CL'],
    ['viaNumero', '45'],
    ['placaNumero', '12'],
    ['direccion', 'la casa azul'],
    ['indicaciones', 'al lado del parque'],
  ])('%s alcanza', async (campo, valor) => {
    expect((await soloCon(campo, valor)).statusCode).toBe(201)
  })

  /*
   * A «Suan» no se le puede entregar agua, y un departamento menos todavía. Un
   * campo lleno no es lo mismo que una dirección.
   */
  it.each([
    ['municipio', 'suan'],
    ['departamento', 'atlántico'],
    ['complemento', 'Apto 302'],
    ['viaLetra', 'A'],
  ])('%s NO alcanza solo', async (campo, valor) => {
    expect((await soloCon(campo, valor)).statusCode).toBe(422)
  })
})
