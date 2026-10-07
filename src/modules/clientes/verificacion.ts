import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Cliente, clientes } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'
import type { Role } from '@/modules/authz/matrix'
import { clientePorId } from './service'

/**
 * Llevar un cliente de `pendiente` a `verificado` — RN-CLI-10 y RN-CLI-14.
 *
 * ── No es un checkbox de trámite ────────────────────────────────────────────
 *
 * Al marcarlo, alguien queda registrado afirmando que tuvo el documento en la
 * mano. Si después aparece un documento equivocado, se sabe quién lo dio por
 * bueno — y esa trazabilidad es lo único que hace que el flag signifique algo.
 * Si nadie responde por él, todos lo marcan siempre y deja de servir.
 */

/**
 * El método se DERIVA del rol, no se recibe por parámetro.
 *
 * La diferencia entre los dos primeros y el tercero es de confianza:
 * `seller_manual` y `pos_manual` son verificación fáctica en el momento,
 * `admin_oficial` es ratificación formal diferida.
 *
 * Si el método viniera del cliente HTTP, un `seller` podría marcar
 * `admin_oficial` y darle a su cotejo en la calle el peso de una validación
 * contra documento oficial. El rol ya está en la sesión: preguntarlo otra vez
 * sería preguntarle a quien tiene el incentivo de contestar distinto.
 */
const METODO_DE: Partial<Record<Role, 'seller_manual' | 'pos_manual' | 'admin_oficial'>> = {
  seller: 'seller_manual',
  pos: 'pos_manual',
  admin: 'admin_oficial',
}

/**
 * Qué método le corresponde a quien verifica, dados TODOS sus roles.
 *
 * Los roles se suman (RN-ACC-01), así que alguien puede ser `admin` y `pos` a la
 * vez. Se elige el de mayor peso —`admin_oficial`— porque es el que describe con
 * más precisión quién está respondiendo: si esa persona es admin, su palabra
 * vale como ratificación formal aunque además atienda el mostrador.
 */
export function metodoParaRoles(roles: readonly Role[]): 'seller_manual' | 'pos_manual' | 'admin_oficial' {
  const orden: Role[] = ['admin', 'pos', 'seller']
  const elegido = orden.find((rol) => roles.includes(rol))

  if (!elegido) {
    // No debería llegar acá: `requirePermission` ya filtró. Pero si llegara, un
    // método inventado sería peor que un error.
    throw new ErrorDeNegocio(
      'SIN_METODO_DE_VERIFICACION',
      403,
      'ninguno de sus roles puede verificar un documento',
    )
  }

  return METODO_DE[elegido]!
}

export async function verificarDocumento(
  id: string,
  roles: readonly Role[],
  contexto: ContextoDeAuditoria,
): Promise<Cliente> {
  /*
   * ── El cotejo y su fila, una sola escritura — ADR-0007 ────────────────────
   *
   * Al marcar un documento alguien queda registrado afirmando que lo tuvo en la
   * mano, y esa trazabilidad es lo único que hace que el flag signifique algo.
   * Si la fila puede fallar DESPUÉS del UPDATE, queda un documento verificado
   * sin nadie que responda por él — justo lo que la regla viene a evitar.
   */
  return db.transaction(async (tx) => {
    const actual = await clientePorId(id, tx)

    if (actual.verificacionEstado === 'verificado') {
      throw new ErrorDeNegocio(
        'YA_VERIFICADO',
        422,
        'ese documento ya está verificado. Volver a marcarlo reemplazaría quién respondió por él',
      )
    }

    const [cliente] = await tx
      .update(clientes)
      .set({
        verificacionEstado: 'verificado',
        verificadoPor: contexto.userId,
        verificadoEn: new Date(),
        verificacionMetodo: metodoParaRoles(roles),
        updatedAt: new Date(),
      })
      .where(eq(clientes.id, id))
      .returning()

    /*
     * El MÉTODO es el detalle que importa — RN-CLI-14. No pesan igual:
     * `admin_oficial` es una ratificación contra el documento oficial y
     * `seller_manual` es un cotejo en la calle.
     *
     * `revertida` distingue esta fila de la de la reversión, que comparte el
     * nombre de la acción porque comparte el permiso.
     */
    await emit(
      {
        ...contexto,
        action: 'clientes:verificar_documento',
        resource: 'clientes',
        resourceId: cliente!.id,
        result: 'ok',
        payload: {
          resourceId: cliente!.id,
          metodo: cliente!.verificacionMetodo,
          revertida: false,
        },
      },
      tx,
    )

    return cliente!
  })
}

/**
 * Volver a `pendiente` — cuando el cotejo resultó equivocado.
 *
 * ── Por qué esto puede fallar, y está bien que falle ────────────────────────
 *
 * Si el cliente tiene crédito habilitado, el `CHECK` de la base lo rechaza:
 * crédito exige verificación (RN-CLI-15), y esta es la mitad del invariante que
 * un guard en «habilitar crédito» nunca habría cubierto.
 *
 * El servicio lo explica antes de que la base lo grite, pero **no es el servicio
 * quien lo garantiza**: si alguien entra por una consola, el `CHECK` sigue ahí.
 */
export async function revertirVerificacion(
  id: string,
  motivo: string,
  contexto: ContextoDeAuditoria,
): Promise<Cliente> {
  return db.transaction(async (tx) => {
  const actual = await clientePorId(id, tx)

  if (actual.creditoHabilitado) {
    throw new ErrorDeNegocio(
      'CREDITO_ACTIVO',
      422,
      `${actual.nombre} tiene crédito habilitado, y el crédito exige verificación. Quítele el crédito primero: dejarlo con crédito y sin verificar es exactamente lo que la regla evita`,
    )
  }

  if (motivo.trim().length < 10) {
    throw new ErrorDeNegocio(
      'MOTIVO_REQUERIDO',
      422,
      'desmarcar una verificación necesita explicación: alguien había respondido por ese documento',
    )
  }

  const [cliente] = await tx
    .update(clientes)
    .set({
      verificacionEstado: 'pendiente',
      verificadoPor: null,
      verificadoEn: null,
      verificacionMetodo: null,
      updatedAt: new Date(),
    })
    .where(eq(clientes.id, id))
    .returning()

    /*
     * Verificar y revertir son hechos OPUESTOS bajo el mismo nombre de acción,
     * porque comparten el permiso. Sin `revertida` la bitácora no puede decir
     * si alguien respondió por un documento o retiró ese respaldo, y el motivo
     * es lo único que explica por qué se retiró.
     *
     * No se le pone un nombre de acción propio a propósito: renombrarla tocaría
     * el catálogo de `web/` y cambiaría los filtros de la pantalla de auditoría.
     */
    await emit(
      {
        ...contexto,
        action: 'clientes:verificar_documento',
        resource: 'clientes',
        resourceId: cliente!.id,
        result: 'ok',
        payload: { resourceId: cliente!.id, revertida: true, motivo },
      },
      tx,
    )

    return cliente!
  })
}
