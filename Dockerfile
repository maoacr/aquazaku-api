# Aquazaku · api
#
# ── Por qué corre con `tsx` y no compilado ───────────────────────────────────
#
# 109 archivos importan con el alias `@/`. La salida de `tsc` conserva esos
# alias tal cual, así que un build clásico necesitaría `tsc-alias` o un bundler
# —maquinaria nueva, y una clase entera de bugs que solo aparecen en producción
# porque en desarrollo el alias sí resuelve—.
#
# `tsx` los resuelve nativo leyendo el mismo `tsconfig.json` que usa el editor.
# El costo es un transpilado en el arranque; para una API de este tamaño son
# un par de segundos, una vez. Por eso `tsx` está en `dependencies` y no en
# `devDependencies`: en producción SE EJECUTA.
#
# ── Las migraciones NO corren acá ────────────────────────────────────────────
#
# Necesitan `DATABASE_MIGRATION_URL` —el rol dueño del esquema, que puede crear
# tablas y revocar permisos— y el servidor corre con `DATABASE_URL`, el rol de
# la aplicación, que tiene `UPDATE`/`DELETE` revocados sobre los libros
# append-only. Darle al contenedor de runtime la credencial del dueño para
# «aprovechar y migrar al arrancar» tiraría abajo esa separación.
#
# Migrar es un paso aparte y deliberado: `docker compose run --rm migraciones`.

FROM node:22-alpine

# `tini` para que las señales lleguen al proceso: sin él, un `docker stop` mata
# el contenedor sin darle a Fastify la chance de cerrar el pool de Postgres.
RUN apk add --no-cache tini

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

WORKDIR /app

# Las dependencias en su propia capa: el código cambia todos los días, el
# lockfile casi nunca. Sin esta separación, cada deploy reinstala todo.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

# `node` viene con la imagen y no es root. El proceso no escribe en disco
# —los logs van a stdout— así que no necesita ser dueño de nada.
USER node

ENV NODE_ENV=production
EXPOSE 3001

# El healthcheck usa el mismo endpoint que el CI espera para saber si arrancó.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "start"]
