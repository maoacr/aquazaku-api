import { buildApp } from '@/app'

const PORT = Number(process.env.PORT ?? 3001)

async function start(): Promise<void> {
  const app = await buildApp()

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err, 'no se pudo levantar el servidor')
    process.exit(1)
  }

  // Sin esto, un redeploy corta requests en vuelo y deja conexiones colgadas.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'cerrando el servidor')
      void app.close().then(() => process.exit(0))
    })
  }
}

void start()
