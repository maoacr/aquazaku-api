/**
 * Matriz de permisos de Aquazaku — versión ejecutable.
 *
 * Es una transcripción 1-a-1 de la matriz de `/dominio/roles-y-permisos/`. Ese
 * documento y este archivo son **la misma fuente de verdad**: un cambio en uno
 * exige el cambio en el otro, y el test `matrix.test.ts` falla si se desincronizan.
 *
 * Vive en TypeScript y no en la base a propósito (ADR-0003): es una regla de
 * negocio pura, sin estado, versionada con el código y testeable celda por celda.
 *
 * Lo que NO vive acá: las restricciones de negocio como `con motivo`,
 * `cliente verificado`, `cantidades` o `solo si la compra está pendiente`. Esas
 * son de la capa de servicio de cada módulo. La matriz contesta *¿puedo?*; el
 * servicio contesta *¿se dan las condiciones ahora?*.
 */

export type Role = 'admin' | 'seller' | 'pos' | 'contador'

export const ROLES: readonly Role[] = ['admin', 'seller', 'pos', 'contador'] as const

export type Resource =
  | 'ventas'
  | 'cobros'
  | 'clientes'
  | 'stock'
  | 'insumos'
  | 'botellones'
  | 'bases'
  | 'produccion'
  | 'tanques'
  | 'proveedores'
  | 'compras'
  | 'rutas'
  | 'productos'
  | 'usuarios'
  | 'auditoria'
  | 'reportes'
  | 'configuracion'

export type Action =
  | 'ver'
  | 'crear'
  | 'editar'
  | 'anular'
  | 'anular_verificada'
  | 'verificar_pago'
  | 'gestionar_cuentas_pendientes'
  | 'registrar'
  | 'verificar_documento'
  | 'habilitar_credito'
  | 'cargar_ruta'
  | 'ajustar'
  | 'entregar'
  | 'recibir_retorno'
  | 'descartar'
  | 'desactivar'
  | 'prestar'
  | 'retirar'
  | 'registrar_cierre'
  | 'registrar_reposicion'
  | 'equivalencias'
  | 'recibir'
  | 'abrir'
  | 'rendir'
  | 'cerrar_con_faltante'
  | 'editar_precios'
  | 'operativos'
  | 'financieros'
  | 'descargar_pdf'

/**
 * Alcances. Los cuatro primeros filtran filas de una tabla; `prep` y
 * `operativos` acotan categorías de reporte y no producen `WHERE`.
 */
export type Scope = 'todo' | 'propio' | 'ruta' | 'BODEGA' | 'prep' | 'operativos'

/** Alcances que sí se traducen a una condición SQL sobre una tabla. */
export const SCOPES_DE_DATOS = ['todo', 'propio', 'ruta', 'BODEGA'] as const
export type ScopeDeDatos = (typeof SCOPES_DE_DATOS)[number]

/** Alcances que acotan categorías de reporte, no filas. Los resuelve M13. */
export const SCOPES_CATEGORICOS = ['prep', 'operativos'] as const

export function esScopeDeDatos(scope: Scope): scope is ScopeDeDatos {
  return (SCOPES_DE_DATOS as readonly string[]).includes(scope)
}

export interface PermissionRule {
  resource: Resource
  action: Action
  scope: Scope
  /**
   * El rol ve el recurso pero no puede modificarlo por ninguna vía. Hoy solo
   * aplica a `contador`. Es metadato para la UI y una invariante que
   * `matrix.test.ts` verifica; el bloqueo real es estructural — el rol
   * simplemente no tiene reglas de escritura.
   */
  readonly?: true
}

/** Acciones que solo leen. El resto modifica estado. */
export const ACCIONES_DE_LECTURA: readonly Action[] = [
  'ver',
  'operativos',
  'financieros',
  'descargar_pdf',
] as const

