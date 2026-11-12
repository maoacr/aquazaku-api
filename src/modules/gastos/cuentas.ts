import { and, asc, eq, sql } from 'drizzle-orm'
import { type Ejecutor, db, enTransaccion } from '@/db/client'
import { type CuentaDeDinero, cuentasDeDinero, movimientosDeDinero } from '@/db/schema'
import { ErrorDeNegocio } from '@/lib/errors'
import { type ContextoDeAuditoria, emit } from '@/modules/authz/audit'

/**
 * Las cuentas donde vive la plata — M17.
 *
 * ── Las dos cajas no se crean: ya existen ───────────────────────────────────
 *
 * `Caja menor` y `Caja mayor` las siembra la migración 0030, porque no son una
 * preferencia: el negocio las tiene, y un módulo de tesorería sin ellas no
 * puede registrar nada. Nacen en cero — el saldo inicial lo carga quien cuente
 * la plata, y queda como un movimiento con su fecha en vez de un número
 * inventado en una migración.
 *
 * Lo que sí se crea desde la pantalla son las cuentas BANCARIAS, porque cuántas
 * hay y en qué banco solo lo sabe el negocio.
 */

export interface CuentaConSaldo extends CuentaDeDinero {
  /** `SUM(efecto)`. No existe como columna — ADR-0008. */
  saldo: string
}

/**
 * Las cuentas con su saldo, y el saldo no sale de una columna.
 *
 * ── Por qué un `GROUP BY` y no una consulta por cuenta ──────────────────────
 *
 * ADR-0008 avisa del costo de derivar: `cartera()` hace tres consultas por
 * cliente y con doscientos clientes son seiscientas. Acá el problema no llega a
 * existir porque las cuentas son pocas y conocidas, así que el libro entero se
 * agrupa de una sola vez. Es la salida que el propio ADR recomienda para
 * cuando duela, aplicada antes de que duela.
 *
 * `COALESCE` y no un `INNER JOIN`: una cuenta recién creada no tiene
 * movimientos, y sin esto desaparecería de la lista en vez de mostrar cero —
 * que es justo cuando hace falta verla para cargarle el saldo inicial.
 */
export async function cuentasConSaldo(incluirInactivas = false): Promise<CuentaConSaldo[]> {
  const filas = await db
    .select({
      cuenta: cuentasDeDinero,
      saldo: sql<string>`COALESCE(SUM(${movimientosDeDinero.efecto}), 0)::text`,
    })
    .from(cuentasDeDinero)
    .leftJoin(movimientosDeDinero, eq(movimientosDeDinero.cuentaId, cuentasDeDinero.id))
    .where(incluirInactivas ? undefined : eq(cuentasDeDinero.activa, true))
    .groupBy(cuentasDeDinero.id)
    /*
     * El orden es el de la lista en pantalla, y es estable: `tipo` ordena por
     * la posición del enum —caja menor, caja mayor, bancos— y el nombre
     * desempata entre bancos. Sin el segundo criterio, dos cuentas bancarias
     * podrían salir en distinto orden en dos cargas de la misma pantalla.
     */
    .orderBy(asc(cuentasDeDinero.tipo), asc(cuentasDeDinero.nombre))

  return filas.map((f) => ({ ...f.cuenta, saldo: Number(f.saldo).toFixed(2) }))
}

/**
 * El saldo de UNA cuenta.
 *
 * Existe aparte de `cuentasConSaldo` porque el servicio lo necesita adentro de
 * una transacción, con la cuenta ya bloqueada, para decidir si un egreso cabe.
 * Ahí no sirve una consulta que lea todas las cuentas por fuera de la tx.
 */
export async function saldoDe(cuentaId: string, ejecutor: Ejecutor = db): Promise<number> {
  const [fila] = await ejecutor
    .select({
      /* En centavos enteros: sumar `numeric` en Postgres es exacto, y el entero
       * sobrevive el viaje a JavaScript sin el redondeo binario del float. */
      centavos: sql<string>`COALESCE(SUM(ROUND(${movimientosDeDinero.efecto} * 100)), 0)::text`,
    })
    .from(movimientosDeDinero)
    .where(eq(movimientosDeDinero.cuentaId, cuentaId))

  return Number(fila?.centavos ?? 0)
}

export interface DatosDeCuentaBancaria {
  nombre: string
  banco: string
  numero: string
  tipoDeCuentaBancaria: 'ahorros' | 'corriente'
}

/**
 * Dar de alta una cuenta bancaria.
 *
 * Solo bancarias: las dos cajas ya existen y son únicas por índice. Pedir el
 * `tipo` acá dejaría que alguien intente crear una tercera caja y reciba un
 * error de índice único que no le explica nada.
 */
