import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  type Base,
  type MovimientoBase,
  bases,
  clientes,
  direcciones,
  movimientosBase,
} from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'

/**
 * Las bases — RN-BAS-01 a 07.
 *
 * ── El activo que SÍ tiene identidad ────────────────────────────────────────
 *
 * A diferencia del botellón, cada base es una unidad con historia. La razón no
 * es de implementación: **hay que ir a buscarla a un lugar concreto**. Sin saber
 * en cuál de los tres locales está la base `A-0913`, el préstamo deja de ser
 * reclamable, y una base que no se puede reclamar es una base regalada.
 *
 * Por eso `direccion_id` y no `cliente_id` (`RN-BAS-03`).
 *
 * ── Una base está en exactamente un lugar — RN-BAS-04 ───────────────────────
 *
 * `direccion_id` en `NULL` es la bodega, y la bodega es uno de esos lugares.
 * Prestar una que ya está prestada se rechaza: no es un caso de negocio, es que
 * el sistema perdió el rastro de un retorno.
 */

/** Alta de una base al parque. El sticker es su identidad — RN-BAS-10. */
export async function darDeAltaBase(
  idSticker: string,
  registradoPor: string | null,
): Promise<Base> {
  const sticker = idSticker.trim().toUpperCase()

  if (sticker.length === 0) {
    throw new ErrorDeNegocio(
      'STICKER_REQUERIDO',
      422,
      'una base sin ID de sticker no se puede reclamar: es lo único que la identifica',
    )
  }

  return db.transaction(async (tx) => {
    const [existente] = await tx.select().from(bases).where(eq(bases.idSticker, sticker))

    if (existente) {
      throw new ErrorDeNegocio(
        'STICKER_DUPLICADO',
        409,
        `ya hay una base con el sticker ${sticker}. Dos bases con el mismo ID hacen imposible saber cuál está dónde`,
      )
    }

    const [base] = await tx.insert(bases).values({ idSticker: sticker }).returning()

    await tx.insert(movimientosBase).values({
      baseId: base!.id,
      tipo: 'alta',
      registradoPor,
    })

    return base!
  })
}

/**
 * Prestar una base a una dirección — RN-BAS-03, RN-BAS-04 y RN-BAS-07.
 *
 * ── El cliente tiene que estar verificado ───────────────────────────────────
 *
 * `RN-BAS-07` lo dice y le da autonomía al `pos`: con el cliente verificado no
 * hace falta pedirle permiso a nadie. Entregar una base es un diferenciador
 * competitivo y la fricción tiene que ser mínima — pero **para una identidad
 * comprobada**.
 *
 * Prestarle un activo a alguien cuyo documento nadie miró es exactamente el
 * riesgo que la verificación viene a acotar. Es la misma condición que el
 * crédito (`RN-CLI-15`), aplicada a un activo en vez de a plata.
 */
export async function prestarBase(
  baseId: string,
  direccionId: string,
  registradoPor: string | null,
): Promise<Base> {
  return db.transaction(async (tx) => {
    const base = await baseActiva(tx, baseId)

    if (base.direccionId !== null) {
      /*
       * No es «está ocupada»: es que el libro dice que está en otro lado. Si de
       * verdad la tienen en la mano, falta registrar el retorno — y ese es el
       * dato que se perdió, no este préstamo.
       */
      throw new ErrorDeNegocio(
        'BASE_YA_PRESTADA',
        422,
        `la base ${base.idSticker} figura prestada en otra dirección. Si volvió, registre el retorno primero: una base está en un solo lugar`,
      )
    }

    if (base.estado === 'danada') {
      throw new ErrorDeNegocio(
        'BASE_DANADA',
        422,
        `la base ${base.idSticker} está marcada como dañada. Prestarla haría que el próximo cliente responda por un daño que ya se cobró`,
      )
    }

    const [direccion] = await tx.select().from(direcciones).where(eq(direcciones.id, direccionId))

    if (!direccion) {
      throw new ErrorDeNegocio('DIRECCION_NO_ENCONTRADA', 404, 'esa dirección no existe')
    }

    const [cliente] = await tx.select().from(clientes).where(eq(clientes.id, direccion.clienteId))

    if (cliente!.verificacionEstado !== 'verificado') {
      throw new ErrorDeNegocio(
        'VERIFICACION_REQUERIDA',
        422,
        `el documento de ${cliente!.nombre} no está verificado. Cotéjelo primero: prestarle un activo a una identidad sin comprobar es lo que la verificación viene a evitar`,
      )
    }

    const [prestada] = await tx
      .update(bases)
      .set({ direccionId })
      .where(eq(bases.id, baseId))
      .returning()

    await tx.insert(movimientosBase).values({
      baseId,
      tipo: 'prestamo',
      direccionId,
      registradoPor,
    })

    return prestada!
  })
}

/** La base vuelve a la bodega. */
export async function retornarBase(
  baseId: string,
  registradoPor: string | null,
): Promise<Base> {
  return db.transaction(async (tx) => {
    const base = await baseActiva(tx, baseId)

    if (base.direccionId === null) {
      throw new ErrorDeNegocio(
        'BASE_NO_PRESTADA',
        422,
        `la base ${base.idSticker} ya figura en la bodega`,
      )
    }

    const [retornada] = await tx
      .update(bases)
      .set({ direccionId: null })
      .where(eq(bases.id, baseId))
      .returning()

    await tx.insert(movimientosBase).values({ baseId, tipo: 'retorno', registradoPor })

    return retornada!
  })
}

/** Sale del parque — RN-BAS-06. Exige motivo, como todo lo irreversible. */
export async function descartarBase(
  baseId: string,
  motivo: string,
  registradoPor: string | null,
): Promise<Base> {
  if (!motivoEsSuficiente(motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `descartar una base necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres de explicación`,
    )
  }

  return db.transaction(async (tx) => {
    const base = await baseActiva(tx, baseId)

    if (base.direccionId !== null) {
      throw new ErrorDeNegocio(
        'BASE_PRESTADA',
        422,
        `la base ${base.idSticker} figura prestada. Registre el retorno antes de descartarla, o quedaría un préstamo abierto sobre algo que ya no existe`,
      )
    }

    const [descartada] = await tx
      .update(bases)
      .set({ activa: false })
      .where(eq(bases.id, baseId))
      .returning()

    await tx.insert(movimientosBase).values({
      baseId,
      tipo: 'descarte',
      motivo: motivo.trim(),
      registradoPor,
    })

    return descartada!
  })
}

/** El historial de una base — RN-BAS-05. Dónde estuvo y quién la tuvo. */
export async function historialDe(baseId: string): Promise<MovimientoBase[]> {
  return db
    .select()
    .from(movimientosBase)
    .where(eq(movimientosBase.baseId, baseId))
    .orderBy(movimientosBase.createdAt)
}

/** Las bases prestadas a una dirección — el tercer saldo de RN-CLI-06. */
export async function basesEnDireccion(direccionId: string): Promise<Base[]> {
  return db.select().from(bases).where(eq(bases.direccionId, direccionId))
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function baseActiva(tx: Tx, id: string): Promise<Base> {
  const [base] = await tx.select().from(bases).where(eq(bases.id, id))

  if (!base) throw new ErrorDeNegocio('BASE_NO_ENCONTRADA', 404, 'esa base no existe')
  if (!base.activa) {
    throw new ErrorDeNegocio(
      'BASE_DESCARTADA',
      422,
      `la base ${base.idSticker} fue descartada y ya no está en el parque`,
    )
  }
  return base
}
