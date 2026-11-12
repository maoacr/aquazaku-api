import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { type Ejecutor, db, enTransaccion } from '@/db/client'
import {
  type MovimientoDeDinero,
  cuentasDeDinero,
  movimientosDeDinero,
  proveedores,
} from '@/db/schema'
import { hoyEnLaPlanta } from '@/lib/dia'
import { ErrorDeNegocio } from '@/lib/errors'
import { LARGO_MINIMO_MOTIVO, motivoEsSuficiente } from '@/lib/motivos'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'
import { aCentavos, aMonto } from '@/modules/ventas/precio'
import { bloquearCuenta, saldoDe } from './cuentas'

/**
 * El libro de dinero — M17.
 *
 * ── Todo peso pasa por acá ──────────────────────────────────────────────────
 *
 * Un gasto, un ingreso y un saldo inicial son la MISMA escritura con distinto
 * tipo: una fila en el libro contra una cuenta. Por eso no hay tres servicios
 * ni tres tablas — hay un `registrar()` privado y tres puertas que le dicen qué
 * tipo es, con la validación que cada una necesita.
 *
 * Lo que las separa no es cómo se escriben, es qué se les exige: un egreso no
 * puede dejar la cuenta en negativo, un saldo inicial solo se carga una vez, y
 * solo el egreso lleva proveedor y factura.
 */

/** Los tipos que el tramo 1 sabe escribir. Traslados y arqueos son el tramo 2. */
type TipoEscribible = 'egreso' | 'ingreso' | 'saldo_inicial'

export interface DatosDeEgreso {
  cuentaId: string
  tipoDeEgreso:
    | 'energia'
    | 'acueducto'
    | 'gas'
    | 'internet'
    | 'arriendo'
    | 'nomina'
    | 'software'
    | 'servicio'
    | 'repuesto'
    | 'mantenimiento'
    | 'litografia'
    | 'impuesto'
    | 'equipo'
    | 'mueble'
    | 'transporte'
    | 'comision_bancaria'
    | 'otro'
  monto: string
  /** Cuándo OCURRIÓ. No puede ser futuro: un gasto futuro no ocurrió. */
  ocurridoEl: string
  concepto: string
  /** A quién se le pagó, si ya está registrado como proveedor. */
  proveedorId?: string
  /** A quién se le pagó cuando no es un proveedor del sistema. */
  beneficiario?: string
  numeroDeFactura?: string
}

export interface DatosDeIngreso {
  cuentaId: string
  tipoDeIngreso:
    | 'aporte_socio'
    | 'prestamo'
    | 'recaudo_de_ventas'
    | 'devolucion_de_proveedor'
    | 'otro'
  monto: string
  ocurridoEl: string
  concepto: string
}

export interface DatosDeSaldoInicial {
  cuentaId: string
  monto: string
  /** El día en que se contó la plata. */
  ocurridoEl: string
  concepto: string
}

/**
 * Un gasto — la razón de ser del módulo.
 *
 * ── Por qué no puede dejar la cuenta en negativo ────────────────────────────
 *
 * Una caja con saldo negativo no existe: no se puede sacar de un cajón plata que
 * no está. Si el sistema lo permite, el número deja de ser conciliable contra lo
 * que hay físicamente, y entonces el módulo no sirve para lo único que tiene que
 * servir. Cuando de verdad «quedó en negativo», lo que falta es un ingreso sin
 * registrar — y el error lo dice así, para que se registre eso en vez de tapar
 * el hueco.
 */
