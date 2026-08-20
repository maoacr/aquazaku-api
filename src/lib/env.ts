import { z } from 'zod'

/**
 * Contrato de entorno de api/.
 *
 * Se valida una sola vez, al importar este módulo. Si falta algo o está mal,
 * el proceso muere en el arranque con un mensaje claro — que es infinitamente
 * mejor que descubrirlo en el primer request de producción.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  /**
   * Conexión de la APLICACIÓN. Usa el rol `aquazaku_app`, que NO es dueño de
   * las tablas y no tiene UPDATE ni DELETE sobre `audit_log`. Esa es la mitad
   * dura de la inmutabilidad del log: aunque un bug o una inyección intenten
   * borrar auditoría, el rol no tiene el permiso.
   */
  DATABASE_URL: z.url(),

  /**
   * Conexión de MIGRACIONES. Usa el rol dueño (`aquazaku`), que sí puede crear
   * y alterar tablas. Solo la usan drizzle-kit y el runner de migraciones,
   * nunca el servidor en runtime.
   */
  DATABASE_MIGRATION_URL: z.url(),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET necesita al menos 32 caracteres'),
  BETTER_AUTH_URL: z.url(),
  COOKIE_DOMAIN: z.string().default('localhost'),

  // `smtp` apunta a Mailpit en dev; `resend` es el de producción.
  MAIL_TRANSPORT: z.enum(['smtp', 'resend']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@aquazaku.com'),

  WEB_PUBLIC_URL: z.url().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type Env = z.infer<typeof envSchema>

/**
 * Recibe la fuente por parámetro en vez de leer `process.env` directo: así las
 * ramas de error se pueden testear sin ensuciar el entorno del proceso.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n')

    throw new Error(
      `Variables de entorno inválidas o faltantes:\n${detalle}\n\n` +
        'Copiá .env.example a .env y completá los valores.',
    )
  }

  // En producción con Resend, la API key deja de ser opcional.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.MAIL_TRANSPORT === 'resend') {
    if (!parsed.data.RESEND_API_KEY) {
      throw new Error('MAIL_TRANSPORT=resend en producción requiere RESEND_API_KEY')
    }
  }

  return parsed.data
}

export const env = parseEnv()
