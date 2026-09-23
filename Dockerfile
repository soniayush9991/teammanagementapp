# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# One image serves both halves. The web client resolves the API at '/api/v1'
# and derives its WebSocket URL from window.location.host, and the refresh
# cookie is SameSite=Strict — so the SPA and the API must share an origin.
# The API serves the built bundle itself rather than needing a second service
# and a reverse proxy in front of both.
# ---------------------------------------------------------------------------

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so the dependency layer stays cached until they change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Production dependencies only: no typescript, tsx or vite reaches the image.
RUN npm ci --omit=dev && npm cache clean --force

# The compiled output. apps/api/dist carries the .sql migrations (the runner
# reads them with readdir at boot), and apps/web/dist is the bundle the API
# serves. The relative layout matters: app.ts resolves the bundle at
# ../../web/dist from its own location.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist

USER node
EXPOSE 4000

# /readyz checks the database, so an image that cannot reach Postgres is
# reported unhealthy rather than merely "running".
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on boot unless RUN_MIGRATIONS_ON_BOOT=false.
CMD ["node", "apps/api/dist/index.js"]
