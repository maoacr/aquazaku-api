import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '@/db/client'
import { type CodigoDeDescuento, codigosDeDescuento } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'

/**
 * Los códigos de descuento — RN-VEN-13.
 *
 * Los administra el `admin` y se aplican al registrar la venta. El piso de
 * precio de cada producto es la red de seguridad: un código mal definido no
 * puede dejar una venta en cero, porque `precio_final >= precio_minimo` es un
 * `CHECK` de la base.
 *
 * Por eso acá no hace falta validar que el descuento «no sea demasiado
 * grande» — no hay un número que sea demasiado grande. Lo que hay es un piso
 * que no se perfora.
 */

export interface DatosDeCodigo {
  codigo: string
  tipo: 'porcentaje' | 'monto_fijo'
  valor: string
  vigenciaDesde: string
  vigenciaHasta: string
  usosMaximos?: number | null
}

export async function crearCodigo(
  datos: DatosDeCodigo,
  creadoPor: string | null,
): Promise<CodigoDeDescuento> {
  const codigo = datos.codigo.trim().toUpperCase()

  if (codigo.length === 0) {
    throw new ErrorDeNegocio('CODIGO_REQUERIDO', 422, 'el código necesita un nombre')
  }

  if (datos.tipo === 'porcentaje' && Number(datos.valor) > 100) {
    /*
     * Un porcentaje mayor que 100 no es un descuento más grande: es un número
     * que no significa nada. El piso lo frenaría igual, pero fallar acá dice
     * QUÉ está mal en vez de dejar que alguien cargue `500` y vea que descuenta
     * lo mismo que `100`.
     */
    throw new ErrorDeNegocio(
      'PORCENTAJE_INVALIDO',
      422,
      'un porcentaje va entre 0 y 100. Para descontar un monto fijo, cambie el tipo',
    )
  }

  if (datos.vigenciaHasta < datos.vigenciaDesde) {
    throw new ErrorDeNegocio(
      'VIGENCIA_INVALIDA',
      422,
      'la fecha de fin es anterior a la de inicio: el código no estaría vigente ningún día',
    )
  }

  const [existente] = await db
    .select()
    .from(codigosDeDescuento)
    .where(eq(codigosDeDescuento.codigo, codigo))

  if (existente) {
    /*
     * Se rechaza en vez de reutilizar: un código que cambia de valor
     * reinterpretaría las ventas viejas si alguien fuera a mirar por qué se
     * descontó eso. La venta congela el descuento, así que el histórico está a
     * salvo — pero el código en sí seguiría siendo ambiguo.
     */
    throw new ErrorDeNegocio(
      'CODIGO_DUPLICADO',
      409,
      `ya existe un código ${codigo}. Desactive el anterior o use otro nombre`,
    )
  }

  const [creado] = await db
    .insert(codigosDeDescuento)
    .values({
      codigo,
      tipo: datos.tipo,
      valor: datos.valor,
      vigenciaDesde: datos.vigenciaDesde,
      vigenciaHasta: datos.vigenciaHasta,
      usosMaximos: datos.usosMaximos ?? null,
      creadoPor,
    })
    .returning()

  return creado!
}

/**
 * Desactivar, no borrar: una venta pasada lo referencia, y `DELETE` está
 * revocado. Un código desactivado deja de aplicarse y sigue explicando por qué
 * aquella venta costó lo que costó.
 */
export async function desactivarCodigo(id: string): Promise<CodigoDeDescuento> {
  const [codigo] = await db
    .update(codigosDeDescuento)
    .set({ activo: false })
    .where(eq(codigosDeDescuento.id, id))
    .returning()

  if (!codigo) throw new ErrorDeNegocio('CODIGO_NO_ENCONTRADO', 404, 'ese código no existe')

  return codigo
}

export async function listarCodigos(soloVigentes = false, hoy?: string): Promise<CodigoDeDescuento[]> {
  const consulta = db.select().from(codigosDeDescuento)

  if (!soloVigentes || !hoy) return consulta.orderBy(desc(codigosDeDescuento.createdAt))

  return consulta
    .where(
      and(
        eq(codigosDeDescuento.activo, true),
        lte(codigosDeDescuento.vigenciaDesde, hoy),
        gte(codigosDeDescuento.vigenciaHasta, hoy),
      ),
    )
    .orderBy(desc(codigosDeDescuento.createdAt))
}
