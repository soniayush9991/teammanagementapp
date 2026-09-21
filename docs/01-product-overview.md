# 1. Product overview

## The problem

Managers routinely answer three questions with spreadsheets and guesswork:

1. **Who has room for this?** Assignment decisions get made on gut feel, so the
   reliable person quietly absorbs 120% of a week while someone else idles.
2. **Is this going to land?** Progress lives in people's heads until the day
   something is due.
3. **What did we decide?** The reasoning behind a decision sits in a chat
   history that is unsearchable, or already deleted.

Task trackers answer the second question. Chat tools answer the third, badly.
Almost nothing answers the first, because capacity is only meaningful when it
is joined to assignments, estimates and leave — data that normally lives in
three different systems.

## What TeamSpace is

A team management platform that keeps **work, capacity and conversation in one
data model**, so a manager can see that a task is due Friday, that the person
holding it is already at 125% after their approved leave, and that the last
three messages about it explain why.

## Principles

| Principle | What it means in practice |
|-----------|---------------------------|
| **Capacity is a first-class citizen** | Every task carries remaining effort; every person carries contracted hours and leave. Utilization is computed, never typed in. |
| **One number, one definition** | "Planned hours" is defined once, in `packages/shared/src/capacity.ts`, and used by the dashboard, the planner, the reports and the CSV export. A report can never disagree with the screen it was exported from. |
| **Honest over flattering** | Over-allocation is shown as over-allocation, not clipped to 100%. Nobody is helped by a green bar that hides a problem. |
| **The server decides** | Hiding a button is a courtesy. Every permission is enforced again on the API, scoped to the specific record. |
| **History has a shelf life** | Conversations are retained for 365 days and then genuinely deleted, by design and by default. |

## Users

| User | Their day | What they need most |
|------|-----------|---------------------|
| **Manager** — runs a team of 4–12 | Plans a week, unblocks people, reports up | To see load and act on it in the same screen |
| **Team member** — does the work | Picks up tasks, updates progress, discusses | To know what is on them today without a meeting |
| **Admin** — runs the platform | Onboards people, sets policy, answers audits | Control over roles, retention and a trustworthy audit trail |

## Scope

**In scope for v1** — teams, tasks with subtasks and dependencies, capacity and
leave, assignment planning with recommendations, messaging with threads and
mentions, groups and channels, notifications, reports with CSV and PDF export,
full-text search, 365-day retention, role-based access control, audit logging.

**Explicitly out of scope for v1** — time-off accrual policies, payroll or
billing, cross-organization federation, native mobile apps, and OKR tracking.
These are covered in [Future enhancements](17-future-enhancements.md).

## What "done" looks like

- A manager opens the dashboard and can name their overloaded person in under
  five seconds.
- A member opens their page and knows what to do today without asking.
- A year-old conversation can be found by keyword in under a second.
- An auditor can be shown who changed a role, when, and from what.
