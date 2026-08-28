import { and, eq, gte, isNull, sql } from 'drizzle-orm'
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
import type { Ejecutor } from '@/modules/stock/saldo'
import { esCodigoDeBase, proximoCodigo } from './codigo'

/**
 * Las bases — RN-BAS-01 a 07.
 *
 * ── El activo que SÍ tiene identidad ────────────────────────────────────────
 *
 * A diferencia del botellón, cada base es una unidad con historia. La razón no
 * es de implementación: **hay que ir a buscarla a un lugar concreto**. Sin saber
 * en cuál de los tres locales está la base `0913`, el préstamo deja de ser
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

/**
 * Alta de una base al parque. El sticker es su identidad — RN-BAS-10.
 *
 * Sin `idSticker`, el sistema propone el próximo consecutivo. Con él, manda el
 * sticker que el operario tiene en la mano: las 40 bases que Aquazaku ya tiene
 * llegaron con el suyo puesto, y el mundo físico no se renumera desde acá.
 *
 * La propuesta y la validación de unicidad viven **en la misma transacción**.
 * Calcular el próximo afuera dejaría una ventana en la que dos altas simultáneas
 * proponen el mismo número, y la segunda fallaría con un duplicado que el
 * operario no pidió.
 */
export async function darDeAltaBase(
  idSticker: string | undefined,
  registradoPor: string | null,
): Promise<Base> {
  return db.transaction(async (tx) => {
    const sticker = idSticker?.trim() ?? proximoCodigo(await codigosTomados(tx))

    if (!esCodigoDeBase(sticker)) {
      throw new ErrorDeNegocio(
        'STICKER_INVALIDO',
        422,
        `«${sticker}» no tiene la forma de un sticker: son cuatro dígitos con los ceros adelante, como 0001 o 0040`,
      )
    }

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
 * Cuánto tarda en llegar un pedido de bases al proveedor.
 *
 * Viaja en la respuesta para que la pantalla no lo copie: el día que el
 * proveedor cambie, un `7` escrito en un componente seguiría avisando tarde sin
 * que nadie lo note. Mismo criterio que las constantes del cierre de producción.
 */
export const DIAS_DE_ENTREGA = 7

export interface DisponibilidadDeBases {
  /** En bodega, sanas y activas: las que de verdad se pueden prestar hoy. */
  libres: number
  /** Cuántas se prestaron en los últimos `DIAS_DE_ENTREGA` días. */
  prestadasEnLaVentana: number
  diasDeEntrega: number
  /** `false` cuando hay que comprar — RN-BAS-13. */
  alcanza: boolean
}

/**
 * ¿Alcanzan las bases hasta el próximo pedido? — RN-BAS-13.
 *
 * ── Por qué el umbral se CALCULA y no se configura ──────────────────────────
 *
 * Un pedido tarda 7 días. Avisar cuando quedan cero es avisar tarde por diseño:
 * para entonces ya se le dijo que no a un cliente y todavía faltan siete días.
 * Eso separa a las bases del agua, donde cero alcanza porque la planta produce
 * mañana.
 *
 * La pregunta correcta no es «¿cuál es el mínimo?» sino **«¿cuántas se prestan
 * mientras llega el pedido?»**. Y esa el sistema la sabe: cada préstamo queda
 * con su fecha. Un umbral fijo habría que inventarlo hoy —sin operación
 * todavía— y quedaría viejo el día que el negocio cambie de tamaño.
 *
 * ── Se cuentan los préstamos BRUTOS, no el neto contra retornos ─────────────
 *
 * Una base prestada se queda en el local del cliente: los retornos son raros y
 * ocurren cuando alguien deja de comprar. Restarlos daría un neto cercano a
 * cero en operación normal, y el aviso volvería a sonar recién en cero.
 *
 * El bruto sobreestima, y ese es el error correcto: avisar de más cuesta una
 * compra anticipada; avisar de menos cuesta un cliente al que hay que decirle
 * que no durante una semana.
 */
export async function disponibilidadDeBases(): Promise<DisponibilidadDeBases> {
  const desde = new Date(Date.now() - DIAS_DE_ENTREGA * 24 * 60 * 60 * 1000)

  const [fila] = await db
    .select({ n: sql<string>`count(*)` })
    .from(bases)
    .where(and(eq(bases.activa, true), eq(bases.estado, 'sana'), isNull(bases.direccionId)))

  const [ritmo] = await db
    .select({ n: sql<string>`count(*)` })
    .from(movimientosBase)
    .where(and(eq(movimientosBase.tipo, 'prestamo'), gte(movimientosBase.createdAt, desde)))

  const libres = Number(fila?.n ?? 0)
  const prestadasEnLaVentana = Number(ritmo?.n ?? 0)

  return {
    libres,
    prestadasEnLaVentana,
    diasDeEntrega: DIAS_DE_ENTREGA,
    /*
     * Cero libres avisa siempre, aunque el ritmo también sea cero: no se puede
     * prestar lo que no hay, y ahí el aviso no depende de ninguna estimación.
     */
    alcanza: libres > 0 && libres >= prestadasEnLaVentana,
  }
}

/**
 * Comprar bases — entran varias al parque de una vez.
 *
 * ── Por qué existe además del alta de a una ─────────────────────────────────
 *
 * Espeja `comprarBotellones`: los dos activos entran al parque por una compra
 * con cantidad, y esa simetría no es estética. Cargar 40 bases de a una son 40
 * operaciones independientes, y si la número 27 falla el parque queda a medio
 * cargar sin nada que diga dónde se cortó — con los stickers ya impresos, el
 * hueco queda en la caja y no en la pantalla.
 *
 * Acá o entran todas o no entra ninguna.
 *
 * ── Las compradas NO llevan sticker explícito ───────────────────────────────
 *
 * Una base comprada llega sin rotular: el sistema la numera y después se
 * imprime el sticker. El camino de «el rótulo ya viene pegado» es el alta de a
 * una, donde el operario tipea lo que tiene en la mano.
 */
export async function comprarBases(
  cantidad: number,
  registradoPor: string | null,
  /*
   * Se recibe la transacción para que una compra a proveedor escriba el
   * documento y el alta de las bases juntos — M9, RN-PRO-05. Sin esto habría
   * que reimplementar la numeración consecutiva acá.
   */
  externa?: Tx,
): Promise<Base[]> {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new ErrorDeNegocio(
      'CANTIDAD_INVALIDA',
      422,
      'una compra de bases es de al menos una base',
    )
  }

  const alta = async (tx: Tx): Promise<Base[]> => {
    const tomados = await codigosTomados(tx)
    const compradas: Base[] = []

    for (let i = 0; i < cantidad; i++) {
      /*
       * El próximo se recalcula sobre la lista que va creciendo, no sobre la
       * base: adentro de la transacción las filas recién insertadas ya se ven,
       * pero pasar por la lista deja explícito que la numeración es continua
       * dentro de la compra.
       */
      const sticker = proximoCodigo(tomados)
      tomados.push(sticker)

      const [existente] = await tx.select().from(bases).where(eq(bases.idSticker, sticker))

      if (existente) {
        /*
         * No debería pasar —`proximoCodigo` sale del máximo—, pero si pasa, que
         * se caiga la compra entera. Media compra registrada es peor que
         * ninguna: nadie sabría desde qué número seguir.
         */
        throw new ErrorDeNegocio(
          'STICKER_DUPLICADO',
          409,
          `ya hay una base con el sticker ${sticker}. La compra no se registró: vuelva a intentarla`,
        )
      }

      const [base] = await tx.insert(bases).values({ idSticker: sticker }).returning()
      await tx.insert(movimientosBase).values({ baseId: base!.id, tipo: 'alta', registradoPor })

      compradas.push(base!)
    }

    return compradas
  }

  return externa ? alta(externa) : db.transaction(alta)
}

/**
 * Todos los códigos ocupados — **incluidas las bases descartadas**.
 *
 * El filtro por `activa` que usa el resto del módulo NO va acá, y es la
 * diferencia que hace que el número no se recicle: una base descartada puede
 * tener un recargo por daño (RN-BAS-08) apuntándole, y darle su número a una
 * base nueva volvería ambiguo ese cobro. Mismo criterio que `RN-CAT-11` para
 * productos desactivados.
 */
async function codigosTomados(ejecutor: Ejecutor): Promise<string[]> {
  const filas = await ejecutor.select({ idSticker: bases.idSticker }).from(bases)
  return filas.map((f) => f.idSticker)
}

/**
 * El código que el sistema propondría para la próxima base.
 *
 * Existe como endpoint para que la pantalla lo muestre sin recalcularlo: la
 * regla del consecutivo vive en un solo lugar, y una copia en el componente
 * empezaría a mentir el día que cambie.
 */
export async function proximoCodigoDeBase(): Promise<string> {
  return proximoCodigo(await codigosTomados(db))
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
