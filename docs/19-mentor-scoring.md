# 19 · Mentor scoring

Implements the *Mentor Scoring — Vendor-Ready PRD*: a fortnightly **Mentor Report Card**
built from Compliance (coverage, duration, spot assessments) and Data Reliability
(confirmed inflation and contradiction issues). Built so far: the scoring engine, schema and REST API, the mentor screens M1–M7
(`apps/web/src/pages/mentor/`) and the reviewer/admin screens A1–A7
(`apps/web/src/pages/mentorAdmin/`).

## Where things live

| Piece | Location |
|---|---|
| Pure scoring engine, defaults, validation, nudges, recognition | `packages/shared/src/mentorScoring.ts` |
| Schema (migration 010) | `apps/api/src/db/migrations/010_mentor_scoring.sql` |
| Evidence gathering, period close, recalculation | `apps/api/src/modules/mentorScoring/mentorScoring.calc.ts` |
| Reads, flags, configuration, periods | `apps/api/src/modules/mentorScoring/mentorScoring.service.ts` |
| Routes | `apps/api/src/modules/mentorScoring/mentorScoring.routes.ts` |
| Tests | `packages/shared/test/mentorScoring.test.ts`, `apps/api/test/integration/mentorScoring.test.ts` |

## How a score is made

```
overall     = 0.40 · compliance  + 0.60 · reliability
compliance  = 0.60 · coverage    + 0.20 · duration  + 0.20 · spot
reliability = 0.50 · inflation   + 0.50 · contradiction
```

All weights and thresholds are configuration, not constants (`MentorScoreConfig`).
A metric with nothing to measure is *not applicable* and its weight is rescaled across the
rest of its component. A mentor with no eligible visit, or no quality checks at all, gets
**Insufficient data**, never a zero. Below the minimum evidence (default 5 visits and 20
checks) the score is **Provisional**.

Only **confirmed** flags reduce reliability. Flagged and dismissed records cost nothing.

## Lifecycle

1. Mentors submit visits (`POST /mentor/visits`, idempotent on a client-generated UUID).
2. A rule engine or reviewer raises flags (`POST /admin/flags`).
3. Reviewers decide flags (`POST /admin/flags/:id/decision`); every action is stored in
   `audit_reviews` and `audit_logs`.
4. `POST /admin/periods/:id/close` binds the period to the configuration version in force
   at its start, scores every mentor, and snapshots benchmarks. Closed scores are rows,
   not computations: editing configuration later cannot move them.
5. Reports stay hidden from mentors (**shadow mode**) until `POST /admin/periods/:id/publish`.
6. A flag confirmed after its period closed is applied under the configured policy:
   `carryover` (default) adds it to the next period's close, once; either way an admin
   can run an audited `POST /admin/recalculate`, which writes a new score version and a
   `score_events` row and keeps the old version.

## API

| Endpoint | Who | Notes |
|---|---|---|
| `GET /mentor/report-card?period_id=` | mentor | Own data only; no mentor id parameter exists |
| `GET /mentor/report-card/:periodId/evidence` | mentor | Visits and flags, plain-language reasons |
| `GET /mentor/history` | mentor | Published periods with deltas |
| `POST /mentor/visits` | mentor | `201` created, `200` replay |
| `GET /admin/scores`, `GET /admin/scores/:mentorId` | manager (reporting line), admin | List + aggregates; drill-down |
| `GET/POST /admin/flags`, `POST /admin/flags/:id/decision` | manager (reporting line), admin | Escalated flags: admin only; no self-review |
| `GET /admin/config`, `POST /admin/config/preview`, `POST /admin/config/publish` | admin | Versions are immutable (trigger-enforced) |
| `GET/POST /admin/periods`, `POST /admin/periods/:id/close`, `…/publish` | admin | |
| `POST /admin/recalculate` | admin | Reason required |
| `PUT /admin/mentors/:userId/profile`, `POST /admin/exclusions` | admin | Mentor setup; training/outage/closure days |

Roles map onto the existing ones: member = mentor, manager = block/district reviewer and
NP reviewer, admin = state program admin.

## Decisions and deviations from the PRD

* **Appendix A arithmetic.** The PRD prints compliance 86.20 and overall 91.28; its own
  inputs give 86.46 and 91.38 (displayed 91 either way). The tests assert the corrected
  values. Worth confirming with the program team.
