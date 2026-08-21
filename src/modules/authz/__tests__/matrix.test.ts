import { describe, expect, it } from 'vitest'
import {
  ACCIONES_DE_LECTURA,
  PERMISSION_MATRIX,
  ROLES,
  type Role,
  SCOPES_CATEGORICOS,
  esScopeDeDatos,
} from '../matrix'

/**
 * Verificación celda por celda de la matriz (spec §12).
 *
 * Las listas de abajo se transcribieron **desde el documento de dominio**
 * (`/dominio/roles-y-permisos/`), no desde `matrix.ts`. Si se derivaran del
 * código, el test sería circular: confirmaría que el código es igual a sí mismo.
 *
 * Que haya que escribir cada celda dos veces es deliberado. Cambiar un permiso
 * exige tocar el código Y el test, en dos lugares distintos, a conciencia. Para
 * una matriz de seguridad, esa fricción es la característica, no el defecto.
 */

const ESPERADO: Record<Role, string[]> = {
  admin: [
    'ventas:ver:todo',
    'ventas:crear:todo',
    'ventas:anular:todo',
    'ventas:anular_verificada:todo',
    'ventas:verificar_pago:todo',
    'ventas:gestionar_cuentas_pendientes:todo',
    'cobros:ver:todo',
    'cobros:registrar:todo',
    'clientes:ver:todo',
    'clientes:crear:todo',
    'clientes:verificar_documento:todo',
    'clientes:editar:todo',
    'clientes:habilitar_credito:todo',
    'stock:ver:todo',
    'stock:cargar_ruta:todo',
    'stock:ajustar:todo',
    'insumos:ver:todo',
    'insumos:ajustar:todo',
    'botellones:ver:todo',
    'botellones:entregar:todo',
    'botellones:recibir_retorno:todo',
    'botellones:registrar:todo',
    'botellones:descartar:todo',
    'bases:ver:todo',
    'bases:prestar:todo',
    'bases:retirar:todo',
    'bases:registrar:todo',
    'bases:descartar:todo',
    'produccion:ver:todo',
    'produccion:registrar_cierre:todo',
    'tanques:ver:todo',
    'tanques:registrar_reposicion:todo',
    'tanques:ajustar:todo',
    'configuracion:equivalencias:todo',
    'proveedores:ver:todo',
    'proveedores:crear:todo',
    'compras:crear:todo',
    'compras:recibir:todo',
    'rutas:ver:todo',
    'rutas:abrir:todo',
    'rutas:rendir:todo',
    'rutas:cerrar_con_faltante:todo',
    'productos:ver:todo',
    'productos:crear:todo',
    'productos:editar:todo',
    'productos:editar_precios:todo',
    'productos:desactivar:todo',
    'usuarios:ver:todo',
    'usuarios:crear:todo',
    'usuarios:editar:todo',
    'auditoria:ver:todo',
    'reportes:operativos:todo',
    'reportes:financieros:todo',
    'reportes:descargar_pdf:todo',
    'configuracion:ver:todo',
    'configuracion:editar:todo',
  ],
  seller: [
    'ventas:ver:propio',
    'ventas:crear:todo',
    'ventas:anular:propio',
    'ventas:verificar_pago:propio',
    'cobros:ver:propio',
    'cobros:registrar:todo',
    'clientes:ver:todo',
    'clientes:crear:todo',
    'clientes:verificar_documento:todo',
    'stock:ver:todo',
    'botellones:ver:todo',
    'bases:ver:todo',
    'rutas:ver:propio',
    'rutas:abrir:todo',
    'rutas:rendir:propio',
    'productos:ver:todo',
  ],
  pos: [
    'ventas:ver:propio',
    'ventas:crear:todo',
    'ventas:anular:propio',
    'ventas:verificar_pago:propio',
    'cobros:ver:propio',
    'cobros:registrar:todo',
    'clientes:ver:todo',
    'clientes:crear:todo',
    'clientes:verificar_documento:todo',
    'stock:ver:BODEGA',
    'stock:cargar_ruta:todo',
    'stock:ajustar:todo',
    'insumos:ver:todo',
    'insumos:ajustar:todo',
    'botellones:ver:todo',
    'botellones:entregar:todo',
    'botellones:recibir_retorno:todo',
    'botellones:registrar:todo',
    'botellones:descartar:todo',
    'bases:ver:todo',
    'bases:prestar:todo',
    'bases:retirar:todo',
    'bases:registrar:todo',
    'bases:descartar:todo',
    'produccion:ver:todo',
    'produccion:registrar_cierre:todo',
    'tanques:ver:todo',
    'tanques:registrar_reposicion:todo',
    'configuracion:equivalencias:todo',
    'proveedores:ver:todo',
    'compras:crear:todo',
    'compras:recibir:todo',
    'rutas:ver:todo',
    'productos:ver:todo',
    'reportes:operativos:prep',
    'reportes:descargar_pdf:operativos',
  ],
  contador: [
    'ventas:ver:todo',
    'cobros:ver:todo',
    'clientes:ver:todo',
    'stock:ver:todo',
    'insumos:ver:todo',
    'botellones:ver:todo',
    'bases:ver:todo',
    'produccion:ver:todo',
    'proveedores:ver:todo',
    'rutas:ver:todo',
    'productos:ver:todo',
    'auditoria:ver:todo',
    'reportes:operativos:todo',
    'reportes:financieros:todo',
    'reportes:descargar_pdf:todo',
  ],
}

const comoStrings = (role: Role): string[] =>
  PERMISSION_MATRIX[role].map((r) => `${r.resource}:${r.action}:${r.scope}`).sort()

describe('PERMISSION_MATRIX — celda por celda', () => {
  for (const role of ROLES) {
    it(`${role} coincide exactamente con el documento de dominio`, () => {
      expect(comoStrings(role)).toEqual([...ESPERADO[role]].sort())
    })
  }
})

