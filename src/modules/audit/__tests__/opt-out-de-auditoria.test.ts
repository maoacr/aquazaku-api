import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * El opt-out de auditoría se declara acá o no se declara.
 *
 * `requirePermission(r, a, { auditaLaRuta: true })` APAGA la fila `ok` del
 * middleware (`authz/middleware.ts`). El flag es una promesa: «yo, la ruta,
 * escribo esa fila con más detalle del que hay en el middleware».
 *
 * Cuando la promesa no se cumple, la acción sensible se ejecuta y no deja
 * rastro. Y nadie se entera, porque una bitácora a la que le falta una acción
 * se ve exactamente igual que una bitácora donde esa acción no pasó.
 *
 * Así se perdieron veinte acciones —`ventas:crear` entre ellas—: el único
 * `emit` de esos módulos vive dentro del manejador de errores y escribe
 * `denied`. La venta exitosa no aparecía; la venta RECHAZADA sí. La bitácora
 * mostraba exactamente lo contrario de lo que había pasado.
 *
 * Por eso el opt-out pasa a ser una lista cerrada. Agregar el flag a una ruta
 * nueva rompe este test, y para arreglarlo hay que venir acá y escribir dónde
 * se paga la promesa. Olvidarse deja de ser silencioso, que era el problema.
 */

const MODULOS = join(import.meta.dirname, '../..')

/**
 * Acciones que se auditan solas, y dónde.
 *
 * La clave es `módulo → acción` y no la acción sola: `configuracion:editar` lo
 * usan dos módulos, y solo uno de los dos cumple.
 */
