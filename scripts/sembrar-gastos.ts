import { eq } from 'drizzle-orm'
import { closeDb, db } from '@/db/client'
import { cuentasDeDinero, movimientosDeDinero, proveedores } from '@/db/schema'
import { hoyEnLaPlanta } from '@/lib/dia'
import { crearCuentaBancaria, cuentasConSaldo } from '@/modules/gastos/cuentas'
import { registrarEgreso, registrarIngreso, registrarSaldoInicial } from '@/modules/gastos/libro'
import { aMonto } from '@/modules/ventas/precio'

/**
 * Doce meses de movimientos de plata, para ver el módulo con datos — M17.
 *
 * ── Pasa por los SERVICIOS, no por INSERT ───────────────────────────────────
 *
 * Cada movimiento se escribe con `registrarEgreso` / `registrarIngreso`, los
 * mismos que usa la pantalla. Así sembrar no es solo llenar tablas: es una
 * corrida real contra todas las validaciones —saldo suficiente, fecha no
 * futura, cuenta activa, saldo inicial único— y contra los invariantes de la
 * base. Si el seed termina, el módulo funciona de punta a punta.
 *
 * Un INSERT crudo habría sido más rápido y habría podido escribir datos que el
 * sistema nunca aceptaría: una caja en negativo, un egreso sin categoría. Esos
 * datos después hacen ver bugs que no existen.
 *
 * ── El orden es cronológico a propósito ─────────────────────────────────────
 *
 * El saldo no puede quedar negativo en NINGÚN momento, así que la plata tiene
 * que entrar antes de gastarse, mes por mes. Generar los gastos primero y los
 * ingresos después pasaría el total final y fallaría en el camino — que es
 * justamente el invariante que vale la pena ejercitar.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *
 *   pnpm tsx --env-file-if-exists=.env scripts/sembrar-gastos.ts
 *   pnpm tsx --env-file-if-exists=.env scripts/sembrar-gastos.ts --rehacer
 *
 * Sin `--rehacer` no borra nada: si ya hay movimientos, se detiene y lo dice.
 * Con `--rehacer` vacía el libro primero, y SOLO si la base se llama
 * `aquazaku_dev` o `aquazaku_test`. El borrado necesita el rol dueño porque la
 * aplicación no tiene `DELETE` sobre el libro, y eso es a propósito: un
 * movimiento borrado cambia el saldo sin dejar la fila que lo explica.
 */

const CONTEXTO = { userId: null, rolEjercido: ['admin'], requestId: 'seed-de-gastos' }

/**
 * Vacía el libro, y solo en una base descartable.
 *
 * La guarda es por NOMBRE de base y no por `NODE_ENV`: una variable de entorno
 * mal puesta es la forma más común de apuntarle a producción sin querer, y acá
 * lo que está en juego es borrar el libro de dinero entero.
 */
async function vaciarElLibro(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? ''
  const base = url.split('/').pop()?.split('?')[0] ?? ''

  if (base !== 'aquazaku_dev' && base !== 'aquazaku_test') {
    throw new Error(
      `--rehacer solo funciona contra aquazaku_dev o aquazaku_test, y esta base es «${base || 'desconocida'}»`,
    )
  }

  const postgres = (await import('postgres')).default
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe('DELETE FROM movimientos_de_dinero')
    await sql.unsafe("DELETE FROM cuentas_de_dinero WHERE tipo = 'banco'")
    console.log(`→ libro vaciado en ${base}`)
  } finally {
    await sql.end()
  }
}

/** Un día concreto, `n` meses antes de hoy, en la zona de la planta. */
function haceMeses(meses: number, dia: number): string {
  const hoy = new Date(`${hoyEnLaPlanta()}T12:00:00-05:00`)
  const d = new Date(hoy)
  d.setDate(1)
  d.setMonth(d.getMonth() - meses)
  /* El 31 en un mes de 30 se iría al mes siguiente: se acota al último día. */
  const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(dia, ultimo))

  return d.toISOString().slice(0, 10)
}