export async function registrarEgreso(
  datos: DatosDeEgreso,
  registradoPor: string | null,
  contexto: ContextoDeAuditoria,
  ejecutor: Ejecutor = db,
): Promise<MovimientoDeDinero> {
  const centavos = montoValido(datos.monto)
  fechaNoFutura(datos.ocurridoEl)

  return enTransaccion(ejecutor, async (tx) => {
    const cuenta = await bloquearCuenta(datos.cuentaId, tx)

    if (datos.proveedorId) {
      const [proveedor] = await tx
        .select()
        .from(proveedores)
        .where(eq(proveedores.id, datos.proveedorId))

      if (!proveedor) {
        throw new ErrorDeNegocio('PROVEEDOR_NO_ENCONTRADO', 404, 'ese proveedor no existe')
      }

      if (!proveedor.activo) {
        throw new ErrorDeNegocio(
          'PROVEEDOR_INACTIVO',
          422,
          `${proveedor.nombre} está desactivado. Si se le volvió a pagar, actívelo primero`,
        )
      }
    }

    /*
     * El saldo se vuelve a sumar ACÁ, con la cuenta ya bloqueada. Leerlo antes
     * del `FOR UPDATE` dejaría la ventana clásica: dos egresos comprueban contra
     * el mismo saldo y los dos pasan.
     */
    const saldo = await saldoDe(datos.cuentaId, tx)

    if (saldo - centavos < 0) {
      throw new ErrorDeNegocio(
        'SALDO_INSUFICIENTE',
        422,
        `${cuenta.nombre} tiene ${aMonto(saldo)} y el gasto es de ${aMonto(centavos)}. Una caja no queda en negativo: si la plata salió de ahí, falta registrar de dónde entró`,
      )
    }

    const movimiento = await escribir(
      tx,
      {
        cuentaId: datos.cuentaId,
        tipo: 'egreso',
        monto: aMonto(centavos),
        ocurridoEl: datos.ocurridoEl,
        concepto: datos.concepto.trim(),
        tipoDeEgreso: datos.tipoDeEgreso,
        proveedorId: datos.proveedorId ?? null,
        beneficiario: datos.beneficiario?.trim() || null,
        numeroDeFactura: datos.numeroDeFactura?.trim() || null,
      },
      registradoPor,
    )

    await auditar(tx, contexto, 'gastos:crear', movimiento, {
      operacion: 'egreso',
      tipoDeEgreso: movimiento.tipoDeEgreso,
      cuenta: cuenta.nombre,
      /* El saldo que queda va en la fila: es lo que se concilia después. */
      saldoResultante: aMonto(saldo - centavos),
    })

    return movimiento
  })
}

/** Plata que entra y no es una venta del día registrada en M6. */
export async function registrarIngreso(
  datos: DatosDeIngreso,
  registradoPor: string | null,
  contexto: ContextoDeAuditoria,
  ejecutor: Ejecutor = db,
): Promise<MovimientoDeDinero> {
  const centavos = montoValido(datos.monto)
  fechaNoFutura(datos.ocurridoEl)

  return enTransaccion(ejecutor, async (tx) => {
    const cuenta = await bloquearCuenta(datos.cuentaId, tx)

    const movimiento = await escribir(
      tx,
      {
        cuentaId: datos.cuentaId,
        tipo: 'ingreso',
        monto: aMonto(centavos),
        ocurridoEl: datos.ocurridoEl,
        concepto: datos.concepto.trim(),
        tipoDeIngreso: datos.tipoDeIngreso,
      },
      registradoPor,
    )

    await auditar(tx, contexto, 'gastos:crear', movimiento, {
      operacion: 'ingreso',
      tipoDeIngreso: movimiento.tipoDeIngreso,
      cuenta: cuenta.nombre,
      saldoResultante: aMonto((await saldoDe(datos.cuentaId, tx)) ),
    })

    return movimiento
  })
}

/**
 * La plata que ya había cuando la cuenta entró al sistema.
 *
 * ── Una sola vez por cuenta ─────────────────────────────────────────────────
 *
 * Cargarlo dos veces es la plata del negocio contada dos veces, y el
 * consolidado queda inflado sin una sola fila falsa que lo delate: las dos son
 * legítimas por separado. Lo impide un índice único parcial, y acá se explica
 * por qué en vez de dejar que llegue el error del índice.
 *
 * Si se cargó mal, se anula y se vuelve a cargar — el índice excluye los
 * anulados justamente para eso.
 */
