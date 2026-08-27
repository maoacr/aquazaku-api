import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Base, type Venta, bases, clientes, direcciones, movimientosBase, ventas } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { exigirCreditoValido } from '@/modules/ventas/credito'
import { aCentavos, aMonto } from '@/modules/ventas/precio'
import { deudaDe } from '@/modules/ventas/saldo'

/**
 * El recargo por daño a una base — RN-BAS-08.
 *
 * ── Resuelve una contradicción entre dos reglas CONFIRMADAS ─────────────────
 *
 * `RN-BAS-08` dice que el recargo **es una venta**, para preservar la auditoría
 * unificada, y que puede ser a crédito.
 *
 * `RN-CLI-06` dice que los cargos pendientes son **distintos de la deuda**,
 * «porque no nacen de una venta a crédito».
 *
 * Si el recargo es una venta a crédito, cae en la deuda. Las dos reglas están
 * confirmadas y no pueden cumplirse a la vez… salvo separando **qué es** de
 * **dónde se cuenta**.
 *
 * El recargo se registra como venta con `tipo = 'dano_base'`. Es una venta de
 * verdad: inmutable (`RN-VEN-02`), se anula con motivo y responsable, queda en
 * la bitácora. Y `deudaDe` **filtra ese tipo**, mientras `cargosPendientesDe` lo
 * cuenta.
 *
 * Cada regla obtiene lo que pedía. El costo es un invariante nuevo: **toda
 * consulta de deuda tiene que respetar el filtro**, o le cobra al cliente un
 * daño como si fuera producto.
 *
 * ── El monto se pide; no se inventa ─────────────────────────────────────────
 *
 * `RN-BAS-08` habla de «el valor de reposición de la base (configurable por
 * SKU/tipo, hoy un solo valor único)», pero **el dominio no dice cuál es ese
 * valor** — no hay un número en ninguna parte.
 *
 * Poner una constante plausible sería inventarlo, y es el mismo error que
 * hubiera sido estimar el caudal en M4 o la equivalencia en M3. Así que el monto
 * viaja explícito en la operación, queda congelado en la venta, y la pregunta de
 * cuál es el número correcto está anotada en /empezar/pendientes/.
 *
 * Cuando exista el módulo de configuración (M12), ese valor pasa a ser el
 * default de este campo — no un reemplazo del campo.
 */

export interface DatosDeDano {
  baseId: string
  /** El valor de reposición, como `'80000.00'`. Explícito a propósito. */
  monto: string
  motivo: string
  /** Cómo se acordó cobrarlo con el cliente. */
  medioDePago: 'efectivo' | 'transferencia' | 'credito'
}

export interface ResultadoDeDano {
  base: Base
  recargo: Venta
}

export async function marcarBaseDanada(
  datos: DatosDeDano,
  registradoPor: string | null,
): Promise<ResultadoDeDano> {
  if (!motivoEsSuficiente(datos.motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      `un recargo por daño necesita al menos ${LARGO_MINIMO_MOTIVO} caracteres: le está cobrando a alguien, y dentro de tres meses tiene que poder explicarse`,
    )
  }

  if (aCentavos(datos.monto) <= 0) {
    throw new ErrorDeNegocio(
      'MONTO_INVALIDO',
      422,
      'el recargo necesita el valor de reposición de la base, y tiene que ser mayor que cero',
    )
  }

  return db.transaction(async (tx) => {
    const [base] = await tx.select().from(bases).where(eq(bases.id, datos.baseId))

    if (!base) throw new ErrorDeNegocio('BASE_NO_ENCONTRADA', 404, 'esa base no existe')

    if (base.estado === 'danada') {
      throw new ErrorDeNegocio(
        'YA_DANADA',
        422,
        `la base ${base.idSticker} ya está marcada como dañada, y su recargo ya se generó. Volver a marcarla le cobraría dos veces al cliente`,
      )
    }

    /*
     * El daño se le cobra a quien la tiene. Una base en la bodega que aparece
     * rota no tiene a quién cobrarle — es una pérdida de la empresa, y eso se
     * registra descartándola con motivo, no cobrándosela a nadie.
     */
    if (base.direccionId === null) {
      throw new ErrorDeNegocio(
        'BASE_EN_BODEGA',
        422,
        `la base ${base.idSticker} figura en la bodega, así que no hay a quién cobrarle el daño. Si se rompió acá, descártela con motivo`,
      )
    }

    const [direccion] = await tx
      .select()
      .from(direcciones)
      .where(eq(direcciones.id, base.direccionId))
    const [cliente] = await tx.select().from(clientes).where(eq(clientes.id, direccion!.clienteId))

    const monto = aMonto(aCentavos(datos.monto))

    /*
     * A crédito exige lo mismo que cualquier venta a crédito (RN-VEN-05). Que
     * el cargo nazca de un daño no lo hace menos crédito: si el cliente no lo
     * tiene habilitado, se cobra de contado o no procede.
     */
    if (datos.medioDePago === 'credito') {
      exigirCreditoValido(cliente!, await deudaDe(cliente!.id, tx), monto)
    }

    const [recargo] = await tx
      .insert(ventas)
      .values({
        clienteId: cliente!.id,
        tipoClienteAlMomento: cliente!.tipo,
        medioDePago: datos.medioDePago,
        tipo: 'dano_base',
        total: monto,
        registradoPor,
      })
      .returning()

    const [danada] = await tx
      .update(bases)
      .set({
        estado: 'danada',
        danadaPor: registradoPor,
        danadaEn: new Date(),
        recargoVentaId: recargo!.id,
      })
      .where(eq(bases.id, datos.baseId))
      .returning()

    await tx.insert(movimientosBase).values({
      baseId: datos.baseId,
      tipo: 'dano',
      direccionId: base.direccionId,
      motivo: datos.motivo.trim(),
      registradoPor,
    })

    return { base: danada!, recargo: recargo! }
  })
}