describe('PERMISSION_MATRIX — invariantes estructurales', () => {
  it('los cuatro roles tienen reglas', () => {
    for (const role of ROLES) {
      expect(PERMISSION_MATRIX[role].length).toBeGreaterThan(0)
    }
  })

  it('ningún rol repite el mismo recurso:acción', () => {
    for (const role of ROLES) {
      const claves = PERMISSION_MATRIX[role].map((r) => `${r.resource}:${r.action}`)
      expect(new Set(claves).size).toBe(claves.length)
    }
  })

  it('contador solo tiene acciones de lectura — es un testigo, no un operador', () => {
    for (const rule of PERMISSION_MATRIX.contador) {
      expect(ACCIONES_DE_LECTURA).toContain(rule.action)
    }
  })

  it('toda regla de contador está marcada readonly', () => {
    for (const rule of PERMISSION_MATRIX.contador) {
      expect(rule.readonly).toBe(true)
    }
  })

  it('ningún rol que no sea contador usa el flag readonly', () => {
    for (const role of ROLES) {
      if (role === 'contador') continue
      for (const rule of PERMISSION_MATRIX[role]) {
        expect(rule.readonly).toBeUndefined()
      }
    }
  })

  it('readonly nunca marca una acción que escribe', () => {
    for (const role of ROLES) {
      for (const rule of PERMISSION_MATRIX[role]) {
        if (rule.readonly) expect(ACCIONES_DE_LECTURA).toContain(rule.action)
      }
    }
  })

  it('los alcances categóricos solo aparecen en reportes', () => {
    for (const role of ROLES) {
      for (const rule of PERMISSION_MATRIX[role]) {
        if (!esScopeDeDatos(rule.scope)) {
          expect(rule.resource).toBe('reportes')
        }
      }
    }
  })

  it('SCOPES_CATEGORICOS y los de datos no se solapan', () => {
    for (const scope of SCOPES_CATEGORICOS) {
      expect(esScopeDeDatos(scope)).toBe(false)
    }
  })
})

describe('PERMISSION_MATRIX — reglas de negocio que no se pueden romper', () => {
  it('solo admin puede administrar usuarios', () => {
    for (const role of ROLES) {
      const tiene = PERMISSION_MATRIX[role].some((r) => r.resource === 'usuarios')
      expect(tiene).toBe(role === 'admin')
    }
  })

  it('solo admin y contador ven la auditoría', () => {
    for (const role of ROLES) {
      const tiene = PERMISSION_MATRIX[role].some((r) => r.resource === 'auditoria')
      expect(tiene).toBe(role === 'admin' || role === 'contador')
    }
  })

  it('solo admin puede anular una venta ya verificada', () => {
    for (const role of ROLES) {
      const tiene = PERMISSION_MATRIX[role].some((r) => r.action === 'anular_verificada')
      expect(tiene).toBe(role === 'admin')
    }
  })

  it('solo admin administra el catálogo — RN-CAT-06', () => {
    for (const accion of ['crear', 'editar', 'editar_precios', 'desactivar'] as const) {
      for (const role of ROLES) {
        const puede = PERMISSION_MATRIX[role].some(
          (r) => r.resource === 'productos' && r.action === accion,
        )
        expect(puede, `${role} no debería poder productos:${accion}`).toBe(role === 'admin')
      }
    }
  })

  it('los cuatro roles leen el catálogo — un pos que no ve precios no puede vender', () => {
    for (const role of ROLES) {
      const ve = PERMISSION_MATRIX[role].some(
        (r) => r.resource === 'productos' && r.action === 'ver',
      )
      expect(ve, `${role} debería poder ver el catálogo`).toBe(true)
    }
  })

  it('solo admin puede editar precios', () => {
    for (const role of ROLES) {
      const tiene = PERMISSION_MATRIX[role].some((r) => r.action === 'editar_precios')
      expect(tiene).toBe(role === 'admin')
    }
  })

  it('cargar stock a ruta es de admin y pos: el seller no está en la planta', () => {
    for (const role of ROLES) {
      const tiene = PERMISSION_MATRIX[role].some((r) => r.action === 'cargar_ruta')
      expect(tiene).toBe(role === 'admin' || role === 'pos')
    }
  })

  it('el seller nunca ajusta stock ni insumos', () => {
    const ajustes = PERMISSION_MATRIX.seller.filter((r) => r.action === 'ajustar')
    expect(ajustes).toHaveLength(0)
  })

  it('el pos ve stock solo de BODEGA, no de las rutas', () => {
    const stockVer = PERMISSION_MATRIX.pos.find(
      (r) => r.resource === 'stock' && r.action === 'ver',
    )
    expect(stockVer?.scope).toBe('BODEGA')
  })

  it('el contador NO ve tanques — el doc de dominio lo marca ❌', () => {
    const tanques = PERMISSION_MATRIX.contador.filter((r) => r.resource === 'tanques')
    expect(tanques).toHaveLength(0)
  })

  it('el pos toca configuración solo por equivalencias, no en general', () => {
    const config = PERMISSION_MATRIX.pos.filter((r) => r.resource === 'configuracion')
    expect(config.map((r) => r.action)).toEqual(['equivalencias'])
  })

  it('el seller no toca configuración de ninguna forma', () => {
    expect(PERMISSION_MATRIX.seller.filter((r) => r.resource === 'configuracion')).toHaveLength(0)
  })

  it('solo admin y contador acceden a reportes financieros', () => {
    for (const role of ROLES) {
      const tiene = PERMISSION_MATRIX[role].some((r) => r.action === 'financieros')
      expect(tiene).toBe(role === 'admin' || role === 'contador')
    }
  })
})
