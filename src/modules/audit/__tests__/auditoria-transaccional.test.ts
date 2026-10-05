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
    'ventas/routes.ts': {
      transaccional: false,
      acciones: ['ventas:anular'],
      nota: 'pendiente — la anulación ya es transaccional en `anulacion.ts`, falta mover el emit adentro',
    },
    'retornables/routes.ts': {
      transaccional: false,
      acciones: ['botellones:descartar', 'bases:descartar'],
      nota: 'pendiente — dos bajas de envases, las dos nombradas por la ADR',
    },
    'produccion/routes.ts': {
      transaccional: false,
      acciones: ['tanques:ajustar', 'produccion:registrar_cierre'],
      nota: 'pendiente — el cierre ya es transaccional; `agua.ts` NO tiene transacción y hay que envolverlo',
    },
    'insumos/routes.ts': {
      transaccional: false,
      acciones: ['insumos:ajustar'],
      nota: 'pendiente — ojo con las rutas de movimiento: `descontar` devuelve `{ ok: false }` sin lanzar',
    },
    'stock/service.ts': {
      transaccional: true,
      acciones: ['stock:ajustar', 'stock:descartar'],
      nota: 'pendiente — su helper `auditar` ya dice «bloqueante», pero bloquear sin atomicidad es el PEOR caso: 500 con el cambio aplicado',
    },
    'productos/service.ts': {
      transaccional: false,
      acciones: ['productos:editar_precios'],
      nota: 'pendiente — este archivo no tiene transacción en ninguna parte; bloquea sin atomicidad',
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
    'clientes/routes.ts': {
      transaccional: false,
      acciones: ['clientes:crear', 'clientes:verificar_documento', 'clientes:desactivar'],
      nota: 'pendiente — `habilitar_credito` ya migró a `credito.ts`; estas tres siguen emitiendo desde la ruta',
    },
    'proveedores/routes.ts': {
      transaccional: false,
      acciones: ['proveedores:crear', 'proveedores:editar', 'compras:crear'],
      nota: 'pendiente — una compra es dinero que sale; el pago y el registro comparten acción',
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
    'alertas/routes.ts': {
      transaccional: false,
      acciones: ['configuracion:editar'],
      nota: 'pendiente — mover un umbral de alerta es configuración, y la fila dice de cuánto a cuánto',
    },
    'productos/routes.ts': {
      transaccional: false,
      acciones: ['productos:crear', 'productos:desactivar', 'productos:reactivar', 'productos:editar'],
      nota: 'pendiente — su helper `auditar` es bloqueante y corre después del cambio',
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
 * Solo los emits de un hecho que SÍ pasó. Los `denied` la ADR los deja afuera a
 * propósito: si auditar un rechazo fallara y cortara, taparía el 403 o el 422
 * que la persona necesita ver.
 *
 * `auditarSinBloquear` recibe el request primero, así que el objeto está en el
 * segundo argumento.
 */
const emiteOk = (llamada: Llamada) =>
  llamada.argumentos.some((a) => a.includes("result: 'ok'"))

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
