import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Producto, productos } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { emit } from '@/modules/authz/audit'
import { saldoTotalDe } from '@/modules/stock/consultas'
import { type DatosDeCodigo, generarCodigo } from './codigo'

/**
 * Catálogo de productos — RN-CAT-01 a 11.
 *
 * No expone borrado. No es un olvido: RN-CAT-02 dice que un producto se
 * desactiva, y la base ya le revocó el DELETE al rol de la aplicación
 * (migración 0002). Que acá tampoco exista el método cierra el círculo — no hay
 * forma de llamarlo por accidente.
 */

export type FiltroActivo = 'activos' | 'inactivos' | 'todos'

export interface DatosDeAlta {
  nombre: string
  presentacion: Producto['presentacion']
  contenidoMl: number
  unidades: number
  precioResidencial: string
  precioComercial: string
  precioMinimo: string
}

export interface DatosDePrecios {
  precioResidencial: string
  precioComercial: string
  precioMinimo: string
}

/** Quién hace la acción. Lo arma la ruta; el servicio no conoce a Fastify. */
export interface ContextoDeAuditoria {
  userId: string | null
  rolEjercido: readonly string[]
  requestId: string
  ip?: string | undefined
  userAgent?: string | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Por defecto lista solo los activos: es lo que una pantalla de venta necesita.
 * Ver los inactivos es la excepción y se pide explícitamente.
 */
export async function listarProductos(filtro: FiltroActivo = 'activos'): Promise<Producto[]> {
  const consulta = db.select().from(productos)

  if (filtro === 'todos') return consulta.orderBy(asc(productos.codigo))

  return consulta.where(eq(productos.activo, filtro === 'activos')).orderBy(asc(productos.codigo))
}

export async function buscarProducto(id: string): Promise<Producto | null> {
  const [fila] = await db.select().from(productos).where(eq(productos.id, id))
  return fila ?? null
}

async function exigirProducto(id: string): Promise<Producto> {
  const producto = await buscarProducto(id)
  if (!producto) {
    throw new ErrorDeNegocio('PRODUCTO_NO_ENCONTRADO', 404, 'no existe ese producto')
  }
  return producto
}

// ─────────────────────────────────────────────────────────────────────────────
// El piso de precio — RN-CAT-04
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La base ya lo garantiza con un CHECK, y ese CHECK no perdona ni al rol dueño.
 * Esta validación existe para otra cosa: para que el error diga qué corregir en
 * vez de escupir un mensaje de Postgres.
 *
 * La base impide el dato malo aunque un endpoint se olvide. El servicio existe
 * para que el error sea legible. Los dos, no uno.
 */
function exigirPisoValido(precios: DatosDePrecios): void {
  const minimo = Number(precios.precioMinimo)
  const residencial = Number(precios.precioResidencial)
  const comercial = Number(precios.precioComercial)

  if (minimo < 0) {
    throw new ErrorDeNegocio('PRECIO_MINIMO_INVALIDO', 422, 'el precio mínimo no puede ser negativo')
  }

  if (minimo > residencial || minimo > comercial) {
    throw new ErrorDeNegocio(
      'PRECIO_MINIMO_INVALIDO',
      422,
      'el precio mínimo no puede superar ningún precio de lista',
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El código lo genera el sistema — RN-CAT-11. Se consultan **todos** los
 * códigos, incluidos los de productos inactivos: reciclar el de un producto
 * desactivado haría que un comprobante viejo parezca referirse al nuevo.
 */
async function codigosTomados(): Promise<string[]> {
  const filas = await db.select({ codigo: productos.codigo }).from(productos)
  return filas.map((f) => f.codigo)
}

export async function crearProducto(datos: DatosDeAlta): Promise<Producto> {
  exigirPisoValido(datos)

  const paraCodigo: DatosDeCodigo = {
    presentacion: datos.presentacion,
    contenidoMl: datos.contenidoMl,
    unidades: datos.unidades,
  }
  const codigo = generarCodigo(paraCodigo, await codigosTomados())

  const [creado] = await db
    .insert(productos)
    .values({ ...datos, codigo })
    .returning()

  if (!creado) {
    throw new ErrorDeNegocio('CODIGO_DUPLICADO', 409, 'no se pudo crear el producto')
  }

  return creado
}

/**
 * Edita nombre y presentación. **No toca precios**: eso es `editarPrecios`, que
 * exige otro permiso y deja rastro en la bitácora.
 *
 * Separarlas no es ceremonia. Si editar el nombre pudiera cambiar el precio, la
 * matriz de permisos dejaría de significar lo que dice: `productos:editar`
 * daría acceso a lo que `productos:editar_precios` protege.
 */
export async function editarProducto(
  id: string,
  cambios: { nombre?: string },
): Promise<Producto> {
  await exigirProducto(id)

  const [actualizado] = await db
    .update(productos)
    .set(cambios)
    .where(eq(productos.id, id))
    .returning()

  return actualizado as Producto
}

/**
 * Cambia los tres precios y **deja el antes y el después en la bitácora**.
 *
 * Sin el payload, el log diría que alguien cambió un precio pero no de cuánto a
 * cuánto — que es exactamente lo que se va a querer saber cuando aparezca una
 * venta con un número raro.
 */
export async function editarPrecios(
  id: string,
  nuevos: DatosDePrecios,
  contexto: ContextoDeAuditoria,
): Promise<Producto> {
  const antes = await exigirProducto(id)
  exigirPisoValido(nuevos)

  const [actualizado] = await db
    .update(productos)
    .set(nuevos)
    .where(eq(productos.id, id))
    .returning()

  await emit({
    ...contexto,
    action: 'productos:editar_precios',
    resource: 'productos',
    resourceId: id,
    result: 'ok',
    payload: {
      codigo: antes.codigo,
      antes: {
        residencial: antes.precioResidencial,
        comercial: antes.precioComercial,
        minimo: antes.precioMinimo,
      },
      despues: {
        residencial: nuevos.precioResidencial,
        comercial: nuevos.precioComercial,
        minimo: nuevos.precioMinimo,
      },
    },
  })

  return actualizado as Producto
}

/**
 * Desactiva un producto — RN-CAT-02.
 *
 * Un producto solo se desactiva si **no quedan unidades en stock**. Uno inactivo
 * con saldo es inventario fantasma: nadie puede venderlo, porque no aparece en
 * la pantalla de venta, ni descartarlo, porque para descartarlo hay que
 * encontrarlo. Queda ocupando lugar en la bodega y en ninguna cuenta.
 *
 * ── Por qué `productos` importa de `stock` y no al revés ────────────────────
 *
 * La regla es de productos —es RN-CAT-02, no una RN-STK— pero el dato vive en
 * stock. La alternativa sería que stock bloqueara la desactivación, y eso lo
 * obligaría a conocer el ciclo de vida del catálogo, que no es asunto suyo.
 *
 * La dependencia va contra el orden de los módulos (M1 → M2) y se acepta
 * conscientemente: es una sola función de lectura, `stock/consultas.ts` no
 * expone nada que mueva saldo, y no hay ciclo — stock lee la TABLA `productos`,
 * no este módulo.
 */
export async function desactivarProducto(id: string): Promise<Producto> {
  const producto = await exigirProducto(id)

  if (!producto.activo) {
    throw new ErrorDeNegocio('PRODUCTO_YA_INACTIVO', 409, 'el producto ya estaba desactivado')
  }

  const enStock = await saldoTotalDe(id)
  if (enStock > 0) {
    throw new ErrorDeNegocio(
      'PRODUCTO_CON_STOCK',
      409,
      `quedan ${enStock} unidades en stock: vendelas o descartalas antes de desactivar el producto`,
    )
  }

  const [actualizado] = await db
    .update(productos)
    .set({ activo: false })
    .where(and(eq(productos.id, id), eq(productos.activo, true)))
    .returning()

  return actualizado as Producto
}

export async function reactivarProducto(id: string): Promise<Producto> {
  const producto = await exigirProducto(id)

  if (producto.activo) {
    throw new ErrorDeNegocio('PRODUCTO_YA_ACTIVO', 409, 'el producto ya estaba activo')
  }

  const [actualizado] = await db
    .update(productos)
    .set({ activo: true })
    .where(eq(productos.id, id))
    .returning()

  return actualizado as Producto
}