export async function crearCuentaBancaria(
  datos: DatosDeCuentaBancaria,
  contexto: ContextoDeAuditoria,
  ejecutor: Ejecutor = db,
): Promise<CuentaDeDinero> {
  return enTransaccion(ejecutor, async (tx) => {
    const [cuenta] = await tx
      .insert(cuentasDeDinero)
      .values({ ...datos, tipo: 'banco' })
      .returning()

    /*
     * Una cuenta nueva es dónde va a aterrizar plata: sin la fila, la bitácora
     * no puede contestar quién abrió la cuenta a la que se transfirió — ADR-0007.
     */
    await emit(
      {
        ...contexto,
        action: 'cuentas:crear',
        resource: 'cuentas',
        resourceId: cuenta!.id,
        result: 'ok',
        payload: {
          resourceId: cuenta!.id,
          nombre: cuenta!.nombre,
          tipo: cuenta!.tipo,
          banco: cuenta!.banco,
          numero: cuenta!.numero,
          tipoDeCuentaBancaria: cuenta!.tipoDeCuentaBancaria,
        },
      },
      tx,
    )

    return cuenta!
  })
}

/**
 * Activar o desactivar una cuenta — una sola ruta para los dos sentidos.
 *
 * ── Desactivar no es borrar, y una cuenta con plata no se desactiva ─────────
 *
 * Una cuenta inactiva deja de ofrecerse para registrar movimientos nuevos, pero
 * su historial sigue en el libro. Lo que NO puede pasar es que se esconda con
 * saldo: esa plata desaparecería del consolidado sin que nadie la haya movido, y
 * el total del negocio bajaría sin un movimiento que lo explique.
 *
 * Si la cuenta se cerró de verdad, primero se traslada el saldo a otra o se
 * registra el egreso que lo vació. Las dos cosas dejan el hecho escrito.
 */
export async function cambiarEstadoDeCuenta(
  cuentaId: string,
  activa: boolean,
  contexto: ContextoDeAuditoria,
  ejecutor: Ejecutor = db,
): Promise<CuentaDeDinero> {
  return enTransaccion(ejecutor, async (tx) => {
    const [cuenta] = await tx
      .select()
      .from(cuentasDeDinero)
      .where(eq(cuentasDeDinero.id, cuentaId))

    if (!cuenta) throw new ErrorDeNegocio('CUENTA_NO_ENCONTRADA', 404, 'esa cuenta no existe')

    if (cuenta.activa === activa) {
      throw new ErrorDeNegocio(
        'CUENTA_YA_ESTA_ASI',
        422,
        `${cuenta.nombre} ya está ${activa ? 'activa' : 'inactiva'}`,
      )
    }

    if (!activa) {
      if (cuenta.tipo !== 'banco') {
        throw new ErrorDeNegocio(
          'CAJA_NO_SE_DESACTIVA',
          422,
          `${cuenta.nombre} es una caja del negocio, no una cuenta que se abra y se cierre. Las dos cajas existen siempre`,
        )
      }

      const saldo = await saldoDe(cuentaId, tx)

      if (saldo !== 0) {
        throw new ErrorDeNegocio(
          'CUENTA_CON_SALDO',
          422,
          `${cuenta.nombre} tiene ${(saldo / 100).toFixed(2)} y una cuenta con plata no se puede esconder: el total del negocio bajaría sin un movimiento que lo explique. Traslade el saldo o registre el egreso que la vació`,
        )
      }
    }

    const [cambiada] = await tx
      .update(cuentasDeDinero)
      .set({ activa })
      .where(eq(cuentasDeDinero.id, cuentaId))
      .returning()

    await emit(
      {
        ...contexto,
        action: activa ? 'cuentas:editar' : 'cuentas:desactivar',
        resource: 'cuentas',
        resourceId: cambiada!.id,
        result: 'ok',
        payload: { resourceId: cambiada!.id, nombre: cambiada!.nombre, activa },
      },
      tx,
    )

    return cambiada!
  })
}

/**
 * La cuenta que un movimiento va a tocar, bloqueada para escribir.
 *
 * ── Por qué `FOR UPDATE` sobre una tabla sin saldo ──────────────────────────
 *
 * El saldo es derivado (ADR-0008), así que no se puede descontar con un
 * `UPDATE … WHERE saldo >= :n`. Pero el sobregiro sí hay que frenarlo: una caja
 * en negativo no existe en la vida real, y si el sistema la permite, el número
 * deja de ser conciliable contra la plata física.
 *
 * El bloqueo sobre la FILA DE LA CUENTA resuelve las dos cosas: dos egresos
 * contra la misma cuenta se serializan —el segundo espera y vuelve a sumar el
 * libro ya con el primero adentro— y no hace falta materializar nada. Es el
 * `UPDATE` condicional del ADR-0008 conseguido sin la columna que ese ADR
 * desaconseja.
 */
export async function bloquearCuenta(cuentaId: string, tx: Ejecutor): Promise<CuentaDeDinero> {
  const [cuenta] = await tx
    .select()
    .from(cuentasDeDinero)
    .where(and(eq(cuentasDeDinero.id, cuentaId)))
    .for('update')

  if (!cuenta) throw new ErrorDeNegocio('CUENTA_NO_ENCONTRADA', 404, 'esa cuenta no existe')

  if (!cuenta.activa) {
    throw new ErrorDeNegocio(
      'CUENTA_INACTIVA',
      422,
      `${cuenta.nombre} está inactiva. Si volvió a usarse, actívela primero: eso deja el hecho registrado en vez de contradecirlo en silencio`,
    )
  }

  return cuenta
}