/**
 * Varía un monto ±15 % para que los meses no salgan todos iguales.
 *
 * `base` va en PESOS y `aMonto` espera CENTAVOS — de ahí el `* 100`. Sin él
 * todos los montos variables salían cien veces más chicos que los fijos, y el
 * seed moría con «la caja no alcanza» varios meses adentro: los ingresos eran
 * centavos y los gastos escritos a mano eran pesos.
 *
 * Lo delató el seed, no una lectura: el sistema se negó a dejar una caja en
 * negativo, que es exactamente para lo que está esa regla.
 */
function cerca(base: number, semilla: number): string {
  const factor = 0.85 + ((Math.sin(semilla) + 1) / 2) * 0.3
  /* Redondeado a centenas de peso: nadie paga la nómina con decimales. */
  const pesos = Math.round((base * factor) / 100) * 100

  return aMonto(pesos * 100)
}

type Egreso = Parameters<typeof registrarEgreso>[0]

async function main(): Promise<void> {
  const MESES = 12

  if (process.argv.includes('--rehacer')) await vaciarElLibro()

  const yaHay = await db.select({ id: movimientosDeDinero.id }).from(movimientosDeDinero).limit(1)

  if (yaHay.length > 0) {
    console.log('⚠ Ya hay movimientos en el libro. Este script no borra nada.')
    console.log('  Si querés empezar de cero, vaciá `movimientos_de_dinero` a mano.')
    return
  }

  /* ── Las cuentas ────────────────────────────────────────────────────────── */

  const existentes = await db.select().from(cuentasDeDinero)
  const cajaMenor = existentes.find((c) => c.tipo === 'caja_menor')
  const cajaMayor = existentes.find((c) => c.tipo === 'caja_mayor')

  if (!cajaMenor || !cajaMayor) {
    throw new Error('faltan las cajas: ¿se corrió la migración 0030?')
  }

  const banco =
    existentes.find((c) => c.tipo === 'banco') ??
    (await crearCuentaBancaria(
      {
        nombre: 'Bancolombia ahorros',
        banco: 'Bancolombia',
        numero: '318-456789-01',
        tipoDeCuentaBancaria: 'ahorros',
      },
      CONTEXTO,
    ))

  console.log(`→ cuentas: ${cajaMenor.nombre}, ${cajaMayor.nombre}, ${banco.nombre}`)

  /* ── El punto de partida, hace doce meses ───────────────────────────────── */

  const arranque = haceMeses(MESES, 1)

  await registrarSaldoInicial(
    { cuentaId: cajaMenor.id, monto: '1200000', ocurridoEl: arranque, concepto: 'Efectivo en el cajón al empezar' },
    null,
    CONTEXTO,
  )
  await registrarSaldoInicial(
    { cuentaId: cajaMayor.id, monto: '6500000', ocurridoEl: arranque, concepto: 'Efectivo guardado al empezar' },
    null,
    CONTEXTO,
  )
  await registrarSaldoInicial(
    { cuentaId: banco.id, monto: '9800000', ocurridoEl: arranque, concepto: 'Saldo del extracto al empezar' },
    null,
    CONTEXTO,
  )

  /* ── Doce meses de operación ────────────────────────────────────────────── */

  let movimientos = 3

  for (let m = MESES; m >= 0; m--) {
    const esElMesEnCurso = m === 0
    const hoy = hoyEnLaPlanta()

    /** No sembrar más allá de hoy: un movimiento futuro no ocurrió. */
    const siYaPaso = (fecha: string) => fecha <= hoy

    /*
     * Primero la plata que ENTRA — RN-GAS-10. El recaudo se reparte como se
     * reparte de verdad: lo que se cobra en la puerta es efectivo y va a la
     * caja menor; lo que los clientes comerciales transfieren entra al banco.
     *
     * Y el reparto NO es decorativo: de la caja menor salen los gastos chicos
     * del día a día y del banco los grandes —arriendo, nómina, impuestos—. Si
     * la plata entrara toda a la caja, el banco se quedaría sin con qué pagar
     * la nómina y el seed fallaría a mitad de camino. Que tenga que cuadrar
     * mes a mes es justamente lo que lo vuelve una prueba y no un relleno.
     */
    for (const [i, dia] of [6, 13, 20, 27].entries()) {
      const fecha = haceMeses(m, dia)
      if (!siYaPaso(fecha)) continue

      await registrarIngreso(
        {
          cuentaId: cajaMenor.id,
          tipoDeIngreso: 'recaudo_de_ventas',
          monto: cerca(1_250_000, m * 10 + i),
          ocurridoEl: fecha,
          concepto: `Recaudo en efectivo de la semana ${i + 1}`,
        },
        null,
        CONTEXTO,
      )
      movimientos++
    }

    for (const [i, dia] of [4, 18].entries()) {
      const fecha = haceMeses(m, dia)
      if (!siYaPaso(fecha)) continue

      await registrarIngreso(
        {
          cuentaId: banco.id,
          tipoDeIngreso: 'recaudo_de_ventas',
          monto: cerca(4_600_000, m * 7 + i + 100),
          ocurridoEl: fecha,
          concepto: `Transferencias de clientes comerciales — quincena ${i + 1}`,
        },
        null,
        CONTEXTO,
      )
      movimientos++
    }

    /* ── Lo que SALE ──────────────────────────────────────────────────────── */

    const salidas: Array<Egreso & { cuando: string }> = [
      {
        cuando: haceMeses(m, 5),
        cuentaId: banco.id,
        tipoDeEgreso: 'arriendo',
        monto: '1800000',
        ocurridoEl: haceMeses(m, 5),
        concepto: 'Arriendo de la planta',
        beneficiario: 'Inversiones del Atlántico',
      },
      {
        cuando: haceMeses(m, 15),
        cuentaId: banco.id,
        tipoDeEgreso: 'nomina',
        monto: cerca(2_600_000, m + 1),
        ocurridoEl: haceMeses(m, 15),
        concepto: 'Nómina — primera quincena',
      },
      {
        cuando: haceMeses(m, 30),
        cuentaId: banco.id,
        tipoDeEgreso: 'nomina',
        monto: cerca(2_600_000, m + 2),
        ocurridoEl: haceMeses(m, 30),
        concepto: 'Nómina — segunda quincena',
      },
      {
        cuando: haceMeses(m, 9),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'recibo_publico',
        monto: cerca(740_000, m + 3),
        ocurridoEl: haceMeses(m, 9),
        concepto: 'Energía de la planta',
        beneficiario: 'Air-e',
        numeroDeFactura: `AE-${2600 + m}`,
      },
      {
        cuando: haceMeses(m, 10),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'recibo_publico',
        monto: cerca(185_000, m + 4),
        ocurridoEl: haceMeses(m, 10),
        concepto: 'Acueducto y alcantarillado',
      },
      {
        cuando: haceMeses(m, 11),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'software',
        monto: '96000',
        ocurridoEl: haceMeses(m, 11),
        concepto: 'Internet de la planta',
      },
      {
        cuando: haceMeses(m, 8),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'transporte',
        monto: cerca(420_000, m + 5),
        ocurridoEl: haceMeses(m, 8),
        concepto: 'Combustible del camión de reparto',
      },
      {
        cuando: haceMeses(m, 22),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'transporte',
        monto: cerca(380_000, m + 6),
        ocurridoEl: haceMeses(m, 22),
        concepto: 'Combustible y peajes de la segunda quincena',
      },
      {
        cuando: haceMeses(m, 18),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'mantenimiento',
        monto: cerca(310_000, m + 7),
        ocurridoEl: haceMeses(m, 18),
        concepto: 'Mantenimiento de la planta de tratamiento',
      },
      {
        cuando: haceMeses(m, 25),
        cuentaId: banco.id,
        tipoDeEgreso: 'comision_bancaria',
        monto: '19500',
        ocurridoEl: haceMeses(m, 25),
        concepto: 'Cuota de manejo y 4x1000',
      },
    ]

    /* Gastos que no son de todos los meses. */
    if (m % 3 === 0) {
      salidas.push({
        cuando: haceMeses(m, 19),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'repuesto',
        monto: cerca(560_000, m + 8),
        ocurridoEl: haceMeses(m, 19),
        concepto: 'Filtros de sedimentos y carbón',
        beneficiario: 'Aguas y Filtros del Caribe',
      })
      salidas.push({
        cuando: haceMeses(m, 20),
        cuentaId: banco.id,
        tipoDeEgreso: 'impuesto',
        monto: cerca(1_250_000, m + 9),
        ocurridoEl: haceMeses(m, 20),
        concepto: 'Declaración y pago del trimestre',
      })
    }

    if (m % 4 === 0) {
      salidas.push({
        cuando: haceMeses(m, 12),
        cuentaId: cajaMenor.id,
        tipoDeEgreso: 'litografia',
        monto: cerca(480_000, m + 11),
        ocurridoEl: haceMeses(m, 12),
        concepto: 'Stickers de bases y volantes',
      })
    }

    if (m === 7) {
      salidas.push({
        cuando: haceMeses(m, 14),
        cuentaId: cajaMayor.id,
        tipoDeEgreso: 'equipo',
        monto: '2350000',
        ocurridoEl: haceMeses(m, 14),
        concepto: 'Computador para la oficina',
        numeroDeFactura: 'FV-88213',
      })
    }

    if (m === 4) {
      salidas.push({
        cuando: haceMeses(m, 16),
        cuentaId: cajaMayor.id,
        tipoDeEgreso: 'mueble',
        monto: '890000',
        ocurridoEl: haceMeses(m, 16),
        concepto: 'Estantería para la bodega',
      })
    }

    /* Cronológico: el saldo tiene que alcanzar en cada momento, no al final. */
    salidas.sort((a, b) => a.cuando.localeCompare(b.cuando))

    for (const salida of salidas) {
      if (!siYaPaso(salida.cuando)) continue

      const { cuando: _descartado, ...egreso } = salida
      await registrarEgreso(egreso, null, CONTEXTO)
      movimientos++
    }

    if (!esElMesEnCurso) process.stdout.write('·')
  }

  console.log('')

  /* ── Lo que quedó ───────────────────────────────────────────────────────── */

  const saldos = await cuentasConSaldo()

  console.log(`\n✓ ${movimientos} movimientos, desde ${arranque}\n`)
  for (const cuenta of saldos) {
    console.log(`  ${cuenta.nombre.padEnd(22)} ${cuenta.saldo.padStart(14)}`)
  }

  const total = saldos.reduce((t, c) => t + Math.round(Number(c.saldo) * 100), 0)
  console.log(`  ${'TOTAL'.padEnd(22)} ${aMonto(total).padStart(14)}\n`)

  /*
   * El proveedor queda cargado para poder probar a mano una compra que
   * descuenta de una cuenta (RN-GAS-11) desde la pantalla de Proveedores.
   */
  const [proveedor] = await db
    .select()
    .from(proveedores)
    .where(eq(proveedores.nombre, 'Plásticos del Caribe'))

  if (!proveedor) {
    await db.insert(proveedores).values({ nombre: 'Plásticos del Caribe', nit: '900123456' })
    console.log('→ proveedor «Plásticos del Caribe» cargado para probar una compra\n')
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error('\n✗ el seed falló:', err instanceof Error ? err.message : err)
    await closeDb()
    process.exit(1)
  })
