# 16. Development roadmap

Estimates assume a team of four: two backend, one frontend, one
designer/full-stack, with shared QA. "Done" means tested, documented and
deployed to staging.

## Status

Milestones 1–6 are **implemented in this repository**. 7 onward are planned.

---

## Milestone 1 — Foundations (2 weeks) ✅

Workspace, shared domain package, PostgreSQL schema with migrations,
configuration validation, logging, error handling, health checks.

*Exit criteria:* migrations apply cleanly to an empty database; the schema
rejects invalid rows; the API boots and reports ready.

## Milestone 2 — Identity and access (2 weeks) ✅

Login, rotating refresh tokens with theft detection, bcrypt password policy,
the two-layer authorization model, audit logging, user and team management.

*Exit criteria:* every permission refusal in the matrix has a test; a
deactivated account loses access immediately.

## Milestone 3 — Work management (3 weeks) ✅

Tasks with subtasks, dependencies, labels, comments, activity history and work
logs. Status transition rules. Recurrence. Kanban, list and calendar views.

*Exit criteria:* illegal transitions and cyclic dependencies are refused with
actionable errors; the board is fully keyboard operable.

## Milestone 4 — Capacity and planning (2 weeks) ✅

Capacity engine, leave and holidays, per-week overrides, the planner with
drag-to-assign, workload comparison and the assignment recommender.

*Exit criteria:* leave measurably reduces effective capacity; the recommender
is deterministic and explains its ranking.

## Milestone 5 — Collaboration (3 weeks) ✅

Conversations, partitioned messages, threads, reactions, mentions, pins, read
receipts, typing indicators, attachments, the WebSocket gateway, notifications.

*Exit criteria:* a mention of a non-member leaks nothing; deleting a message
preserves thread structure; a dropped socket recovers with backoff.

## Milestone 6 — Insight and lifecycle (2 weeks) ✅

Dashboards, six reports, CSV and PDF export, cross-entity search, the retention
job, the admin console.

*Exit criteria:* an expired month's partition is dropped and its rows are gone;
exports agree with the screen; search never returns invisible content.

---

## Milestone 7 — Production hardening (2 weeks)

| Work | Why |
|---|---|
| Redis-backed rate limiting and event bus | Required before scaling past one instance |
| Extract jobs to a dedicated worker | Stop duplicate runs across replicas |
| CI: typecheck, test, `npm audit`, migration dry-run | Catch what review misses |
| Structured metrics and tracing | p95 latency, socket count, job duration |
| Load test: 500 concurrent sockets, 10k tasks | Find the first real ceiling |
| Backup and restore rehearsal | An untested restore is not a backup |

## Milestone 8 — Enterprise access (3 weeks)

SSO via SAML and OIDC, SCIM provisioning, MFA (TOTP), IP allowlisting, session
management UI, a legal-hold flag that exempts a conversation from retention.

## Milestone 9 — Planning depth (3 weeks)

Multi-week planning horizon in the UI, scenario planning ("what if Priya takes
that week off"), team-level capacity targets, skill gap analysis, partial
allocations across several weeks for long tasks.

## Milestone 10 — Collaboration depth (3 weeks)

Message editing history, scheduled messages, saved searches, rich text with
code blocks, link unfurling, conversation exports for compliance, guest access
scoped to a single group.

## Milestone 11 — Mobile and offline (4 weeks)

Responsive polish to a true mobile-first chat, PWA with offline task viewing,
push notifications, native wrappers if adoption justifies them.

---

## Sequencing rationale

**Why capacity before collaboration.** Capacity is the differentiator; chat is
table stakes. Building the harder, more opinionated thing first meant the data
model was shaped by it rather than retrofitted around a messaging schema.

**Why retention in milestone 6, not later.** Partitioning `messages` is
practically impossible to retrofit once the table is large — the composite key
propagates to four other tables. It had to be right before real data existed.

**Why hardening is its own milestone.** Redis, CI and load testing are not
features, and folding them into feature work is how they get skipped.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Capacity model too simple for some orgs | Adoption stalls | Per-week overrides and allocation splits already exist; scenario planning in M9 |
| Chat compared to Slack and found thin | Users keep both tools | Compete on *linked* conversation and work, not on feature parity |
| PostgreSQL search outgrown | Slow search | Measured triggers documented; migration path defined |
| Estimates unreliable, so capacity is unreliable | Planning distrusted | Show logged vs estimated so drift is visible, not hidden |
| Single API instance | Availability ceiling | Statelessness preserved throughout; M7 removes the blocker |
