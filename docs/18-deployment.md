# 18. Deployment

## The constraint that shapes everything

The web client resolves the API at the relative path `/api/v1`
(`apps/web/src/api/client.ts`) and derives its WebSocket URL from
`window.location.host` (`apps/web/src/hooks/useRealtime.ts`). The refresh token
is a `SameSite=Strict` cookie scoped to `/api/v1/auth`.

Each of those independently requires that **the SPA and the API share one
origin**. Splitting them across two hosts breaks authentication even if you
rewrite the API path, because a strict cookie is not sent cross-site.

So the API serves the bundle itself:

```
            ┌──────────────────────────────────────────┐
  browser → │  one origin                              │
            │    /                → index.html (SPA)   │
            │    /board, /tasks/… → index.html (SPA)   │
            │    /assets/*        → hashed bundle      │
            │    /api/v1/*        → JSON API           │
            │    /ws              → WebSocket upgrade  │
            │    /healthz /readyz → probes             │
            └──────────────────────────────────────────┘
                                │
                         PostgreSQL 16
```

`createApp()` mounts `express.static` plus a catch-all **only when the bundle
is present**, so local development is unchanged: Vite serves the SPA on `:5173`
and proxies back to the API.

Two consequences worth knowing:

- **The CSP is relaxed when the bundle is served.** A JSON-only API runs with
  `default-src 'none'`; serving HTML needs `'self'` for scripts, assets and
  XHR, `'unsafe-inline'` for styles (React renders `style={{…}}` props as
  inline attributes) and `ws:`/`wss:` in `connect-src`. Nothing third-party is
  allowed. Verified in Chromium with zero CSP violations.
- **`index.html` is served `no-cache`, assets `immutable` for a year.** Asset
  filenames are content-hashed, so they can be cached hard; the shell must not
  be, or a deploy leaves browsers pinned to the previous bundle.

## Configuration

| Variable | Required | Notes |
|---|:---:|---|
| `DATABASE_URL` | ● | Append `?sslmode=require` for managed Postgres — `pool.ts` passes no `ssl` option, so TLS has to come from the URL |
| `JWT_ACCESS_SECRET` | ● | ≥16 chars; `openssl rand -hex 48` |
| `JWT_REFRESH_SECRET` | ● | As above, different value |
| `NODE_ENV=production` | ● | **The refresh cookie's `secure` flag depends on it.** Without it the cookie travels over plain HTTP |
| `PORT` | | Defaults to 4000 |
| `SEED_DEMO_ON_BOOT` | | `true` populates the demo organization — only into an empty database, so a restart never overwrites data |
| `WEB_DIST_PATH` | | Override the bundle location; the default is `apps/web/dist` beside the API |
| `WEB_ORIGIN` | | CORS allowlist. Irrelevant in single-origin mode; set it only if you front the app with a different hostname |
| `RUN_MIGRATIONS_ON_BOOT` | | Migrations run on boot unless this is `false` |
| `RUN_JOBS` | | Set `false` on web instances if you run the retention/reminder jobs as a separate worker |
| `S3_*` | | Attachments. Uploads fail without it; nothing else is affected |
| `SMTP_URL` | | Email. Logged instead when unset |

## Local, production-parity

```bash
docker compose up --build     # → http://localhost:3000
```

Postgres 16, the built image, one origin, demo data seeded. This is the same
image a host runs, so it is the cheapest way to check a deployment before
pushing it anywhere.

## Render (managed Postgres, free tier)

`render.yaml` is a blueprint: push the repo, then **New → Blueprint** and pick
it. Render builds the Dockerfile, provisions Postgres 16, generates both JWT
secrets and wires `DATABASE_URL`.

Caveats on the free tier: the service sleeps after inactivity, so the first
request after a pause takes ~30s to cold start, and the free database expires
after 30 days.

## Fly.io

No config file is committed, since `fly launch` writes one tuned to your
organization and region:

```bash
fly launch --no-deploy            # writes fly.toml; decline the built-in Postgres prompt
fly postgres create --name teamspace-db
fly postgres attach teamspace-db  # sets DATABASE_URL
fly secrets set NODE_ENV=production \
  JWT_ACCESS_SECRET="$(openssl rand -hex 48)" \
  JWT_REFRESH_SECRET="$(openssl rand -hex 48)" \
  SEED_DEMO_ON_BOOT=true
fly deploy
```

Set `internal_port = 4000` in `fly.toml` to match `EXPOSE`.

## Any Docker host

```bash
docker build -t teamspace .
docker run -p 80:4000 \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgres://user:pass@host:5432/teamspace?sslmode=require' \
  -e JWT_ACCESS_SECRET="$(openssl rand -hex 48)" \
  -e JWT_REFRESH_SECRET="$(openssl rand -hex 48)" \
  -e SEED_DEMO_ON_BOOT=true \
  teamspace
```

Terminate TLS at a proxy in front. `app.set('trust proxy', 1)` assumes
**exactly one** hop — behind a CDN *and* a load balancer, rate-limit buckets
will key on the wrong address.

## What the image contains

Multi-stage: the build stage runs `npm ci` and `npm run build`; the runtime
stage installs with `--omit=dev`, so no `typescript`, `tsx` or `vite` ships.
It copies three directories — `packages/shared/dist`, `apps/api/dist`
(including the `.sql` migrations the runner reads at boot) and
`apps/web/dist`. Runs as the non-root `node` user. `HEALTHCHECK` uses
`/readyz`, which touches the database, so a container that cannot reach
Postgres reports unhealthy rather than merely running.

## First boot

1. Migrations apply automatically (forward-only, checksummed).
2. With `SEED_DEMO_ON_BOOT=true` and an empty `users` table, the demo
   organization is created: 7 people, 2 teams, 16 tasks, channels and a DM.
3. Sign in as `maya@teamspace.dev` / `TeamSpace!2026`.

**A public URL with those credentials is world-readable.** The password is in
this repository. For anything beyond a demo, deploy without
`SEED_DEMO_ON_BOOT`, create your own admin, and change the password.

## Operating it

| Concern | Where |
|---|---|
| Liveness | `GET /healthz` |
| Readiness | `GET /readyz` (checks the database) |
| Shutdown | `SIGTERM` stops jobs, closes sockets with 1001, drains the pool |
| Logs | pino JSON on stdout, with credentials and message bodies redacted |
| Migrations | On boot; or `RUN_MIGRATIONS_ON_BOOT=false` and run `node apps/api/dist/db/migrate.js` as a release step |
| Seeding manually | `node apps/api/dist/db/seed.js` — **destructive**, it rebuilds the demo org |

## Scaling past one instance

Single-instance today, and two things assume it: the realtime event bus is
in-process, and the rate limiter holds counters in memory. Both sit behind
seams (`realtime/bus.ts`, `middleware/rateLimit.ts`) — swap in Redis and no
call site changes. Also set `RUN_JOBS=false` on web instances and run the
scheduler once, or several replicas will each run retention and reminders.

## What CI verifies

The `docker` job builds the image, asserts no build tooling survived the
prune, runs it against Postgres, and then checks `/readyz`, that `/` returns
`text/html`, and that the demo login returns 200 — which together prove the
image boots, migrates, seeds and serves both halves on one origin.
