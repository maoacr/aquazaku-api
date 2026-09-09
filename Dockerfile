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
# ── Las migraciones SÍ corren acá (con credencial separada) ──────────────────
#
# El release command corre `pnpm db:migrate` antes de levantar el server. Esa
# migración usa `DATABASE_MIGRATION_URL` —el rol dueño del esquema, que puede
# crear tablas y revocar permisos—, mientras que el server runtime usa
# `DATABASE_URL`, el rol de la aplicación, que tiene `UPDATE`/`DELETE` revocados
# sobre los libros append-only. La separación se mantiene: la credencial del
# dueño nunca toca el proceso del server, solo el paso de migración que corre
# y termina antes de que `pnpm start` arranque.

FROM node:22-alpine

# `tini` para que las señales lleguen al proceso: sin él, un `docker stop` mata
# el contenedor sin darle a Fastify la chance de cerrar el pool de Postgres.
RUN apk add --no-cache tini

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

WORKDIR /app

# Las dependencias en su propia capa: el código cambia todos los días, el
# lockfile casi nunca. Sin esta separación, cada deploy reinstala todo.
# `pnpm-workspace.yaml` NO es opcional acá: es donde vive `allowBuilds`, y sin
# él pnpm ignora el script de instalación de esbuild —del que depende `tsx`— y
# el install falla. Se olvidó en la primera versión, y el síntoma apareció recién
# al construir: en local nunca se nota porque `node_modules` ya está resuelto.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
# `scripts/` es donde vive `describir-conexion.ts` y los helpers que importa
# `drizzle/migrate.ts`. Sin esta copia, el release command (`pnpm db:migrate`)
# crashea con `Cannot find module` y el server nunca arranca. Encontrado en
# producción el 8-sep-2026 al activar el release command de migraciones.
COPY scripts ./scripts

# `node` viene con la imagen y no es root. El proceso no escribe en disco
# —los logs van a stdout— así que no necesita ser dueño de nada.
USER node

ENV NODE_ENV=production
EXPOSE 3001

# El healthcheck usa el mismo endpoint que el CI espera para saber si arrancó.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sin `CMD` — Railway usa el `startCommand` configurado en el servicio
# (`pnpm db:migrate && pnpm db:sync-preview && pnpm start`). Dejar el `CMD`
# acá sobreescribe eso y rompe el flujo de migraciones en cada deploy.
ENTRYPOINT ["/sbin/tini", "--"]

# ─────────────────────────────────────────────────────────────────────────────
# Lo que hace este contenedor: levantar el servidor. Nada más.
# ─────────────────────────────────────────────────────────────────────────────
#
# Estuvo sin CMD entre el 8 y el 9 de septiembre, para que el `startCommand` de
# Railway tomara el control. El costo fue que el comportamiento del contenedor
# dejó de estar en el repo: no se podía revisar en un diff, ni probar en una
# máquina, ni verlo sin abrir el panel.
#
# Un cambio en ese panel rompió TODOS los deploys durante un día, en silencio.
#
# El `startCommand` sigue pudiendo sobreescribirlo cuando un ambiente necesita
# otra cosa —staging sincroniza su schema antes de arrancar— pero el default
# vive acá, es el correcto para producción, y se puede correr localmente con
# `docker run`.
#
# Las migraciones NO van en el arranque (ADR-0009): dos instancias migrando a la
# vez se pisan, y una migración a medias es peor que un deploy demorado. Se
# corren a mano con `pnpm db:migrate:prod`, que dice a qué base va.
CMD ["pnpm", "start"]
