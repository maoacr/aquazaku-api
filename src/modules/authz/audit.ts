import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Action, Resource } from './matrix'

/**
 * Escritura en la bitácora — RN-ACC-04.
 *
 * La tabla es append-only por trigger y por permisos (ADR-0004): desde acá solo
 * se puede insertar, y eso es todo lo que hace falta.
 */

export interface AuditInput {
  /** `null` cuando la acción no tiene sesión detrás (ej: login fallido). */
  userId: string | null
  /** Todos los roles activos del usuario al momento de la acción. */
  rolEjercido: readonly string[]
  /** Formato canónico `recurso:accion` — el mismo string en back, front y docs. */
  action: string
  resource?: string | undefined
  resourceId?: string | undefined
  result: 'ok' | 'denied'
  requestId: string
  ip?: string | undefined
  userAgent?: string | undefined
  payload?: Record<string, unknown> | undefined
}

export async function emit(input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    userId: input.userId,
    rolEjercido: [...input.rolEjercido],
    action: input.action,
    resource: input.resource ?? null,
    resourceId: input.resourceId ?? null,
    result: input.result,
    requestId: input.requestId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    payload: input.payload ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Qué se audita
//
// RN-ACC-04 exige auditar las acciones SENSIBLES: anulaciones, ajustes de stock,
// bajas de botellones y bases, préstamos y retiros, cambios de precio,
// habilitación de crédito y cierres con faltante.
//
// Auditar además cada lectura permitida tendría dos costos y ningún beneficio:
// un INSERT por cada carga de pantalla, y —peor— miles de filas de ruido que
// entierran justamente las acciones que hay que poder encontrar. Un log que
// nadie puede leer no es un control, es un log.
//
// La política, entonces:
//
//   · Todo DENEGADO se audita. Siempre, sin excepción. Son raros y cada uno
//     importa: alguien intentó algo que no puede hacer.
//   · Todo PERMITIDO se audita, SALVO las lecturas puras.
//
// El default es auditar. Para que una acción nueva quede fuera hay que
// agregarla explícitamente a la lista de exentas — nunca al revés. Si algún día
// alguien duda, el sistema audita de más.
// ─────────────────────────────────────────────────────────────────────────────

/** Lecturas que no dejan rastro al permitirse. Todo lo demás sí. */
const LECTURAS_EXENTAS: readonly Action[] = ['ver', 'operativos', 'financieros'] as const

/**
 * Excepciones a la excepción: leer esto SÍ deja rastro.
 *
 * - `auditoria:ver` — quién mira la bitácora también queda en la bitácora. Sin
 *   esto, el único control del sistema no tiene control sobre sí mismo.
 * - `reportes:descargar_pdf` — el doc de dominio lo pide explícitamente: cada
 *   descarga de reporte queda registrada.
 */
const LECTURAS_AUDITADAS: readonly string[] = ['auditoria:ver', 'reportes:descargar_pdf'] as const

export function debeAuditarseAlPermitir(resource: Resource, action: Action): boolean {
  if (LECTURAS_AUDITADAS.includes(`${resource}:${action}`)) return true

  return !LECTURAS_EXENTAS.includes(action)
}