export async function registrarSaldoInicial(
  datos: DatosDeSaldoInicial,
  registradoPor: string | null,
  contexto: ContextoDeAuditoria,
  ejecutor: Ejecutor = db,
): Promise<MovimientoDeDinero> {
  const centavos = montoValido(datos.monto)
  fechaNoFutura(datos.ocurridoEl)

  return enTransaccion(ejecutor, async (tx) => {
    const cuenta = await bloquearCuenta(datos.cuentaId, tx)

    const [yaHay] = await tx
      .select({ id: movimientosDeDinero.id })
      .from(movimientosDeDinero)
      .where(
        and(
          eq(movimientosDeDinero.cuentaId, datos.cuentaId),
          eq(movimientosDeDinero.tipo, 'saldo_inicial'),
          eq(movimientosDeDinero.anulado, false),
        ),
      )

    if (yaHay) {
      throw new ErrorDeNegocio(
        'SALDO_INICIAL_YA_CARGADO',
        422,
        `${cuenta.nombre} ya tiene su saldo inicial cargado. Cargarlo de nuevo contaría la misma plata dos veces: si el primero estaba mal, anúlelo y vuelva a cargarlo`,
      )
    }

    const movimiento = await escribir(
      tx,
      {
        cuentaId: datos.cuentaId,
        tipo: 'saldo_inicial',
        monto: aMonto(centavos),
        ocurridoEl: datos.ocurridoEl,
        concepto: datos.concepto.trim(),
      },
      registradoPor,
    )

    await auditar(tx, contexto, 'gastos:crear', movimiento, {
      operacion: 'saldo_inicial',
      cuenta: cuenta.nombre,
      saldoResultante: aMonto(await saldoDe(datos.cuentaId, tx)),
    })

    return movimiento
  })
}

/**
 * Anular un movimiento — no se edita, se anula con motivo.
 *
 * ── Anular también puede descuadrar, y en la otra dirección ─────────────────
 *
 * El caso obvio es el gasto mal cargado: se anula y la plata vuelve al saldo.
 * El que se olvida es el inverso: anular un INGRESO de $500.000 del que ya se
 * gastaron $400.000 dejaría la cuenta en −$400.000. La plata se gastó de verdad;
 * lo que está mal es creer que ese ingreso no existió.
 *
 * Por eso la anulación comprueba el saldo resultante igual que un egreso. Es la
 * misma regla —ninguna cuenta queda en negativo— aplicada al revés.
 */
export async function anularMovimiento(
  movimientoId: string,
  motivo: string,
  contexto: ContextoDeAuditoria,
  ejecutor: Ejecutor = db,
): Promise<MovimientoDeDinero> {
  if (!motivoEsSuficiente(motivo)) {
    throw new ErrorDeNegocio(
      'MOTIVO_INSUFICIENTE',
      422,
      `anular un movimiento de plata necesita un motivo de al menos ${LARGO_MINIMO_MOTIVO} caracteres: es lo que va a explicar el descuadre dentro de tres meses`,
    )
  }

  return enTransaccion(ejecutor, async (tx) => {
    const [movimiento] = await tx
      .select()
      .from(movimientosDeDinero)
      .where(eq(movimientosDeDinero.id, movimientoId))

    if (!movimiento) {
      throw new ErrorDeNegocio('MOVIMIENTO_NO_ENCONTRADO', 404, 'ese movimiento no existe')
    }

    if (movimiento.anulado) {
      throw new ErrorDeNegocio(
        'MOVIMIENTO_YA_ANULADO',
        422,
        'ese movimiento ya está anulado: ya está fuera del saldo',
      )
    }

    if (movimiento.tipo === 'traslado_salida' || movimiento.tipo === 'traslado_entrada') {
      /*
       * Anular una sola pata rompería la única cosa que hace correcto un
       * traslado: que las dos sumen cero. Cuando exista la ruta de traslados, va
       * a anular las dos juntas; hasta entonces, no hay cómo producirlos.
       */
      throw new ErrorDeNegocio(
        'TRASLADO_NO_SE_ANULA_A_MEDIAS',
        422,
        'un traslado se anula completo, por las dos cuentas a la vez: anular una sola pata haría aparecer o desaparecer plata',
      )
    }

    /* La cuenta se bloquea aunque no se le escriba: el saldo se va a decidir. */
    const cuenta = await bloquearCuenta(movimiento.cuentaId, tx)
    const saldo = await saldoDe(movimiento.cuentaId, tx)
    const efecto = aCentavos(movimiento.efecto ?? '0')

    if (saldo - efecto < 0) {
      throw new ErrorDeNegocio(
        'ANULAR_DEJARIA_SALDO_NEGATIVO',
        422,
        `anular eso dejaría ${cuenta.nombre} en ${aMonto(saldo - efecto)}. La plata ya se movió: si este movimiento no debió existir, primero hay que corregir lo que se hizo con ella`,
      )
    }

    const [anulado] = await tx
      .update(movimientosDeDinero)
      .set({ anulado: true, motivoAnulacion: motivo.trim() })
      .where(eq(movimientosDeDinero.id, movimientoId))
      .returning()

    await auditar(tx, contexto, 'gastos:anular', anulado!, {
      operacion: 'anulacion',
      motivo: motivo.trim(),
      cuenta: cuenta.nombre,
      /* El efecto que se revierte, para que la fila se lea sin ir a buscar nada. */
      efectoRevertido: aMonto(efecto),
      saldoResultante: aMonto(saldo - efecto),
    })

    return anulado!
  })
}

