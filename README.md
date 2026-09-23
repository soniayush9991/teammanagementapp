# TeamSpace

[![CI](https://github.com/soniayush9991/teammanagementapp/actions/workflows/ci.yml/badge.svg)](https://github.com/soniayush9991/teammanagementapp/actions/workflows/ci.yml)

A team management platform that keeps **work, capacity and conversation in one
data model** — so a manager can see that a task is due Friday, that the person
holding it is at 125% after their approved leave, and that the last three
messages about it explain why.

Managers track assignments, workload and progress; team members see what is on
them today and talk about it in persistent, searchable conversations retained
for 365 days.

---

## What is here

| Area | State |
|---|---|
| PostgreSQL schema, 9 migrations | Applied and exercised against a live PostgreSQL 16 |
| REST API, 14 modules, 98 endpoints | Implemented, typechecked, integration tested |
| WebSocket gateway | Subscriptions, typing, presence, heartbeat, backoff |
| React client, 11 screens | Built and driven in a real browser |
| Background jobs | Retention (partition drops) and deadline reminders |
| Deployment | Dockerfile, Compose and a Render blueprint; one origin, one container |
| Tests | **104 passing** — 15 shared unit, 20 API unit, 69 integration against a real database; run in CI on Node 20.19 and 22 |
| Documentation | [17 documents](docs/README.md), one per requested deliverable |

## Quick start

**Requirements:** Node 20.19+ or 22.12+, PostgreSQL 16+. An S3-compatible bucket and SMTP
are optional — uploads and email degrade gracefully without them.

```bash
git clone <this repository> && cd teammanagementapp
npm install

cp .env.example .env            # then set DATABASE_URL and the two JWT secrets
createdb teamspace

npm run db:migrate              # apply the schema
npm run db:seed                 # demo organization: 7 people, 2 teams, 16 tasks

npm run dev                     # API on :4000, web on :5173
```

Open http://localhost:5173 and sign in:

| Account | Role | Sees |
|---|---|---|
| `maya@teamspace.dev` | manager | Two teams, capacity planner, reports |
| `sam@teamspace.dev` | member | Own work only — the RBAC boundary is visible |
| `admin@teamspace.dev` | admin | Users, audit trail, retention policy |

Password for all three: `TeamSpace!2026`

The seed is deliberately uneven: one person is over capacity, one has two days
of approved leave, and one task is overdue — so the dashboards show something
real on first load.

## Deploying it

The SPA and the API **must share one origin** — the client resolves the API at
`/api/v1`, derives its WebSocket URL from `window.location.host`, and the
refresh cookie is `SameSite=Strict`. So the API serves the built bundle itself,
and one container is the whole deployment.

Locally, with production parity:

```bash
docker compose up --build       # → http://localhost:3000
```

To a host with a public URL — `render.yaml` is a blueprint, so push the repo
and choose **New → Blueprint** in Render. It builds the Dockerfile, provisions
Postgres 16, generates both JWT secrets and wires `DATABASE_URL`. Fly.io and
plain Docker are covered in [docs/18-deployment.md](docs/18-deployment.md).

Set `SEED_DEMO_ON_BOOT=true` to populate the demo organization on first boot;
it only ever writes into an empty database, so restarts never overwrite data.
`NODE_ENV=production` is not optional — the refresh cookie's `secure` flag
depends on it.

> A public URL seeded with demo data is world-readable: the password is in this
> README. For anything real, deploy without `SEED_DEMO_ON_BOOT`, create your
> own admin, and change it.

## Commands

```bash
npm run dev            # API and web together
npm run build          # shared → api → web
npm run typecheck      # every workspace
npm test               # every workspace

npm run db:migrate     # forward-only, checksummed
npm run db:seed        # rebuild the demo organization

# Integration tests need a database of their own:
createdb teamspace_test
TEST_DATABASE_URL=postgres://localhost/teamspace_test npm test -w @teamspace/api
```

Without `TEST_DATABASE_URL` the integration suites skip rather than fail, so
`npm test` stays green on a machine with no PostgreSQL.

## Layout

```
teammanagementapp/
├── packages/shared/    domain types, the permission matrix, capacity maths
├── apps/api/           Express + PostgreSQL + ws
├── apps/web/           React + TypeScript + Vite
└── docs/               the 18 design documents
```

`packages/shared` is the reason a report can never disagree with the screen it
came from: the capacity formula, the utilization bands and the permission
matrix are defined once and imported by both sides.

## The parts worth looking at

**Capacity is computed, never stored.** There is no `utilization` column.
It is derived from contracted hours, per-week overrides, approved leave,
holidays and open assignments — so it cannot drift out of date.
→ `packages/shared/src/capacity.ts`

**Authorization has two layers.** A role permission ("may a manager ever assign
work?") and a record scope ("is this task in a team they manage?"). Both must
pass. → `apps/api/src/middleware/{auth,scope}.ts`

**Messages are partitioned by month.** The 365-day retention requirement is met
by dropping an expired partition — a metadata operation — instead of deleting
millions of rows and leaving autovacuum to clean up.
→ `apps/api/src/db/migrations/006_messaging.sql`, `apps/api/src/jobs/retention.ts`

**Refresh tokens rotate, with a grace window.** Replaying a rotated token
revokes the whole family and is audited. A ten-second window absorbs genuine
races — two tabs, a retry — that would otherwise look identical to theft.
→ `apps/api/src/modules/auth/auth.service.ts`

**Colour is never the only signal.** Every utilization band carries a glyph and
a number, drag-and-drop is always paired with a keyboard control, and the modal
traps and restores focus. → `apps/web/src/components/ui.tsx`

## Configuration

Everything is validated by zod at boot — a missing JWT secret is a startup
failure, not a 500 at 3am. See [`.env.example`](.env.example) for the full set.

A `.env` file in the repository root (or in `apps/api/`) is loaded
automatically. Variables already set in the environment always win over the
file, so a container, a CI job or an inline `DATABASE_URL=… npm run …` keeps
its value. `.env` is gitignored — keep real secrets out of commits.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Token signing — `openssl rand -hex 48` |
| `MESSAGE_RETENTION_DAYS` | Defaults to 365 |
| `S3_*` | Attachment storage; uploads are disabled without it |
| `SMTP_URL` | Email notifications; logged instead when unset |
| `RUN_JOBS` | Set `false` on web instances when running a separate worker |

## Documentation

Start with the [documentation index](docs/README.md). The three that explain
the most in the least time:

- [Database schema](docs/08-database-schema.md) — why partitioning, why partial indexes
- [Security and permissions](docs/14-security-and-permissions.md) — the threat model and the known gaps
- [Search and retention](docs/13-search-and-retention.md) — how 365 days stays cheap

## Known limitations

Stated plainly rather than implied:

- **Single API instance.** The realtime bus and rate limiter are in-process.
  Both are behind seams; swapping in Redis does not change any call site.
- **No MFA or SSO.** Roadmap milestone 8.
- **Email is a seam, not an integration.** The `notifications` table is the
  outbox; a provider client drops into `mailer.ts`.
- **Search is PostgreSQL full-text.** Fine to roughly 10M messages; the
  migration trigger and path are documented.
