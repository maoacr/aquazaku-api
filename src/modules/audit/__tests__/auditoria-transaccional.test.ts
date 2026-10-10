import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Una acción sensible y su fila de auditoría son UNA escritura — ADR-0007.
 *
 * La ADR decide que una acción sensible sin bitácora **no se ejecuta**. Eso no
 * se cumple emitiendo después del commit: si el `INSERT` en `audit_log` falla
 * ahí, el cambio ya está aplicado y lo único que se puede devolver es un 500
 * sobre algo que SÍ ocurrió. El estado real y lo que la persona cree quedan en
 * desacuerdo, que es peor que no auditar.
 *
 * La única forma de que «no se ejecuta» sea verdad es que las dos escrituras
 * compartan transacción, y por eso `emit` acepta un ejecutor.
 *
 * ── Por qué un guardián y no un test de rollback por módulo ─────────────────
 *
 * Probar el rollback de verdad exige hacer fallar la bitácora, y el modo de
 * falla NO es transferible entre módulos: en `clientes` un `user_id` inválido
 * rompe solo el `INSERT` de auditoría, pero en `stock` ese mismo dato viaja a
 * `movimientos_stock.registrado_por` —uuid con foránea— y rompe el CAMBIO
 * antes de llegar a la bitácora. Cinco tests escritos así pasaron en verde
 * ANTES del refactor: no probaban atomicidad, probaban que el cambio se rompe
 * solo.
 *
 * Un test que pasa antes del arreglo no es un test, es un adorno.
 *
 * Este guardián da otra cosa: garantía ESTRUCTURAL. No prueba que el rollback
 * funcione —eso ya se probó una vez, en `authz/__tests__/audit.test.ts`, que es
 * donde corresponde— sino que cada acción sensible esté del lado correcto. Y
 * falla en el momento en que alguien escribe la próxima del lado equivocado,
 * que es cuando sirve.
 *
 * ── La lista también es el registro de la deuda ─────────────────────────────
 *
 * Mientras haya archivos en `false`, esta tabla dice exactamente qué falta. No
 * se puede migrar uno y olvidarse de actualizarla: el test falla en las dos
 * direcciones. Y no se puede agregar un emit `ok` en un archivo nuevo sin
 * declararlo.
 */

const MODULOS = join(import.meta.dirname, '../..')

/**
 * Dónde vive el emit `ok` de cada acción sensible, y si ya es atómico.
 *
 * La clave es el ARCHIVO y no la acción, porque no todos los emits nombran su
 * acción con un literal: el de `stock` vive en un helper que la recibe por
 * parámetro. Un guardián que buscara `action: '...'` se saltearía justamente
 * ese — el mismo error que ya me costó contar 7 acciones donde había 10.
 */
