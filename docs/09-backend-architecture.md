# 9. Backend architecture

Node.js 20+, Express 4, TypeScript in strict mode, PostgreSQL 16, `ws` for
realtime. No ORM: the data model leans on partitioning, partial indexes,
recursive CTEs and full-text search, which is exactly the territory where an
ORM stops helping and starts hiding.

## Folder structure

```
apps/api/
├── src/
│   ├── index.ts                 process entry: migrate, listen, graceful shutdown
│   ├── app.ts                   express assembly and route mounting
│   ├── env.ts                   zod-validated configuration, fails fast on boot
│   │
│   ├── db/
│   │   ├── pool.ts              pg pool, query helpers, withTransaction
│   │   ├── migrate.ts           forward-only checksummed migration runner
│   │   ├── seed.ts              deterministic demo organization
│   │   └── migrations/*.sql     the schema, in order
│   │
│   ├── lib/                     framework-free utilities
│   │   ├── errors.ts            ApiError with a status and a stable code
│   │   ├── tokens.ts            JWT signing, opaque refresh tokens
│   │   ├── password.ts          bcrypt + strength policy
│   │   ├── http.ts              asyncHandler, zod parsing, cursor encoding
│   │   ├── mentions.ts          @[Name](uuid) parsing and rendering
│   │   ├── csv.ts               RFC 4180 writer with injection guards
│   │   ├── pdf.ts               dependency-free tabular PDF writer
│   │   ├── storage.ts           S3 presigning, upload policy
│   │   ├── audit.ts             audit trail append
│   │   └── logger.ts            pino with credential redaction
│   │
│   ├── middleware/
│   │   ├── auth.ts              authenticate + requirePermission (layer 1)
│   │   ├── scope.ts             record-level authorization (layer 2)
│   │   ├── error.ts             ApiError and PostgreSQL error mapping
│   │   ├── rateLimit.ts         fixed-window limiter
│   │   └── requestId.ts         request correlation
│   │
│   ├── modules/                 one folder per domain
│   │   ├── auth/                login, rotation, password change
│   │   ├── users/               directory, profiles, skills, roles
│   │   ├── teams/               teams and membership
│   │   ├── tasks/               CRUD, transitions, recurrence, board, calendar
│   │   ├── capacity/            capacity, overrides, leave
│   │   ├── assignments/         assign, move, bulk, compare, recommend
│   │   ├── conversations/       DMs, groups, channels, membership
│   │   ├── messages/            send, edit, delete, react, pin, read
│   │   ├── attachments/         presigned upload and download
│   │   ├── search/              cross-entity search and typeahead
│   │   ├── reports/             five reports plus CSV/PDF export
│   │   ├── notifications/       fan-out, preferences, mail seam
│   │   ├── dashboard/           manager and member aggregates
│   │   └── admin/               audit, retention, org settings
│   │
│   ├── realtime/
│   │   ├── gateway.ts           WebSocket server, subscriptions, heartbeat
│   │   ├── bus.ts               publish/subscribe seam (in-process today)
│   │   └── events.ts            the typed event contract
│   │
│   └── jobs/
│       ├── scheduler.ts         interval runner with overlap protection
│       ├── retention.ts         partition drops and purges
│       └── reminders.ts         due-soon and overdue notices
└── test/
    ├── unit/                    pure logic, no database
    └── integration/             real HTTP against a real PostgreSQL
```

## Layering

```
routes      HTTP shape only: parse with zod, call a service, serialise.
              No SQL, no business rules.
   │
services    Business rules, authorization scope, transactions, events.
              The only layer that may decide anything.
   │
db/pool     Parameterised SQL. Every query is a prepared statement.
```

A route that needed a rule would be a route that duplicated a rule. Services
are called by routes, by jobs and by tests identically.

## Request lifecycle

```
  request
    → requestId          correlation id, echoed in the response and the logs
    → helmet + cors      security headers, origin allowlist
    → express.json       1 MB body cap
    → cookieParser       refresh cookie only
    → rateLimit          per-IP on auth, per-actor on writes
    → authenticate       verify JWT, confirm the account is still active
    → requirePermission  layer 1 — role
    → handler
        → parseBody      zod, 400 with field-level detail on failure
        → service
            → assert*    layer 2 — record scope
            → withTransaction
            → publish    realtime events, after commit
    → errorHandler       ApiError or PostgreSQL error → stable JSON
```

**Why `authenticate` hits the database on every request.** It would be cheaper
to trust the JWT alone. But then deactivating an account would take effect only
when the access token expired, which is not a control anyone would accept
during an incident. The lookup also detects a stale role claim and forces a
refresh.

## Error handling

Every failure becomes an `ApiError` with an HTTP status and a stable machine
code, so clients branch on `error.code` rather than on prose:

```json
{
  "error": {
    "code": "unprocessable_entity",
    "message": "A task cannot move from backlog to done",
    "details": { "allowed": ["todo", "in_progress", "cancelled"] },
    "requestId": "9f2c…"
  }
}
```

PostgreSQL errors are mapped rather than leaked: `23505 → 409`, `23503 → 400`,
`23514 → 422`, `40001 → 409 retry`, `57014 → 503`. In production, 5xx messages
are replaced with a generic string while the real error goes to the log with
the same `requestId`.

## Transactions

Any write touching more than one table runs inside `withTransaction`. Two
places deliberately step outside it:

1. **Refresh-token theft response.** The family revocation must survive the
   rollback of the transaction that detected the reuse, so it runs on a
   separate connection. Getting this wrong (the first implementation did) meant
   the stolen token stayed live.
2. **Audit logging on a best-effort path.** A failed audit write for a
   read-shaped action is logged, not raised. Security-relevant writes (role
   changes, retention changes, deletions) pass the transaction client so the
   audit entry is atomic with the change it describes.

## Background jobs

`Scheduler` runs jobs on intervals with per-job overlap protection, so a slow
run cannot stack up behind itself, and a throw is logged rather than taking the
process down. For more than one API instance, set `RUN_JOBS=false` on the web
instances and run the jobs as a single worker or as platform cron.

## Configuration and operations

`env.ts` validates every variable with zod at boot; a missing JWT secret is a
startup failure, not a 500 at 3am. `/healthz` reports liveness, `/readyz`
checks the database. `SIGTERM` stops the scheduler, closes sockets with code
1001, drains the pool, then exits.

## Scaling path

| Concern | Today | Next step |
|---|---|---|
| API instances | One process | Stateless; scale horizontally behind a load balancer |
| Realtime fan-out | In-process `EventBus` | Swap `bus.ts` for Redis pub/sub — call sites do not change |
| Rate limiting | Per-process memory | Redis-backed fixed window |
| Jobs | In-process scheduler | Dedicated worker or platform cron |
| Search | PostgreSQL full-text | Stays until ~10M messages; see [search doc](13-search-and-retention.md) |