/**
 * El pago de una compra a proveedor — RN-GAS-11.
 *
 * ── Se llama DESDE la transacción de la compra, no desde una ruta ───────────
 *
 * No tiene ruta propia a propósito. La plata de una compra sale en el mismo
 * acto en que entra la mercadería, igual que el inventario: separarlos dejaría
 * que alguien registre la compra y se olvide del pago, y entonces la caja del
 * sistema diría más plata de la que hay. Es el mismo argumento por el que
 * `registrarCompra` escribe el documento y el movimiento de inventario juntos.
 *
 * Por eso recibe la transacción abierta y NO abre la suya: si la compra falla
 * después, el pago se va con ella.
 *
 * ── Qué valida, y qué no ────────────────────────────────────────────────────
 *
 * Valida lo mismo que un egreso: cuenta activa y saldo suficiente. Que la
 * compra exista y cuánto vale lo sabe quien la está escribiendo, y volver a
 * consultarlo acá sería leer dos veces el mismo dato adentro de la misma
 * transacción.
 *
 * Que una compra no se pague dos veces lo garantiza el índice único de la base,
 * no un chequeo acá: el caso que importa es el reintento del formulario, y ahí
 * dos peticiones corren en paralelo.
 */
export async function registrarPagoDeCompra(
  tx: Ejecutor,
  datos: {
    compraId: string
    cuentaId: string
    /** El total congelado de la compra — RN-PRO-04. */
    monto: string
    ocurridoEl: string
    /** Quién cobró, para que la fila del libro se lea sola. */
    proveedor: string
  },
  registradoPor: string | null,
  contexto: ContextoDeAuditoria,
): Promise<MovimientoDeDinero> {
  const centavos = montoValido(datos.monto)
  const cuenta = await bloquearCuenta(datos.cuentaId, tx)
  const saldo = await saldoDe(datos.cuentaId, tx)

  if (saldo - centavos < 0) {
    throw new ErrorDeNegocio(
      'SALDO_INSUFICIENTE',
      422,
      `${cuenta.nombre} tiene ${aMonto(saldo)} y la compra es de ${aMonto(centavos)}. Una caja no queda en negativo: si la plata salió de ahí, falta registrar de dónde entró`,
    )
  }

  const [movimiento] = await tx
    .insert(movimientosDeDinero)
    .values({
      cuentaId: datos.cuentaId,
      tipo: 'egreso',
      monto: aMonto(centavos),
      ocurridoEl: datos.ocurridoEl,
      concepto: `Compra a ${datos.proveedor}`,
      compraRelacionada: datos.compraId,
      registradoPor,
    })
    .returning()

  await auditar(tx, contexto, 'gastos:crear', movimiento!, {
    operacion: 'pago_de_compra',
    compraRelacionada: datos.compraId,
    cuenta: cuenta.nombre,
    saldoResultante: aMonto(saldo - centavos),
  })

  return movimiento!
}

