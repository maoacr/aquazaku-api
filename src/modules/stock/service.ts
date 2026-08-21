import { and, eq, like } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Lote, type MovimientoStock, lotes, productos } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { emit } from '@/modules/authz/audit'
import { codigoDeLote, vencimientoDe } from './codigo-lote'
import { type Ejecutor, descontar, ingresar } from './saldo'

/**
 * Documentos que mueven el stock — RN-STK-02.
 *
 * El stock nunca se edita: se mueve mediante documentos con nombre, fecha,
 * motivo y responsable. Este módulo implementa los dos que son de M2 —el ajuste
 * y el descarte—; la venta es de M6 y el cierre de producción de M4, y los dos
 * van a usar las mismas primitivas de `saldo.ts`.
 */

export interface ContextoDeAuditoria {
  userId: string | null
  rolEjercido: readonly string[]
  requestId: string
  ip?: string | undefined
  userAgent?: string | undefined
}

export interface EntradaDeInventario {
  productoId: string
  cantidad: number
  fechaEmpaque: string
  motivo: string
}

export interface AjusteDeLote {
  loteId: string
  /** Positiva suma, negativa resta. Nunca cero. */
  cantidad: number
  motivo: string
}

export interface Descarte {
  loteId: string
  cantidad: number
  causa: NonNullable<MovimientoStock['causa']>
  observaciones?: string | undefined
}

async function exigirLote(loteId: string, ejecutor: Ejecutor = db): Promise<Lote> {
  const [lote] = await ejecutor.select().from(lotes).where(eq(lotes.id, loteId))
  if (!lote) throw new ErrorDeNegocio('LOTE_NO_ENCONTRADO', 404, 'no existe ese lote')
  return lote
}

function exigirMotivo(motivo: string): void {
  if (!motivo.trim()) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      'un ajuste sin motivo es un cambio que nadie va a poder explicar después',
    )
  }
}

/**
 * Entra producto creando un lote nuevo.
 *
 * En M2 es la única forma de que entre stock: la carga inicial de inventario es
 * un ajuste con motivo. Cuando llegue M4, el cierre de producción va a ser otro
 * documento que crea lotes — con la misma tabla y las mismas primitivas.
 */
export async function registrarEntrada(
  entrada: EntradaDeInventario,
  contexto: ContextoDeAuditoria,
): Promise<Lote> {
  exigirMotivo(entrada.motivo)

  if (!Number.isInteger(entrada.cantidad) || entrada.cantidad <= 0) {
    throw new ErrorDeNegocio('CANTIDAD_INVALIDA', 422, 'la cantidad tiene que ser mayor que cero')
  }

  const [producto] = await db.select().from(productos).where(eq(productos.id, entrada.productoId))
  if (!producto) {
    throw new ErrorDeNegocio('PRODUCTO_NO_ENCONTRADO', 404, 'no existe ese producto')
  }

  // Todos los lotes de ese día, incluidos los agotados: un código no se recicla.
  const delDia = await db
    .select({ codigo: lotes.codigo })
    .from(lotes)
    .where(like(lotes.codigo, `${entrada.fechaEmpaque}-L%`))

  const codigo = codigoDeLote(
    entrada.fechaEmpaque,
    delDia.map((l) => l.codigo),
  )

  const creado = await db.transaction(async (tx) => {
    const [lote] = await tx
      .insert(lotes)
      .values({
        productoId: entrada.productoId,
        codigo,
        fechaEmpaque: entrada.fechaEmpaque,
        fechaVencimiento: vencimientoDe(entrada.fechaEmpaque),
        cantidadInicial: entrada.cantidad,
        // Nace en cero y sube por movimiento: así el libro explica el saldo
        // desde la primera unidad, sin un salto inicial sin documento.
        cantidadDisponible: 0,
      })
      .returning()

    await ingresar(
      {
        loteId: lote!.id,
        cantidad: entrada.cantidad,
        tipo: 'ajuste',
        motivo: entrada.motivo,
        registradoPor: contexto.userId,
      },
      tx,
    )

    return { ...lote!, cantidadDisponible: entrada.cantidad }
  })

  await auditar(contexto, 'stock:ajustar', creado.id, {
    documento: 'entrada_de_inventario',
    codigo: creado.codigo,
    producto: producto.codigo,
    motivo: entrada.motivo,
    antes: 0,
    despues: entrada.cantidad,
  })

  return creado
}