const EMITE_EL_CAMBIO: Record<string, { transaccional: boolean; acciones: string[]; nota: string }> =
  {
    'clientes/credito.ts': {
      transaccional: true,
      acciones: ['clientes:habilitar_credito'],
      nota: 'el UPDATE y la fila van en la misma transacción; el contexto es parámetro obligatorio',
    },
    'ventas/anulacion.ts': {
      transaccional: true,
      acciones: ['ventas:anular'],
      nota: 'la fila va dentro de la transacción que revierte; el payload lo arma el servicio porque es el único que sabe qué se revirtió',
    },
    'ventas/correccion.ts': {
      transaccional: true,
      acciones: ['ventas:corregir'],
      nota: 'corregir anula y reemplaza: es una anulación con otro nombre, y se decidió sensible junto con ella; la fila lleva el antes y el después y va en la transacción que escribe las dos ventas',
    },
    /*
     * ── Las tres que quedan acá NO son sensibles, y es una decisión ──────────
     *
     * Mao las clasificó el 10-oct-2026, con la consecuencia explicada: sensible
     * significa que si la bitácora falla, la operación no se hace.
     *
     * · `ventas:precio_manual` — los «cambios de precio» que nombra RN-ACC-04
     *   son los del CATÁLOGO, y esos ya son atómicos en `productos/service.ts`.
     *   Cobrar distinto en una venta suelta no frena el mostrador.
     * · `configuracion:editar` (códigos de descuento) — queda del lado no
     *   bloqueante aunque el costo de disponibilidad fuera bajo.
     * · `cobros:registrar`, `ventas:crear`, `ventas:crear_retroactiva` y
     *   `ventas:devolucion` — la regla no las nombra.
     *
     * No es deuda pendiente: está decidido. Si el negocio cambia de opinión,
     * se cambia acá y el guardián dice qué falta mover.
     */
    'ventas/routes.ts': {
      transaccional: false,
      acciones: [
        'ventas:crear',
        'ventas:crear_retroactiva',
        'ventas:precio_manual',
        'ventas:devolucion',
        'cobros:registrar',
        'configuracion:editar',
      ],
      nota: 'NO aplica: las acciones que quedan se clasificaron no sensibles el 10-oct-2026; `ventas:anular` está en `anulacion.ts` y `ventas:corregir` en `correccion.ts`',
    },
    'retornables/botellones.ts': {
      transaccional: true,
      acciones: ['botellones:descartar'],
      nota: 'el descarte es lo único que saca botellones del parque; la fila va con el movimiento, bajo el mismo candado que cuenta la bodega',
    },
    'retornables/bases.ts': {
      transaccional: true,
      acciones: ['bases:prestar', 'bases:retirar', 'bases:descartar'],
      nota: 'las tres emiten dentro de su transacción; `prestarBaseEn` queda SIN auditar porque la comparte la venta, que escribe su propia fila',
    },
    'retornables/dano.ts': {
      transaccional: true,
      acciones: ['bases:descartar'],
      nota: 'el daño comparte la acción con el descarte y los separa `operacion` en el payload; la fila va con el recargo, que es la venta que se le cobra al cliente',
    },
    /*
     * Las cuatro acciones que RN-ACC-04 nombra en este módulo —las dos bajas de
     * envases, el préstamo y el retiro de bases— se fueron a los servicios que
     * tienen la transacción. Lo que queda acá son compras, altas, y la entrega y
     * el retorno de botellones, que la regla no nombra.
     *
     * El ajuste del parque (`botellones:registrar` con `operacion: 'ajuste'`)
     * se preguntó y se decidió NO sensible el 10-oct-2026: los «ajustes de
     * stock» de RN-ACC-04 son los del producto, que ya son atómicos en
     * `stock/service.ts`. Está decidido, no pendiente.
     */
    'retornables/routes.ts': {
      transaccional: false,
      acciones: [
        'botellones:registrar',
        'botellones:entregar',
        'botellones:recibir_retorno',
        'bases:registrar',
      ],
      nota: 'NO aplica: ninguna de estas la nombra RN-ACC-04, y el ajuste del parque se clasificó no sensible el 10-oct-2026',
    },
    'produccion/cierre.ts': {
      transaccional: true,
      acciones: ['produccion:registrar_cierre'],
      nota: 'la escritura más grande del sistema —agua, insumos, botellones y producto en una transacción (RN-PRD-23)— y ahora la fila entra con ella. `atomicidad.test.ts` prueba que un cierre que falla tampoco la deja',
    },
    'produccion/agua.ts': {
      transaccional: true,
      acciones: ['tanques:ajustar'],
      nota: 'el ajuste es la única escritura que corrige el libro, y el libro es la ÚNICA fuente del saldo de agua (RN-PRD-14): no hay medidor con el que contrastarlo. `ajustarAgua` no tenía transacción; se le creó una y los dos `saldoDe` leen adentro',
    },
    /*
     * Queda `tanques:registrar_reposicion`, y no es deuda: RN-ACC-04 no la
     * nombra. Es el hecho de que llegó agua de la red, SIN cantidad, porque no
     * hay medidor ni regleta (RN-PRD-11) — el movimiento entra en cero litros y
     * el saldo sube después con un ajuste explícito, que sí es sensible y sí es
     * atómico.
     */
    'produccion/routes.ts': {
      transaccional: false,
      acciones: ['tanques:registrar_reposicion'],
      nota: 'NO aplica: la regla no nombra la reposición, y el hecho que registra no tiene cantidad que auditar',
    },
    'insumos/service.ts': {
      transaccional: true,
      acciones: ['insumos:ajustar'],
      nota: 'las cinco operaciones emiten dentro de su transacción; `registrarEntrada` queda como primitiva SIN auditar porque la comparte la compra a proveedor',
    },
    'stock/service.ts': {
      transaccional: true,
      acciones: ['stock:ajustar', 'stock:descartar'],
      nota: 'pendiente — su helper `auditar` ya dice «bloqueante», pero bloquear sin atomicidad es el PEOR caso: 500 con el cambio aplicado',
    },
    'productos/service.ts': {
      transaccional: true,
      acciones: [
        'productos:crear',
        'productos:editar',
        'productos:editar_precios',
        'productos:desactivar',
        'productos:reactivar',
      ],
      nota: 'las cinco emiten dentro de su transacción; el helper `auditar` de la ruta se fue con ellas',
    },
    /*
     * Eventos de SESIÓN — el segundo caso de la ADR, y queda afuera a
     * propósito: convertir una bitácora caída en imposibilidad de entrar
     * transforma un problema de registro en una caída total.
     */
    'auth/routes.ts': {
      transaccional: false,
      acciones: ['auth:login', 'auth:logout'],
      nota: 'NO aplica: son eventos de sesión, que la ADR deja explícitamente no bloqueantes',
    },
    'clientes/service.ts': {
      transaccional: true,
      acciones: ['clientes:crear', 'clientes:desactivar'],
      nota: 'el alta y la baja ya eran transaccionales; ahora la fila va adentro, y la baja la escribe con los conteos de bases y botellones devueltos',
    },
    'clientes/verificacion.ts': {
      transaccional: true,
      acciones: ['clientes:verificar_documento'],
      nota: 'verificar y revertir comparten acción y las separa `revertida` en el payload; el método sale del rol, no del request',
    },
    'proveedores/service.ts': {
      transaccional: true,
      acciones: ['proveedores:crear', 'proveedores:editar'],
      nota: 'el alta y el cambio de estado se clasificaron sensibles el 10-oct-2026: el NIT es lo que hace rastreable al proveedor en la contabilidad, y desactivar cierra la puerta a comprarle (RN-PRO-01). Ninguna de las dos tenía transacción: se les creó una para que la fila entre con el cambio',
    },
    'proveedores/compras.ts': {
      transaccional: true,
      acciones: ['compras:crear'],
      nota: 'una compra es dinero que sale; el registro y el pago comparten acción y los separa `operacion` en el payload. El total y el vencimiento van congelados (RN-PRO-04): son con lo que se concilia la deuda',
    },
    /*
     * El emit del middleware es el único que NO puede ser atómico, y está bien
     * así: corre en el `preHandler`, ANTES de que el cambio exista. Es la fila
     * genérica de las acciones que no se eximen — las sensibles llevan
     * `auditaLaRuta: true` y escriben la suya. Queda declarado para que la
     * lista siga siendo cerrada, no porque falte migrarlo.
     */
    'authz/middleware.ts': {
      transaccional: false,
      acciones: ['(la fila genérica de cualquier acción permitida)'],
      nota: 'NO aplica: emite antes del cambio, por diseño. No hay nada que migrar acá',
    },
    'alertas/parametros.ts': {
      transaccional: true,
      acciones: ['configuracion:editar'],
      nota: 'el UPDATE y la fila van en la misma transacción; el `antes` sale del mismo SELECT que valida el rango',
    },
  }