export interface FiltrosDelLibro {
  cuentaId?: string
  desde?: string
  hasta?: string
  tipo?: TipoEscribible
  /** Los anulados quedan fuera salvo que se los pida: no mueven plata. */
  incluirAnulados?: boolean
}

export interface FilaDelLibro {
  id: string
  cuentaId: string
  cuenta: string
  tipo: string
  monto: string
  efecto: string
  ocurridoEl: string
  concepto: string
  tipoDeEgreso: string | null
  tipoDeIngreso: string | null
  proveedor: string | null
  beneficiario: string | null
  /** El id de la compra que paga, si es el pago de una compra — RN-GAS-11. */
  compraRelacionada: string | null
  numeroDeFactura: string | null
  anulado: boolean
  motivoAnulacion: string | null
  createdAt: Date
}

/**
 * El libro, filtrado.
 *
 * `leftJoin` sobre proveedores y no `innerJoin`: la mayoría de los gastos no
 * tienen proveedor registrado, y un `innerJoin` los dejaría afuera de la lista
 * sin que nada falle. El nombre viaja resuelto para que la pantalla no haga una
 * consulta por fila.
 */
export async function listarMovimientos(filtros: FiltrosDelLibro = {}): Promise<FilaDelLibro[]> {
  const condiciones = [
    filtros.cuentaId ? eq(movimientosDeDinero.cuentaId, filtros.cuentaId) : undefined,
    filtros.desde ? gte(movimientosDeDinero.ocurridoEl, filtros.desde) : undefined,
    filtros.hasta ? lte(movimientosDeDinero.ocurridoEl, filtros.hasta) : undefined,
    filtros.tipo ? eq(movimientosDeDinero.tipo, filtros.tipo) : undefined,
    filtros.incluirAnulados ? undefined : eq(movimientosDeDinero.anulado, false),
  ].filter((c) => c !== undefined)

  const filas = await db
    .select({
      m: movimientosDeDinero,
      cuenta: cuentasDeDinero.nombre,
      proveedor: proveedores.nombre,
    })
    .from(movimientosDeDinero)
    .innerJoin(cuentasDeDinero, eq(cuentasDeDinero.id, movimientosDeDinero.cuentaId))
    .leftJoin(proveedores, eq(proveedores.id, movimientosDeDinero.proveedorId))
    .where(condiciones.length > 0 ? and(...condiciones) : undefined)
    /*
     * Por fecha del hecho, y `created_at` desempata. Sin el segundo criterio,
     * dos movimientos del mismo día salen en el orden que el planner elija y la
     * lista cambia de una carga a la otra.
     */
    .orderBy(desc(movimientosDeDinero.ocurridoEl), desc(movimientosDeDinero.createdAt))

  return filas.map((f) => ({
    id: f.m.id,
    cuentaId: f.m.cuentaId,
    cuenta: f.cuenta,
    tipo: f.m.tipo,
    monto: f.m.monto,
    efecto: f.m.efecto ?? '0.00',
    ocurridoEl: f.m.ocurridoEl,
    concepto: f.m.concepto,
    tipoDeEgreso: f.m.tipoDeEgreso,
    tipoDeIngreso: f.m.tipoDeIngreso,
    proveedor: f.proveedor,
    beneficiario: f.m.beneficiario,
    compraRelacionada: f.m.compraRelacionada,
    numeroDeFactura: f.m.numeroDeFactura,
    anulado: f.m.anulado,
    motivoAnulacion: f.m.motivoAnulacion,
    createdAt: f.m.createdAt,
  }))
}

export interface GastoPorTipo {
  tipoDeEgreso: string
  total: string
  cuantos: number
}

/**
 * En qué se gastó la plata del período — la pregunta que el módulo vino a
 * contestar.
 *
 * Los anulados no entran: nunca movieron plata. Y solo los egresos, porque la
 * pregunta es «en qué se gastó», no «qué pasó» — para eso está el libro.
 */