/**
 * Corrige el saldo de un lote existente — el inventario físico siempre difiere.
 *
 * El ajuste existe justamente porque la realidad no coincide con el sistema.
 * Pero es un documento con nombre, fecha y motivo, no un `UPDATE`: sin motivo,
 * nadie va a poder explicar el descuadre tres meses después (RN-STK-02).
 */
export async function ajustarLote(
  ajuste: AjusteDeLote,
  contexto: ContextoDeAuditoria,
): Promise<{ saldo: number }> {
  exigirMotivo(ajuste.motivo)

  if (!Number.isInteger(ajuste.cantidad) || ajuste.cantidad === 0) {
    throw new ErrorDeNegocio(
      'CANTIDAD_INVALIDA',
      422,
      'un ajuste de cero no corrige nada: la cantidad tiene que ser distinta de cero',
    )
  }

  const antes = await exigirLote(ajuste.loteId)

  const resultado =
    ajuste.cantidad > 0
      ? await ingresar({
          loteId: ajuste.loteId,
          cantidad: ajuste.cantidad,
          tipo: 'ajuste',
          motivo: ajuste.motivo,
          registradoPor: contexto.userId,
        })
      : await descontar({
          loteId: ajuste.loteId,
          cantidad: -ajuste.cantidad,
          // `ajuste`, NO `venta`: un conteo que da de menos no vendió nada.
          // Registrarlo como venta inflaría el reporte de ventas con unidades
          // que nadie compró.
          tipo: 'ajuste',
          motivo: ajuste.motivo,
          registradoPor: contexto.userId,
        })

  if (!resultado.ok) {
    throw new ErrorDeNegocio(
      'STOCK_INSUFICIENTE',
      409,
      `el lote tiene ${resultado.disponible} unidades: no se pueden descontar ${-ajuste.cantidad}`,
    )
  }

  await auditar(contexto, 'stock:ajustar', ajuste.loteId, {
    documento: 'ajuste',
    codigo: antes.codigo,
    motivo: ajuste.motivo,
    antes: antes.cantidadDisponible,
    despues: resultado.saldo,
  })

  return { saldo: resultado.saldo }
}

/**
 * Descarta unidades de un lote — RN-STK-06.
 *
 * Selectivo por unidad: una unidad dañada no destruye el lote entero. La causa
 * es obligatoria y la exige un CHECK en la base, no solo esta validación.
 *
 * **Ninguna causa castiga automáticamente.** `mal_manejo_cliente` entra al
 * historial del cliente y `falla_produccion` marca reposición pendiente, pero
 * quien decide qué hacer con eso es el `admin`. Visibilidad sin automatización:
 * el poder de decisión queda en la persona.
 */
export async function descartar(
  descarte: Descarte,
  contexto: ContextoDeAuditoria,
): Promise<{ saldo: number }> {
  if (!Number.isInteger(descarte.cantidad) || descarte.cantidad <= 0) {
    throw new ErrorDeNegocio('CANTIDAD_INVALIDA', 422, 'la cantidad tiene que ser mayor que cero')
  }

  const antes = await exigirLote(descarte.loteId)

  const resultado = await descontar({
    loteId: descarte.loteId,
    cantidad: descarte.cantidad,
    tipo: 'descarte',
    causa: descarte.causa,
    motivo: descarte.observaciones,
    registradoPor: contexto.userId,
  })

  if (!resultado.ok) {
    throw new ErrorDeNegocio(
      'STOCK_INSUFICIENTE',
      409,
      `el lote tiene ${resultado.disponible} unidades: no se pueden descartar ${descarte.cantidad}`,
    )
  }

  await auditar(contexto, 'stock:descartar', descarte.loteId, {
    documento: 'descarte',
    codigo: antes.codigo,
    causa: descarte.causa,
    observaciones: descarte.observaciones ?? null,
    antes: antes.cantidadDisponible,
    despues: resultado.saldo,
  })

  return { saldo: resultado.saldo }
}

/**
 * Escribe en la bitácora. **Bloqueante** — ADR-0007.
 *
 * Ajustar y descartar son acciones sensibles: RN-ACC-04 las nombra. Un ajuste
 * que corrige el inventario sin dejar rastro es exactamente lo que la regla
 * existe para impedir, así que si no se puede auditar, la operación falla.
 *
 * El payload lleva el saldo **antes y después**. Sin eso la bitácora diría que
 * hubo un ajuste pero no de cuánto a cuánto — que es lo primero que se va a
 * preguntar cuando el conteo físico no cuadre.
 */
async function auditar(
  contexto: ContextoDeAuditoria,
  action: string,
  resourceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await emit({ ...contexto, action, resource: 'stock', resourceId, result: 'ok', payload })
}