/**
 * Los argumentos de nivel superior de cada llamada a `emit(` del archivo.
 *
 * Balancear paréntesis y no usar una regex es a propósito: estos emits son
 * multilínea y traen objetos con paréntesis adentro (`req.user?.id ?? null`).
 * Una regex los corta en el lugar equivocado y el guardián miente — que es
 * exactamente lo que este archivo existe para evitar.
 */
type Llamada = { fn: 'emit' | 'auditarSinBloquear'; argumentos: string[] }

function llamadasDeAuditoria(fuente: string): Llamada[] {
  const llamadas: Llamada[] = []

  /*
   * Las DOS formas, porque la mitad del sistema audita con la envoltura. Buscar
   * solo `emit(` dejaba cuatro archivos de rutas como si no auditaran nada — y
   * el guardián los reportaba al revés, diciendo que el emit «se movió».
   */
  for (const fn of ['emit', 'auditarSinBloquear'] as const) {
   for (let i = fuente.indexOf(`${fn}(`); i !== -1; i = fuente.indexOf(`${fn}(`, i + 1)) {
    // El carácter anterior no puede ser parte de un identificador: así
    // `auditarSinBloquear(` no cuenta además como un `emit(`.
    if (i > 0 && /[A-Za-z0-9_$]/.test(fuente[i - 1]!)) continue

    let nivel = 0
    let desde = i + `${fn}(`.length
    const argumentos: string[] = []

    for (let j = desde; j < fuente.length; j++) {
      const c = fuente[j]
      if (c === '(' || c === '{' || c === '[') nivel++
      else if (c === ')' && nivel === 0) {
        argumentos.push(fuente.slice(desde, j))
        break
      } else if (c === ')' || c === '}' || c === ']') nivel--
      else if (c === ',' && nivel === 0) {
        argumentos.push(fuente.slice(desde, j))
        desde = j + 1
      }
    }

    llamadas.push({ fn, argumentos: argumentos.map((a) => a.trim()).filter((a) => a.length > 0) })
   }
  }

  return llamadas
}