const SE_AUDITAN_SOLAS: Record<string, string> = {
  'alertas → configuracion:editar':
    'alertas/routes.ts — emite con los umbrales viejos y nuevos',
  /*
   * El permiso es `clientes:editar` y la fila que escribe dice
   * `clientes:desactivar`, que es más preciso: desactivar es escribir una
   * columna, pero arrastra la devolución de bases y botellones.
   *
   * Los conteos son lo que la hace auditable tres meses después — «se desactivó
   * a la señora Gómez y volvieron 2 bases y 8 botellones» se lee de la fila, sin
   * cruzar `movimientos_base` con `movimientos_botellon`.
   */
  'clientes → clientes:editar':
    'clientes/routes.ts — emite `clientes:desactivar` con el motivo y los conteos devueltos',
  /*
   * Comprar y ajustar comparten el permiso, así que comparten el nombre de la
   * acción. Las separa `operacion` en el payload: una compra suma parque, un
   * ajuste corrige un conteo. Sin eso, «entraron 50» se lee igual que
   * «faltaban 50».
   */
  /*
   * Tres rutas comparten `bases:registrar`: el alta de una base concreta, la
   * compra de un lote y la CONSULTA del próximo código. Las dos primeras
   * emiten, separadas por `operacion`. La tercera se exime a propósito: es una
   * lectura pura, y sin la exención cada apertura del formulario de alta
   * dejaba una fila indistinguible de un alta de verdad.
   */
  'retornables → bases:registrar':
    'retornables/routes.ts — emite el alta y la compra, separadas por `operacion`; la consulta del próximo código se exime por ser lectura',
  'retornables → bases:prestar':
    'retornables/routes.ts — emite con la base y la DIRECCIÓN a la que fue',
  'retornables → bases:retirar': 'retornables/routes.ts — emite con la base que volvió',
  /* Dañar y descartar comparten permiso; una base dañada sigue existiendo. */
  'retornables → bases:descartar':
    'retornables/routes.ts — emite el daño y el descarte, separados por `operacion`',
  'retornables → botellones:registrar':
    'retornables/routes.ts — emite la compra y el ajuste, separados por `operacion`',
  'retornables → botellones:entregar':
    'retornables/routes.ts — emite con el cliente, la cantidad y los dos saldos',
  'retornables → botellones:recibir_retorno':
    'retornables/routes.ts — emite con el cliente, la cantidad y los dos saldos',
  'retornables → botellones:descartar':
    'retornables/routes.ts — emite con la cantidad, el motivo y lo que queda en bodega',
  'clientes → clientes:crear': 'clientes/routes.ts — emite con el nombre, el documento y el tipo',
  /*
   * Verificar y revertir comparten el permiso, así que comparten el nombre de
   * la acción. Las dos filas se distinguen por `revertida` en el payload: son
   * hechos opuestos y la bitácora tiene que poder decir cuál fue.
   */
  'clientes → clientes:verificar_documento':
    'clientes/routes.ts — emite con el método, y con `revertida` + motivo al revertir',
  'clientes → clientes:habilitar_credito':
    'clientes/routes.ts — emite con si quedó habilitado y con qué tope',
  'productos → productos:crear': 'productos/routes.ts — emite con código y nombre',
  'productos → productos:desactivar':
    'productos/routes.ts — emite `desactivar` y `reactivar` con el código',
  'productos → productos:editar_precios':
    'productos/service.ts — emite con los precios de antes y después',
  /*
   * Registrar la compra y marcarla pagada comparten `compras:crear` porque
   * comparten permiso. Las separa `operacion`: la primera abre una deuda, la
   * segunda la cierra. La TERCERA ruta del permiso —la consulta de lo vencido—
   * se exime a propósito: es una lectura pura, y sin la exención cada revisión
   * de lo que se le debe a los proveedores dejaba una fila que se lee como una
   * compra que nunca pasó.
   */
  /*
   * El agua es el único inventario que no se puede contar: no hay medidor ni
   * regleta (RN-PRD-11), así que el libro de los tanques es la única fuente y
   * un ajuste sin rastro vuelve el saldo una opinión.
   *
   * La reposición emite SIN litros a propósito — escribir el cero del
   * movimiento haría que la bitácora diga «entraron 0 litros», un número que
   * parece medido.
   */
  'produccion → tanques:registrar_reposicion':
    'produccion/routes.ts — emite con el tanque y el tipo, sin litros: no hay con qué medirlos',
  'produccion → tanques:ajustar':
    'produccion/routes.ts — emite con el delta CON SIGNO, el motivo y el saldo que quedó',
  'proveedores → compras:crear':
    'proveedores/routes.ts — emite el registro y el pago, separados por `operacion`; la consulta de lo vencido se exime por ser lectura',
  'proveedores → proveedores:crear':
    'proveedores/routes.ts — emite con el nombre, el NIT y el contacto',
  /* Activar y desactivar son la misma ruta con distinto valor (RN-PRO-01): el
   * payload dice en cuál quedó, porque desactivar cierra la puerta a comprarle
   * y reactivar la vuelve a abrir. */
  'proveedores → proveedores:editar':
    'proveedores/routes.ts — emite con el estado en que quedó el proveedor',
  'stock → stock:ajustar': 'stock/service.ts — emite con el lote y el delta',
  'stock → stock:descartar': 'stock/service.ts — emite con el lote y el motivo',
  'users → usuarios:crear': 'users/routes.ts — emite con el id nuevo y los roles',
  'users → usuarios:editar': 'users/routes.ts — emite con los campos que cambiaron',
  /*
   * La fila del middleware se escribe en el `preHandler`, ANTES de que la venta
   * exista: sale sin `resourceId` y sin `payload`. Medido en producción: 225
   * filas de `ventas:crear`, las 225 con las dos columnas en NULL.
   *
   * Decían «alguien con permiso intentó vender» y no cuál venta, ni si llegó a
   * hacerse. La ruta escribe la suya con el id, el total, el cliente y el medio
   * de pago.
   */
  'ventas → ventas:crear':
    'ventas/routes.ts — emite con el id de la venta, el total, el cliente y el medio de pago',
  'ventas → ventas:corregir': 'ventas/routes.ts — emite con el antes y el después',
  /*
   * El flag ya existía cuando se escribió el emit rico y se perdió en el
   * refactor de la corrección de ventas. Durante ese tiempo cada anulación dejó
   * DOS filas `ok`, y contarlas devolvía el doble.
   */
  'ventas → ventas:anular':
    'ventas/routes.ts — emite con el motivo y los botellones y la base revertidos',
  /*
   * Un cobro es inmutable. La fila del middleware decía que alguien con permiso
   * registró uno, sin monto, sin medio y sin cliente — nada con qué cuadrar la
   * caja.
   */
  'ventas → cobros:registrar':
    'ventas/routes.ts — emite con el monto, el medio, el cliente y la deuda que queda',
}

const DECLARA_OPT_OUT =
  /requirePermission\(\s*'([a-z_]+)',\s*'([a-z_]+)'\s*,\s*\{\s*auditaLaRuta:\s*true\s*\}/g

function declaracionesDe(modulo: string): string[] {
  const encontradas: string[] = []

  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (entrada === '__tests__') continue
      const ruta = join(dir, entrada)

      if (statSync(ruta).isDirectory()) {
        recorrer(ruta)
        continue
      }

      if (!entrada.endsWith('.ts')) continue

      for (const [, resource, action] of readFileSync(ruta, 'utf8').matchAll(DECLARA_OPT_OUT)) {
        encontradas.push(`${modulo} → ${resource}:${action}`)
      }
    }
  }

  recorrer(join(MODULOS, modulo))

  return encontradas
}

describe('el opt-out de auditoría es una lista cerrada', () => {
  it('ninguna ruta se exime de la bitácora sin estar declarada', () => {
    const declaradas = readdirSync(MODULOS)
      .filter((m) => statSync(join(MODULOS, m)).isDirectory())
      .flatMap(declaracionesDe)

    expect([...new Set(declaradas)].sort()).toEqual(Object.keys(SE_AUDITAN_SOLAS).sort())
  })
})
