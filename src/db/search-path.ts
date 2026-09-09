/**
 * En qué schema vive este ambiente.
 *
 * ── Por qué está en su propio archivo ───────────────────────────────────────
 *
 * Lo necesitan dos piezas que NO se pueden importar entre sí:
 *
 *   · `db/client.ts`, que abre el pool de la aplicación
 *   · `drizzle/migrate.ts`, que corre las migraciones
 *
 * Importar `client.ts` desde el migrador abriría una conexión con el rol de la
 * aplicación solo para leer una constante — y el migrador corre con el rol
 * dueño, a propósito.
 *
 * ── El bug que esto evita ───────────────────────────────────────────────────
 *
 * Antes la app decidía por `AQUAZAKU_ENV` y el migrador tenía `'public'`
 * escrito a mano. En staging eso significaba:
 *
 *     pnpm db:migrate  → migraba «public»   ← el schema de PRODUCCIÓN
 *     pnpm start       → servía «preview»
 *
 * El mismo comando apuntaba a schemas distintos según qué pieza lo leyera. No
 * fallaba: migraba producción en cada deploy de staging, en silencio.
 */
export type Ambiente = 'production' | 'preview' | 'development'

export function searchPathFor(ambiente: Ambiente | undefined): 'preview' | 'public' {
  return ambiente === 'preview' ? 'preview' : 'public'
}