/**
 * Los emits de un hecho que PUDO haber pasado.
 *
 * Los `denied` quedan afuera a propósito: la ADR los deja no bloqueantes,
 * porque si auditar un rechazo fallara y cortara, taparía el 403 o el 422 que
 * la persona necesita ver.
 *
 * ── Por qué «no es `denied`» y no «es `ok`» ─────────────────────────────────
 *
 * La primera versión buscaba el literal `result: 'ok'`, y eso dejaba pasar un
 * emit real: el helper de `insumos` escribe
 * `result: resultado.ok ? 'ok' : 'denied'` —porque un descarte que no alcanza
 * no movió nada— así que el literal no aparece y el guardián no lo veía.
 *
 * Ahora cuenta todo lo que NO sea `'denied'` literal. Falla hacia MÁS
 * vigilancia, que es la misma política que `debeAuditarseAlPermitir`: ante la
 * duda, se audita. Un guardián que se equivoca de menos no sirve para nada.
 *
 * `auditarSinBloquear` recibe el request primero, así que el objeto está en el
 * segundo argumento — de ahí el `some` sobre todos los argumentos.
 */
const emiteOk = (llamada: Llamada) =>
  llamada.argumentos.some((a) => /result:/.test(a) && !/result:\s*'denied'/.test(a))

/**
 * Atómico es `emit(datos, ejecutor)` y nada más.
 *
 * `auditarSinBloquear(req, datos)` también tiene dos argumentos, pero el
 * segundo es el objeto y la función **se traga los fallos** — nunca puede ser
 * atómica. Contar argumentos sin mirar la función daba un falso positivo justo
 * en los archivos que faltan migrar.
 */
const esAtomico = (llamada: Llamada) => llamada.fn === 'emit' && llamada.argumentos.length >= 2

describe('cada acción sensible emite dentro de la transacción de su cambio', () => {
  for (const [archivo, { transaccional, acciones, nota }] of Object.entries(EMITE_EL_CAMBIO)) {
    const titulo = transaccional ? 'es atómico' : 'NO es atómico todavía'

    it(`${archivo} — ${titulo} (${acciones.join(', ')})`, () => {
      const fuente = readFileSync(join(MODULOS, archivo), 'utf8')
      const deOk = llamadasDeAuditoria(fuente).filter(emiteOk)

      expect(deOk.length, `${archivo} no tiene ningún emit \`ok\`: ¿se movió? — ${nota}`).toBeGreaterThan(0)

      /*
       * Un segundo argumento es el ejecutor: la transacción del cambio. Sin él,
       * `emit` escribe con la conexión del pool y la fila sobrevive al rollback
       * — y con el pool en una sola conexión, se bloquea a sí mismo.
       */
      const conEjecutor = deOk.filter(esAtomico).length

      if (transaccional) {
        expect(conEjecutor, `${archivo}: hay emits \`ok\` sin el ejecutor — ${nota}`).toBe(deOk.length)
      } else {
        expect(
          conEjecutor,
          `${archivo} ya pasa el ejecutor: si se migró, poner \`transaccional: true\` en la lista — ${nota}`,
        ).toBe(0)
      }
    })
  }

  /*
   * La lista es CERRADA. Un archivo nuevo que emita un hecho consumado tiene
   * que venir acá y decir de qué lado está — igual que el opt-out. Olvidarse
   * deja de ser silencioso, que es todo el punto.
   */
  it('ningún archivo emite un hecho consumado sin estar en la lista', () => {
    const declarados = new Set(Object.keys(EMITE_EL_CAMBIO))
    const sinDeclarar: string[] = []

    const recorrer = (dir: string, relativo = '') => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (entrada.name === '__tests__') continue
        const rel = relativo ? `${relativo}/${entrada.name}` : entrada.name

        if (entrada.isDirectory()) {
          recorrer(join(dir, entrada.name), rel)
          continue
        }
        if (!entrada.name.endsWith('.ts')) continue

        const fuente = readFileSync(join(dir, entrada.name), 'utf8')
        if (llamadasDeAuditoria(fuente).some(emiteOk) && !declarados.has(rel)) sinDeclarar.push(rel)
      }
    }

    recorrer(MODULOS)

    expect(sinDeclarar.sort()).toEqual([])
  })
})