* **Preview is a `POST`.** The PRD lists `GET /admin/config/preview`; a candidate
  configuration is a document, so it is sent in a body.
* **Coverage when little is expected.** Expected visits are prorated fractions and used as
  is; the PRD's `max(expected, 1)` guard is applied as "not applicable at zero".
* **Benchmark cap.** Benchmarks are a median with one value per mentor, which bounds any
  one mentor's influence; the separate 5% cap only matters for sum-based aggregates.
* **Recognition** quality floor and "no open flag" apply to every category, not just the top one.
* **Duplicates** are resolved among otherwise valid visits, so an abandoned attempt never
  absorbs the real visit that follows it.

## Mentor screens (web)

| Screen | Route | File |
|---|---|---|
| M1 entry card (home) + nav link | `/` , sidebar | `components/mentor/ReportCardEntry.tsx` |
| M2 overall report card | `/mentor`, `/mentor/:periodId` | `pages/mentor/ReportCardPage.tsx` |
| M3 compliance detail | `/mentor/:periodId/compliance` | `ComplianceDetailPage.tsx` |
| M4 data reliability detail | `/mentor/:periodId/reliability` | `ReliabilityDetailPage.tsx` |
| M5 flags / review status | `/mentor/:periodId/records` | `FlagsPage.tsx` |
| M6 score history | `/mentor/history` | `HistoryPage.tsx` |
| M7 suggestions | `/mentor/:periodId/feedback` | `FeedbackPage.tsx` |

The entry card and nav link render nothing until a published card exists, so non-mentors
never see them. Status and change are always a glyph plus words, and a drop in score is
neutral grey, not red. All wording is in `components/mentor/format.ts`, ready to translate.

## Reviewer and admin screens (web)

All under `/mentor-admin`, shown to managers (their reporting line) and admins. Filters live in
the URL, so a view can be linked.

| Screen | Route | Notes |
|---|---|---|
| A1 overview | `/mentor-admin` | Summary cards, score histogram with quartiles, 6-period trend (compliance and reliability as separate charts), inflation/contradiction confirmed vs flagged |
| A2 mentor list | `/mentor-admin/mentors` | Sortable; links to the report card and audit history |
| A3 drill-down | `/mentor-admin/mentors/:id` | Drivers with numerator/denominator/rule version, visits, flags, reviews, score events; recalculation (admin); CSV export |
| A4 flag queue | `/mentor-admin/flags` | Filters incl. rule and age; evidence pane; start review / confirm / dismiss / escalate / note with reason codes |
| A5 configuration | `/mentor-admin/config` (admin) | Weights, thresholds, role targets, effective date, preview, publish, version history, and period close/publish |
| A6 benchmarks | `/mentor-admin/benchmarks` | Frozen snapshots with cohort, window, statistic, cap method; members visible to admins only |
| A7 recognition | `/mentor-admin/recognition` | Positive categories only; ineligible mentors are counted, never named |

Added for these screens: `GET /admin/trend`, `/admin/mentor-filters`, `/admin/flags/:id`,
`/admin/benchmarks`, `/admin/recognition`, `/admin/config/versions`, and `rule_code` /
`min_age_days` flag filters.

Behaviour worth knowing: in A1, flagged/confirmed/dismissed counts belong to the period of the
*visit*, while the rate is what was applied to scores in that period, so a late confirmation
shows in the visit's period as an issue and in the next period's rate.

## Not built yet (needs input or follows)

* Hindi message catalogues (the screens' wording is centralised,
  and the API returns nudge codes, parameters and an English default).
* **Visit source.** TeamSpace has no mentoring flow, so `mentoring_visits` is a minimal
  intake table. When the real Shiksha MP visit tables are available, replace
  `loadPeriodVisits` and keep the engine as is.
* **Quality rules** (inflation/contradiction detection) are undefined in the PRD (§17.1);
  flags are created through the API, and `inflation_checks`/`consistency_checks` per visit
  are supplied by whatever evaluates them.
* Recognition **announcements** (opt-in channels), A7 only identifies winners. Many mentors can
  tie at 100 on reliability, in which case every tied mentor is listed.
* Mid-period **transfer and role-change** segmentation, in-app notifications, and the
  pilot KPI dashboard/export (§15, §19.8).
* Visit edits after submission: a recalculation picks them up, but there is no edit endpoint.
