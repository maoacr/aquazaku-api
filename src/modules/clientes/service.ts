import { type SQL, and, desc, eq, like, ne, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '@/db/client'
import { type Cliente, type Direccion, type Telefono, clientes, telefonos } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { type DatosDeDireccion, agregarDireccion } from './direcciones'
import {
  DocumentoInvalido,
  type TipoDeDocumento,
  normalizarDocumento,
} from './documento'

/**
 * Alta, edición y baja de clientes — RN-CLI-01, 02, 13 y 16.
 *
 * El acceso lo decide `api/` con `requirePermission`; acá solo viven las reglas
 * de negocio.
 */

/**
 * Cómo se nombra a un cliente — RN-CLI-17.
 *
 * ── Dos caminos, y solo uno por cliente ─────────────────────────────────────
 *
 * Una **persona** se nombra por partes: primer nombre, segundo (que falta
 * seguido), y apellidos. Un **negocio** no: «Panadería del Centro» no tiene
 * nombre de pila, y pedirle apellidos sería inventar un dato.
 *
 * Los dos caminos desembocan en la misma columna `nombre`, que **la genera la
 * base**. Este código nunca la escribe: si la compusiera acá, un `UPDATE` a
 * mano podría dejarla discrepando de sus partes.
 *
 * El apodo va aparte y no entra en el nombre. Es cómo se la conoce, no cómo se
 * llama — y en Campo de la Cruz es lo primero que se dice en el mostrador.
 */
export interface NombreDeCliente {
  /** El de un negocio, o el de alguien cargado sin partir. */
  nombreLibre?: string
  primerNombre?: string
  segundoNombre?: string
  apellidos?: string
  apodo?: string
}

export interface DatosDeAlta extends NombreDeCliente {
  tipo?: 'residencial' | 'comercial'
  tipoDocumento: TipoDeDocumento
  /** Como lo dictaron: con puntos, con guion o pelado. Se normaliza acá. */
  numeroDocumento: string
  /**
   * Un teléfono, capturado en el mismo momento del alta.
   *
   * ── Por qué acá y no solo en `POST /clientes/:id/telefonos` ───────────────
   *
   * Ese endpoint pide `clientes:editar`, y el `pos` **no lo tiene**: puede
   * crear clientes, no modificarlos. Pero es justo quien registra a alguien que
   * se lleva un botellón sin devolver el vacío (RN-ENV-09), y sin teléfono ese
   * registro no sirve para lo único que existe: poder reclamarlo.
   *
   * Aceptarlo en el alta lo cubre `clientes:crear`, que el `pos` sí tiene, y no
   * le da ningún poder nuevo sobre los clientes que ya existen. Cambiar o
   * quitar teléfonos sigue siendo `editar`.
   */
  telefono?: { numero: string; etiqueta?: string }

  /**
   * Varios teléfonos, capturados en el mismo alta.
   *
   * ── Por qué no alcanza con uno ───────────────────────────────────────────
   *
   * Un comercial tiene el celular del dueño y el fijo del local, y son dos
   * cosas distintas: al primero se le escribe por WhatsApp, al segundo solo se
   * le llama. El panel «Para llamar» ya está construido sobre esa diferencia.
   *
   * Y agregarle el segundo después exige `clientes:editar`, que el `pos` no
   * tiene: quien atiende el mostrador capturaría uno y perdería el otro.
   *
   * Convive con `telefono` en singular, que no se toca: lo usan la colección de
   * Bruno y el alta anterior. Romper un contrato con consumidores para agregar
   * una forma nueva sería cobrarle el cambio a quien no lo pidió.
   */
  telefonos?: { numero: string; etiqueta?: string }[]

  /**
   * Una dirección, capturada en el mismo momento del alta.
   *
   * ── El mismo argumento que el teléfono, y más fuerte ──────────────────────
   *
   * `POST /clientes/:id/direcciones` pide `clientes:editar`, que el `pos` no
   * tiene. Pero RN-BAS-07 le da autonomía para prestarle una base a un cliente
   * verificado, y RN-BAS-03 dice que **una base se presta a una DIRECCIÓN**.
   *
   * Sin esto, el `pos` puede prestar una base y no puede crear la dirección a la
   * que se presta: el activo sale de la planta y no queda dónde ir a buscarlo,
   * que es exactamente lo que RN-BAS-03 existe para evitar.
   *
   * Aceptarla en el alta la cubre `clientes:crear`, y no le da ningún poder
   * nuevo sobre los clientes que ya existen. Editar o desactivar direcciones
   * sigue siendo `editar`.
   */
  direccion?: DatosDeDireccion
}

/**
 * El cruce entre CC y NIT — la mitigación de RN-CLI-08.
 *
 * No es un error: el mismo número puede existir como CC y como NIT porque el
 * NIT de una persona natural se basa en su cédula. Pero también puede ser un
 * duplicado entrando por la puerta de atrás.
 *
 * La base no puede distinguir los dos casos, y adivinarlo sería peor que
 * preguntar. Así que el sistema **advierte y sigue**: quien registra tiene el
 * dato de qué cliente ya existe con ese número y decide.
 */
export interface AvisoDeCruce {
  /** El cliente que ya tiene ese número, con el OTRO tipo de documento. */
  clienteExistente: { id: string; nombre: string; tipoDocumento: TipoDeDocumento }
  mensaje: string
}

/**
 * Lo que devuelve una edición.
 *
 * ── Por qué no es el mismo tipo que el alta ─────────────────────────────────
 *
 * Compartían forma por casualidad, no por parecido: editar no crea teléfonos.
 * Con un tipo solo, el `telefono` tendría que ser opcional — y entonces el
 * compilador dejaría pasar un alta que se olvide de devolverlo, que es
 * justamente lo que atajó cuando eran dos.
 */
export interface ResultadoDeEdicion {
  cliente: Cliente
  /** `null` cuando no hay nada que confirmar. */
  aviso: AvisoDeCruce | null
}

export interface ResultadoDeAlta extends ResultadoDeEdicion {
  /**
   * El primero de los que vinieron, o `null`.
   *
   * Se conserva por los consumidores que ya lo leen —la colección de Bruno y el
   * alta anterior—. Lo completo está en `telefonos`.
   */
  telefono: Telefono | null
  /** Todos los que vinieron, en el orden en que se cargaron. */
  telefonos: Telefono[]
  /** La que vino en el alta, si vino. */
  direccion: Direccion | null
}

const OTRO_TIPO: Record<TipoDeDocumento, TipoDeDocumento> = { CC: 'NIT', NIT: 'CC' }

/** Traduce el fallo de normalización a un error de negocio con su mensaje. */
function exigirDocumento(crudo: string): string {
  try {
    return normalizarDocumento(crudo)
  } catch (err) {
    if (err instanceof DocumentoInvalido) {
      // RN-CLI-13: el documento se exige al registrar, sin excepciones. Lo que
      // puede esperar es la VERIFICACIÓN, no el dato.
      throw new ErrorDeNegocio('DOCUMENTO_INVALIDO', 422, err.motivo)
    }
    throw err
  }
}

/** Busca el mismo número cargado con el otro tipo de documento. */
async function buscarCruce(
  tipo: TipoDeDocumento,
  numero: string,
  excepto?: string,
): Promise<AvisoDeCruce | null> {
  const condiciones = [
    eq(clientes.tipoDocumento, OTRO_TIPO[tipo]),
    eq(clientes.numeroDocumento, numero),
  ]
  if (excepto) condiciones.push(ne(clientes.id, excepto))

  const [existente] = await db.select().from(clientes).where(and(...condiciones))
  if (!existente) return null

  return {
    clienteExistente: {
      id: existente.id,
      nombre: existente.nombre,
      tipoDocumento: existente.tipoDocumento,
    },
    mensaje: `${existente.nombre} ya está registrado con el mismo número como ${existente.tipoDocumento}. Si es la misma persona, use ese registro en vez de crear otro: dos fichas parten su deuda y sus botellones en dos, y ninguna de las dos es real.`,
  }
}

/** Vacío o solo espacios es lo mismo que no haberlo mandado. */
function limpio(valor: string | undefined): string | undefined {
  const podado = valor?.trim()
  return podado ? podado : undefined
}

/**
 * Traduce los invariantes del nombre a mensajes que digan qué hacer.
 *
 * ── Por qué existe si la base ya los tiene ──────────────────────────────────
 *
 * Los cuatro CHECK de `clientes` garantizan que ninguna fila mala entre, y esa
 * es la barrera real. Pero sus errores crudos —«null value in column nombre»,
 * «violates check constraint clientes_nombre_partido_completo»— no le sirven a
 * quien está llenando un formulario.
 *
 * ADR-0006: el invariante vive en la base, el servicio explica. Lo que este
 * código **no** puede hacer es aceptar algo que la base rechace: si divergen,
 * la pantalla muestra un 500 en vez de un mensaje. Hay un test que los cruza.
 */
export function exigirNombreCoherente(n: NombreDeCliente): NombreDeCliente {
  const partes = {
    nombreLibre: limpio(n.nombreLibre),
    primerNombre: limpio(n.primerNombre),
    segundoNombre: limpio(n.segundoNombre),
    apellidos: limpio(n.apellidos),
    apodo: limpio(n.apodo),
  }

  if (partes.primerNombre && partes.nombreLibre) {
    throw new ErrorDeNegocio(
      'NOMBRE_AMBIGUO',
      422,
      'llegaron las dos formas de nombrar al cliente: el nombre partido y el nombre libre. Use una sola — las partes para una persona, el nombre libre para un negocio',
    )
  }

  if (Boolean(partes.primerNombre) !== Boolean(partes.apellidos)) {
    throw new ErrorDeNegocio(
      'NOMBRE_PARTIDO_INCOMPLETO',
      422,
      'un nombre de pila sin apellidos no identifica a nadie, y un apellido suelto tampoco. Van los dos, o ninguno y el nombre del negocio en su lugar',
    )
  }

  if (!partes.primerNombre && !partes.nombreLibre) {
    throw new ErrorDeNegocio(
      'NOMBRE_REQUERIDO',
      422,
      'el cliente necesita un nombre: primer nombre y apellidos si es una persona, o el nombre del negocio',
    )
  }

  if (partes.segundoNombre && !partes.primerNombre) {
    throw new ErrorDeNegocio(
      'SEGUNDO_NOMBRE_SIN_PRIMERO',
      422,
      'llegó un segundo nombre sin el primero',
    )
  }

  return partes
}

export async function crearCliente(datos: DatosDeAlta): Promise<ResultadoDeAlta> {
  const nombre = exigirNombreCoherente(datos)

  const numeroDocumento = exigirDocumento(datos.numeroDocumento)
  const aviso = await buscarCruce(datos.tipoDocumento, numeroDocumento)

  /*
   * Cliente y teléfono en la MISMA transacción.
   *
   * Con dos escrituras sueltas, un fallo en la segunda deja un cliente sin
   * número — y ese es exactamente el registro que no sirve para nada: se
   * registró a alguien para poder reclamarle un botellón, y no quedó a qué
   * llamar. O entran los dos o no entra ninguno.
   */
  return db.transaction(async (tx) => {
    const [cliente] = await tx
      .insert(clientes)
      .values({
        ...nombre,
        tipo: datos.tipo ?? 'residencial',
        tipoDocumento: datos.tipoDocumento,
        numeroDocumento,
      })
      .returning()

    /*
     * No se chequea el número repetido como en `agregarTelefono`: un cliente
     * que acaba de nacer no tiene ninguno con el cual repetirse.
     */
    /*
     * El singular y el plural se juntan acá, en ese orden. Quien mande los dos
     * —nadie hoy, pero el tipo lo permite— obtiene los dos, sin que uno pise al
     * otro en silencio.
     */
    const pedidos = [...(datos.telefono ? [datos.telefono] : []), ...(datos.telefonos ?? [])]

    const guardados = pedidos.length
      ? await tx
          .insert(telefonos)
          .values(
            pedidos.map((t) => ({
              clienteId: cliente!.id,
              numero: t.numero.trim(),
              ...(t.etiqueta?.trim() && { etiqueta: t.etiqueta.trim() }),
            })),
          )
          .returning()
      : []

    /*
     * La dirección reusa `agregarDireccion` en vez de insertar a mano, y no es
     * comodidad: ahí viven la normalización y la invariante de que el conjunto
     * UBIQUE. Escribiendo el INSERT acá, una dirección que el alta aceptara y el
     * endpoint rechazara sería el mismo dato válido por una puerta e inválido
     * por la otra.
     *
     * Va dentro de la transacción: si la dirección no pasa, el cliente tampoco
     * entra. Un cliente a medio cargar es peor que ninguno — quien atiende cree
     * que quedó registrado y no sabe qué le falta.
     */
    const direccion = datos.direccion
      ? await agregarDireccion(cliente!.id, datos.direccion, tx)
      : null

    return { cliente: cliente!, aviso, telefono: guardados[0] ?? null, telefonos: guardados, direccion }
  })
}

export interface DatosDeEdicion extends NombreDeCliente {
  /** RN-CLI-16: un cliente pasa de residencial a comercial cuando abre un negocio. */
  tipo?: 'residencial' | 'comercial'
  tipoDocumento?: TipoDeDocumento
  numeroDocumento?: string
}

/**
 * ¿Este pedido está cambiando el nombre?
 *
 * Se mira la PRESENCIA de las claves, no su valor: mandar `apodo: undefined`
 * para borrar el apodo es un cambio de nombre tanto como mandar uno nuevo.
 */
function tocaElNombre(datos: DatosDeEdicion): boolean {
  const campos = ['nombreLibre', 'primerNombre', 'segundoNombre', 'apellidos', 'apodo'] as const
  return campos.some((campo) => campo in datos)
}

export async function editarCliente(
  id: string,
  datos: DatosDeEdicion,
): Promise<ResultadoDeEdicion> {
  const actual = await clientePorId(id)

  const tipoDocumento = datos.tipoDocumento ?? actual.tipoDocumento
  const numeroDocumento =
    datos.numeroDocumento === undefined
      ? actual.numeroDocumento
      : exigirDocumento(datos.numeroDocumento)

  const cambioElDocumento =
    tipoDocumento !== actual.tipoDocumento || numeroDocumento !== actual.numeroDocumento

  const aviso = cambioElDocumento ? await buscarCruce(tipoDocumento, numeroDocumento, id) : null

  /*
   * El nombre se reemplaza ENTERO o no se toca.
   *
   * Un cambio parcial no se puede interpretar: si llega solo `apellidos`, ¿el
   * primer nombre se conserva, o el cliente pasó a llamarse solo por apellido?
   * Y peor: mandar `primerNombre` sobre un negocio dejaría el nombre partido y
   * la razón social a la vez, que es justo lo que
   * `clientes_una_sola_forma_de_nombre` prohíbe.
   *
   * Reemplazar entero es la única lectura sin ambigüedad — y como los campos
   * ausentes viajan en `null`, borrar un segundo nombre o un apodo funciona
   * omitiéndolo, sin un verbo aparte para «borrar».
   */
  const nombre = tocaElNombre(datos)
    ? exigirNombreCoherente(datos)
    : undefined

  const [cliente] = await db
    .update(clientes)
    .set({
      ...(nombre && {
        nombreLibre: nombre.nombreLibre ?? null,
        primerNombre: nombre.primerNombre ?? null,
        segundoNombre: nombre.segundoNombre ?? null,
        apellidos: nombre.apellidos ?? null,
        apodo: nombre.apodo ?? null,
      }),
      ...(datos.tipo !== undefined && { tipo: datos.tipo }),
      tipoDocumento,
      numeroDocumento,
      updatedAt: new Date(),
    })
    .where(eq(clientes.id, id))
    .returning()

  return { cliente: cliente!, aviso }
}

/**
 * Baja = desactivar — RN-CLI-02.
 *
 * No existe borrar, y `DELETE` está revocado en la base: un cliente con
 * historial que desaparece deja ventas y botellones apuntando a nadie, y la
 * deuda sin dueño.
 */
export async function cambiarEstado(id: string, activo: boolean): Promise<Cliente> {
  await clientePorId(id)

  const [cliente] = await db
    .update(clientes)
    .set({ activo, updatedAt: new Date() })
    .where(eq(clientes.id, id))
    .returning()

  return cliente!
}

export async function clientePorId(id: string): Promise<Cliente> {
  const [cliente] = await db.select().from(clientes).where(eq(clientes.id, id))

  if (!cliente) {
    throw new ErrorDeNegocio('CLIENTE_NO_ENCONTRADO', 404, 'ese cliente no existe')
  }
  return cliente
}

/**
 * Buscar por documento — el número es la llave del mostrador.
 *
 * ── Por qué por documento y no por nombre ───────────────────────────────────
 *
 * En el mostrador el cliente dice su cédula, no deletrea su apellido. Y dos
 * «María González» son dos personas; dos cédulas iguales, una sola.
 *
 * Reemplaza al `<select>` que cargaba todos los clientes: con quinientos, ese
 * desplegable deja de servir aunque el sistema funcione perfecto — nadie
 * encuentra a alguien en una lista de quinientos.
 *
 * ── Empieza-con, no contiene ────────────────────────────────────────────────
 *
 * Una cédula se dicta de izquierda a derecha. Buscar «contiene» traería
 * coincidencias por el medio del número, que no son las que alguien tipeando
 * espera — y además impide usar un índice.
 *
 * ── El tope no es paginación ────────────────────────────────────────────────
 *
 * Si un prefijo corto trae muchos, la respuesta correcta no es una lista larga:
 * es «seguí escribiendo». Ocho alcanzan para elegir; más es una lista donde hay
 * que buscar otra vez.
 */
export const MAXIMO_COINCIDENCIAS = 8

export async function buscarPorDocumento(
  prefijo: string,
  soloActivos = true,
): Promise<Cliente[]> {
  const limpio = prefijo.replace(/[^0-9A-Za-z]/g, '')

  /*
   * Menos de tres caracteres no busca. Con uno o dos, la respuesta serían casi
   * todos los clientes: ruido que además cuesta una consulta a la base en cada
   * tecla.
   */
  if (limpio.length < 3) return []

  const condiciones = [like(clientes.numeroDocumento, `${limpio}%`)]
  if (soloActivos) condiciones.push(eq(clientes.activo, true))

  return db
    .select()
    .from(clientes)
    .where(and(...condiciones))
    .orderBy(clientes.numeroDocumento)
    .limit(MAXIMO_COINCIDENCIAS)
}

/**
 * Buscar por cómo se conoce a alguien — M16.
 *
 * ── El bug que esto vino a matar ────────────────────────────────────────────
 *
 * El filtro vivía en el navegador y hacía `toLowerCase()` sin tocar las tildes.
 * Medido sobre datos reales: «gomez» NO encontraba a «Rosa Elena Padilla
 * Gómez», y «panaderia» NO encontraba a «Panadería del Centro». En Colombia eso
 * es la mitad de los apellidos, y nadie los teclea con tilde.
 *
 * ── CONTIENE, al revés que el documento ─────────────────────────────────────
 *
 * `buscarPorDocumento` usa empieza-con porque una cédula se dicta de izquierda a
 * derecha. Un apellido no: se recuerda suelto —«el Gómez ese»— y quien busca no
 * sabe si va primero o segundo. Por eso acá va `%termino%`.
 *
 * El costo de eso es que **no usa índice**: ni el `contains` ni el `translate`
 * pueden aprovechar `clientes_apellidos_idx`. Con miles de clientes es un scan
 * de miles de filas cortas, que Postgres resuelve en milisegundos. Si algún día
 * deja de alcanzar, el arreglo es la extensión `unaccent` más un índice sobre
 * ella — y eso sí es una migración.
 */
const MAXIMO_BUSQUEDA = 12

/** Las vocales acentuadas y la eñe, que es lo que aparece en un nombre acá. */
const CON_TILDE = 'áéíóúüñÁÉÍÓÚÜÑ'
const SIN_TILDE = 'aeiouunAEIOUUN'

/** `lower()` más `translate()`: el mismo texto visto sin acentos ni mayúsculas. */
function sinAcentos(columna: SQL | AnyPgColumn): SQL<string> {
  return sql<string>`translate(lower(coalesce(${columna}, '')), ${CON_TILDE}, ${SIN_TILDE})`
}

export async function buscarClientes(termino: string, soloActivos = true): Promise<Cliente[]> {
  const limpio = termino.trim()

  /*
   * Mismo criterio que la búsqueda por documento: con uno o dos caracteres la
   * respuesta serían casi todos los clientes — ruido, y una consulta a la base
   * en cada tecla.
   */
  if (limpio.length < 3) return []

  const patron = `%${limpio.toLowerCase().replace(/[áéíóúüñ]/g, (c) => SIN_TILDE[CON_TILDE.indexOf(c)]!)}%`

  /*
   * El documento entra en la búsqueda SOLO si el término tiene dígitos.
   *
   * Sin esta guarda, buscar «gomez» deja el patrón del documento en `%%` —que
   * matchea todas las filas— y el `or` devuelve el padrón entero. Lo encontró
   * el test: pedía un resultado y llegaban dos.
   */
  const digitos = limpio.replace(/\D/g, '')

  const coincide = or(
    // `nombre` es la columna GENERATED: ya trae las partes compuestas.
    like(sinAcentos(clientes.nombre), patron),
    like(sinAcentos(clientes.apellidos), patron),
    // El apodo es como se la conoce en el pueblo — RN-CLI-17.
    like(sinAcentos(clientes.apodo), patron),
    ...(digitos.length >= 3 ? [like(clientes.numeroDocumento, `%${digitos}%`)] : []),
  )

  const condiciones = soloActivos ? and(coincide, eq(clientes.activo, true)) : coincide

  return db.select().from(clientes).where(condiciones).orderBy(clientes.nombre).limit(MAXIMO_BUSQUEDA)
}

/**
 * Los últimos registrados — M16.
 *
 * Para que la pantalla de clientes no arranque en blanco. Una pantalla vacía se
 * siente rota, y además esconde el caso más común después de dar de alta a
 * alguien: volver a mirarlo para corregir un dedazo.
 *
 * Ordena por **creación**, no por nombre. La pregunta que contesta es «qué pasó
 * recién», y esa es la única que se puede contestar sin que nadie busque.
 */
export async function clientesRecientes(cuantos: number, soloActivos = true): Promise<Cliente[]> {
  const consulta = db.select().from(clientes).orderBy(desc(clientes.createdAt)).limit(cuantos)

  return soloActivos ? consulta.where(eq(clientes.activo, true)) : consulta
}

export async function listarClientes(soloActivos = true): Promise<Cliente[]> {
  const consulta = db.select().from(clientes)

  return soloActivos
    ? consulta.where(eq(clientes.activo, true)).orderBy(clientes.nombre)
    : consulta.orderBy(clientes.nombre)
}