export async function gastosPorTipo(desde: string, hasta: string): Promise<GastoPorTipo[]> {
  const filas = await db
    .select({
      tipoDeEgreso: movimientosDeDinero.tipoDeEgreso,
      /* `ABS` porque el efecto de un egreso es negativo y acá se lista cuánto
       * se gastó, no cuánto bajó el saldo. */
      total: sql<string>`ABS(SUM(${movimientosDeDinero.efecto}))::text`,
      cuantos: sql<string>`COUNT(*)::text`,
    })
    .from(movimientosDeDinero)
    .where(
      and(
        eq(movimientosDeDinero.tipo, 'egreso'),
        eq(movimientosDeDinero.anulado, false),
        gte(movimientosDeDinero.ocurridoEl, desde),
        lte(movimientosDeDinero.ocurridoEl, hasta),
      ),
    )
    .groupBy(movimientosDeDinero.tipoDeEgreso)
    .orderBy(desc(sql`ABS(SUM(${movimientosDeDinero.efecto}))`), movimientosDeDinero.tipoDeEgreso)

  return filas.map((f) => ({
    tipoDeEgreso: f.tipoDeEgreso!,
    total: Number(f.total).toFixed(2),
    cuantos: Number(f.cuantos),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Lo que las tres puertas comparten
// ─────────────────────────────────────────────────────────────────────────────

function montoValido(monto: string): number {
  const centavos = aCentavos(monto)

  if (centavos <= 0) {
    throw new ErrorDeNegocio(
      'MONTO_INVALIDO',
      422,
      'un movimiento de cero no mueve plata. El signo lo pone el tipo, así que el monto va en positivo',
    )
  }

  return centavos
}

/**
 * Un movimiento no puede haber ocurrido mañana.
 *
 * Se compara contra `hoyEnLaPlanta()` y no contra `CURRENT_DATE`: la base corre
 * en UTC en producción, así que después de las 19:00 de Colombia un `CHECK`
 * contra la fecha del servidor rechazaría un gasto de hoy por «futuro». Es el
 * mismo bug que `lib/dia.ts` documenta para los reportes.
 */
function fechaNoFutura(ocurridoEl: string): void {
  const hoy = hoyEnLaPlanta()

  if (ocurridoEl > hoy) {
    throw new ErrorDeNegocio(
      'FECHA_FUTURA',
      422,
      `${ocurridoEl} todavía no pasó: hoy es ${hoy}. Un movimiento se registra cuando la plata se movió, no antes`,
    )
  }
}

async function escribir(
  tx: Ejecutor,
  valores: {
    cuentaId: string
    tipo: TipoEscribible
    monto: string
    ocurridoEl: string
    concepto: string
    tipoDeEgreso?: DatosDeEgreso['tipoDeEgreso']
    tipoDeIngreso?: DatosDeIngreso['tipoDeIngreso']
    proveedorId?: string | null
    beneficiario?: string | null
    numeroDeFactura?: string | null
  },
  registradoPor: string | null,
): Promise<MovimientoDeDinero> {
  const [movimiento] = await tx
    .insert(movimientosDeDinero)
    .values({ ...valores, registradoPor })
    .returning()

  return movimiento!
}

/**
 * La fila de la bitácora, dentro de la misma transacción — ADR-0007.
 *
 * Un movimiento de dinero es una acción sensible: es plata que entra o sale. El
 * `payload` lleva el saldo resultante porque es el número con el que se
 * reconstruye un descuadre; sin él, la bitácora dice que algo se movió pero no
 * contra qué saldo, que es justo lo que se quiere saber meses después.
 */
async function auditar(
  tx: Ejecutor,
  contexto: ContextoDeAuditoria,
  action: 'gastos:crear' | 'gastos:anular',
  movimiento: MovimientoDeDinero,
  extra: Record<string, unknown>,
): Promise<void> {
  await emit(
    {
      ...contexto,
      action,
      resource: 'gastos',
      resourceId: movimiento.id,
      result: 'ok',
      payload: {
        resourceId: movimiento.id,
        cuentaId: movimiento.cuentaId,
        tipo: movimiento.tipo,
        monto: movimiento.monto,
        ocurridoEl: movimiento.ocurridoEl,
        concepto: movimiento.concepto,
        ...extra,
      },
    },
    tx,
  )
}