export const PERMISSION_MATRIX: Record<Role, readonly PermissionRule[]> = {
  // ───────────────────────────────────────────────────────────────────────────
  // admin — puede todo. Ver la advertencia de "La consecuencia de tener admin
  // con super-poderes" en /dominio/roles-y-permisos/: sin separación de
  // funciones, la auditoría es el único control que queda en pie.
  // ───────────────────────────────────────────────────────────────────────────
  admin: [
    { resource: 'ventas', action: 'ver', scope: 'todo' },
    { resource: 'ventas', action: 'crear', scope: 'todo' },
    { resource: 'ventas', action: 'anular', scope: 'todo' },
    { resource: 'ventas', action: 'anular_verificada', scope: 'todo' },
    { resource: 'ventas', action: 'verificar_pago', scope: 'todo' },
    { resource: 'ventas', action: 'gestionar_cuentas_pendientes', scope: 'todo' },

    { resource: 'cobros', action: 'ver', scope: 'todo' },
    { resource: 'cobros', action: 'registrar', scope: 'todo' },

    { resource: 'clientes', action: 'ver', scope: 'todo' },
    { resource: 'clientes', action: 'crear', scope: 'todo' },
    { resource: 'clientes', action: 'verificar_documento', scope: 'todo' },
    { resource: 'clientes', action: 'editar', scope: 'todo' },
    { resource: 'clientes', action: 'habilitar_credito', scope: 'todo' },

    { resource: 'stock', action: 'ver', scope: 'todo' },
    { resource: 'stock', action: 'cargar_ruta', scope: 'todo' },
    { resource: 'stock', action: 'ajustar', scope: 'todo' },
    { resource: 'stock', action: 'descartar', scope: 'todo' },
    { resource: 'insumos', action: 'ver', scope: 'todo' },
    { resource: 'insumos', action: 'ajustar', scope: 'todo' },

    { resource: 'botellones', action: 'ver', scope: 'todo' },
    { resource: 'botellones', action: 'entregar', scope: 'todo' },
    { resource: 'botellones', action: 'recibir_retorno', scope: 'todo' },
    { resource: 'botellones', action: 'registrar', scope: 'todo' },
    { resource: 'botellones', action: 'descartar', scope: 'todo' },

    { resource: 'bases', action: 'ver', scope: 'todo' },
    { resource: 'bases', action: 'prestar', scope: 'todo' },
    { resource: 'bases', action: 'retirar', scope: 'todo' },
    { resource: 'bases', action: 'registrar', scope: 'todo' },
    { resource: 'bases', action: 'descartar', scope: 'todo' },

    { resource: 'produccion', action: 'ver', scope: 'todo' },
    { resource: 'produccion', action: 'registrar_cierre', scope: 'todo' },
    { resource: 'tanques', action: 'ver', scope: 'todo' },
    { resource: 'tanques', action: 'registrar_reposicion', scope: 'todo' },
    { resource: 'tanques', action: 'ajustar', scope: 'todo' },
    { resource: 'configuracion', action: 'equivalencias', scope: 'todo' },

    { resource: 'proveedores', action: 'ver', scope: 'todo' },
    { resource: 'proveedores', action: 'crear', scope: 'todo' },
    /*
     * `editar` cubre también desactivar, igual que en clientes: RN-PRO-01 dice
     * que un proveedor con historial se desactiva, y desactivar es escribir una
     * columna. Una acción propia solo tendría sentido si el conjunto de roles
     * fuera distinto, y no lo es.
     */
    { resource: 'proveedores', action: 'editar', scope: 'todo' },
    { resource: 'compras', action: 'crear', scope: 'todo' },
    { resource: 'compras', action: 'recibir', scope: 'todo' },

    { resource: 'rutas', action: 'ver', scope: 'todo' },
    { resource: 'rutas', action: 'abrir', scope: 'todo' },
    { resource: 'rutas', action: 'rendir', scope: 'todo' },
    { resource: 'rutas', action: 'cerrar_con_faltante', scope: 'todo' },

    { resource: 'productos', action: 'ver', scope: 'todo' },
    { resource: 'productos', action: 'crear', scope: 'todo' },
    { resource: 'productos', action: 'editar', scope: 'todo' },
    { resource: 'productos', action: 'editar_precios', scope: 'todo' },
    { resource: 'productos', action: 'desactivar', scope: 'todo' },
    { resource: 'usuarios', action: 'ver', scope: 'todo' },
    { resource: 'usuarios', action: 'crear', scope: 'todo' },
    { resource: 'usuarios', action: 'editar', scope: 'todo' },
    { resource: 'auditoria', action: 'ver', scope: 'todo' },
    { resource: 'reportes', action: 'operativos', scope: 'todo' },
    { resource: 'reportes', action: 'financieros', scope: 'todo' },
    { resource: 'reportes', action: 'descargar_pdf', scope: 'todo' },
    { resource: 'configuracion', action: 'ver', scope: 'todo' },
    { resource: 'configuracion', action: 'editar', scope: 'todo' },
  ],

  // ───────────────────────────────────────────────────────────────────────────
  // seller — vende en la calle. Ve lo suyo, no toca planta ni stock.
  // ───────────────────────────────────────────────────────────────────────────
  seller: [
    { resource: 'ventas', action: 'ver', scope: 'propio' },
    { resource: 'ventas', action: 'crear', scope: 'todo' },
    // El "+ status=pendiente" de la matriz es constraint de servicio, no alcance.
    { resource: 'ventas', action: 'anular', scope: 'propio' },
    { resource: 'ventas', action: 'verificar_pago', scope: 'propio' },

    { resource: 'cobros', action: 'ver', scope: 'propio' },
    { resource: 'cobros', action: 'registrar', scope: 'todo' },

    { resource: 'clientes', action: 'ver', scope: 'todo' },
    { resource: 'clientes', action: 'crear', scope: 'todo' },
    { resource: 'clientes', action: 'verificar_documento', scope: 'todo' },

    { resource: 'stock', action: 'ver', scope: 'todo' },
    { resource: 'botellones', action: 'ver', scope: 'todo' },
    { resource: 'bases', action: 'ver', scope: 'todo' },

    { resource: 'rutas', action: 'ver', scope: 'propio' },
    { resource: 'rutas', action: 'abrir', scope: 'todo' },
    { resource: 'rutas', action: 'rendir', scope: 'propio' },

    { resource: 'productos', action: 'ver', scope: 'todo' },
  ],

  // ───────────────────────────────────────────────────────────────────────────
  // pos — opera la planta y el punto de venta. Es quien mueve producto físico.
  // ───────────────────────────────────────────────────────────────────────────
  pos: [
    { resource: 'ventas', action: 'ver', scope: 'propio' },
    { resource: 'ventas', action: 'crear', scope: 'todo' },
    { resource: 'ventas', action: 'anular', scope: 'propio' },
    { resource: 'ventas', action: 'verificar_pago', scope: 'propio' },

    { resource: 'cobros', action: 'ver', scope: 'propio' },
    { resource: 'cobros', action: 'registrar', scope: 'todo' },

    { resource: 'clientes', action: 'ver', scope: 'todo' },
    { resource: 'clientes', action: 'crear', scope: 'todo' },
    { resource: 'clientes', action: 'verificar_documento', scope: 'todo' },

    /**
     * `todo` y no `BODEGA` — M2.
     *
     * El alcance `BODEGA` exige una columna `ubicacion` en la tabla, y el stock
     * no la tiene: hay una sola bodega y se decidió no modelarla (RN-STK-01).
     * Con `BODEGA`, `scopeCondition` lanzaría `ScopeNoAplicableError` —el fallo
     * cerrado de ADR-0005— y el `pos` recibiría un error en vez de ver el
     * stock.
     *
     * Con una sola ubicación los dos alcances significan lo mismo, y `todo` es
     * el honesto: el `pos` ve todo el stock porque todo está en el único lugar
     * que hay. `BODEGA` sigue en el modelo, sin usar, para cuando M8 traiga una
     * segunda ubicación.
     */
    { resource: 'stock', action: 'ver', scope: 'todo' },
    { resource: 'stock', action: 'cargar_ruta', scope: 'todo' },
    // "cantidades (con motivo)" es constraint de servicio, no alcance.
    { resource: 'stock', action: 'ajustar', scope: 'todo' },
    // Es quien manipula el producto y ve el daño — RN-STK-06. Mismo criterio
    // con el que ya descarta botellones y bases.
    { resource: 'stock', action: 'descartar', scope: 'todo' },
    { resource: 'insumos', action: 'ver', scope: 'todo' },
    { resource: 'insumos', action: 'ajustar', scope: 'todo' },

    { resource: 'botellones', action: 'ver', scope: 'todo' },
    { resource: 'botellones', action: 'entregar', scope: 'todo' },
    { resource: 'botellones', action: 'recibir_retorno', scope: 'todo' },
    { resource: 'botellones', action: 'registrar', scope: 'todo' },
    { resource: 'botellones', action: 'descartar', scope: 'todo' },

    { resource: 'bases', action: 'ver', scope: 'todo' },
    // "con cliente verificado" (RN-CLI-11) es constraint de servicio.
    { resource: 'bases', action: 'prestar', scope: 'todo' },
    { resource: 'bases', action: 'retirar', scope: 'todo' },
    { resource: 'bases', action: 'registrar', scope: 'todo' },
    { resource: 'bases', action: 'descartar', scope: 'todo' },

    { resource: 'produccion', action: 'ver', scope: 'todo' },
    { resource: 'produccion', action: 'registrar_cierre', scope: 'todo' },
    { resource: 'tanques', action: 'ver', scope: 'todo' },
    { resource: 'tanques', action: 'registrar_reposicion', scope: 'todo' },
    // Único permiso de configuración del pos. NO tiene `configuracion:ver`.
    { resource: 'configuracion', action: 'equivalencias', scope: 'todo' },

    { resource: 'proveedores', action: 'ver', scope: 'todo' },
    { resource: 'compras', action: 'crear', scope: 'todo' },
    // "solo si compra=pendiente y proveedor=activo" es constraint de servicio.
    { resource: 'compras', action: 'recibir', scope: 'todo' },

    { resource: 'rutas', action: 'ver', scope: 'todo' },
    { resource: 'productos', action: 'ver', scope: 'todo' },

    { resource: 'reportes', action: 'operativos', scope: 'prep' },
    { resource: 'reportes', action: 'descargar_pdf', scope: 'operativos' },
  ],

  // ───────────────────────────────────────────────────────────────────────────
  // contador — testigo externo. Mira todo, no modifica nada. Existe para que la
  // auditoría tenga alguien que la lea sin poder alterarla.
  // ───────────────────────────────────────────────────────────────────────────
  contador: [
    { resource: 'ventas', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'cobros', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'clientes', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'stock', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'insumos', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'botellones', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'bases', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'produccion', action: 'ver', scope: 'todo', readonly: true },
    // OJO: `tanques:ver` NO está. El doc de dominio marca ❌ para contador.
    { resource: 'proveedores', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'rutas', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'productos', action: 'ver', scope: 'todo', readonly: true },
    { resource: 'auditoria', action: 'ver', scope: 'todo', readonly: true },

    { resource: 'reportes', action: 'operativos', scope: 'todo', readonly: true },
    { resource: 'reportes', action: 'financieros', scope: 'todo', readonly: true },
    { resource: 'reportes', action: 'descargar_pdf', scope: 'todo', readonly: true },
  ],
}
