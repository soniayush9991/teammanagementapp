# 3. Feature breakdown

Status key: **Built** — implemented and tested in this repository ·
**Planned** — designed, scheduled in the [roadmap](16-roadmap.md).

## 3.1 Team dashboard

| Capability | Audience | Status | Notes |
|---|---|---|---|
| Total team capacity | Manager | Built | Contracted hours minus approved leave and holidays |
| Available bandwidth per person | Manager | Built | Clamped at zero; surplus shown separately as over-allocation |
| Active assignment count | Manager | Built | Open tasks with at least one assignee |
| Overloaded vs underutilized | Manager | Built | Counted from bands, shown as badges |
| Upcoming deadlines | Manager | Built | Next ten open tasks with a due date |
| Work distribution chart | Manager | Built | Planned hours and task count per person |
| Today's tasks | Member | Built | Due today, or in progress |
| Weekly workload | Member | Built | Everything due inside the ISO week |
| Personal utilization | Member | Built | Same formula as the manager view |
| Recent conversations | Member | Built | Six most recent, with unread counts |
| Pending mentions | Member | Built | Unread `mention` notifications |

## 3.2 Task management

Every task carries: title, description, priority, status, assignees, creator,
due date, start date, estimated effort, remaining effort, logged hours, labels,
attachments, comments and an activity history.

| Capability | Status | Rules that matter |
|---|---|---|
| Kanban view | Built | Six columns; drag-and-drop **and** a keyboard select for every card |
| List view | Built | Filter by status, priority, label, overdue; keyset pagination |
| Calendar view | Built | Four-week grid of due dates |
| Bulk assignment | Built | Partial failures are reported per task, not rolled back |
| Recurring tasks | Built | Daily/weekly/biweekly/monthly; monthly clamps to short months |
| Dependencies | Built | `blocks` dependencies are cycle-checked before insert |
| Subtasks | Built | Exactly one level; a parent cannot close with open children |
| Attachments | Built | Presigned direct-to-S3 upload; the API never proxies bytes |
| Comments | Built | Notifies assignees and the creator |
| Activity history | Built | One row per changed field, with before and after |

**Status transitions are constrained.** `backlog → done` is refused with the
list of legal moves attached, so a board cannot produce a task that was never
started but is somehow finished.

**Completion is guarded.** A task cannot move to `done` while an open
`blocks` dependency or an open subtask exists. The error names the blockers.

## 3.3 Bandwidth and capacity planning

Per employee: weekly capacity hours, planned workload, actual logged workload,
utilization percentage, and a leave/holiday calendar.

Computed automatically:

```
effectiveCapacity = weeklyCapacity − leaveHours − holidayHours   (floored at 0)
availableHours    = max(0, effectiveCapacity − plannedHours)
overAllocation    = max(0, plannedHours − effectiveCapacity)
utilization       = plannedHours / effectiveCapacity
```

| Band | Condition | Colour | Non-colour cue |
|---|---|---|---|
| Underutilized | `< 60%` | Blue | `○ Has bandwidth` |
| Healthy | `60–85%` | Green | `● Healthy` |
| Near capacity | `85–100%` | Amber | `◐ Near capacity` |
| Overloaded | `> 100%` | Red | `▲ Overloaded` |

Colour is never the only signal: every band carries a glyph and the numeric
percentage, so the state survives greyscale printing and colour blindness.

Edge cases that are handled and tested: a person fully on leave with work still
planned reports infinite utilization and the `overloaded` band rather than
dividing by zero; leave longer than the contracted week is clamped; tasks with
no due date count against the current week rather than disappearing.

## 3.4 Assignment planning

| Capability | Status | Notes |
|---|---|---|
| Drag tasks between employees | Built | Planner page; each person is a drop zone |
| Compare workloads before assigning | Built | `GET /assignments/compare` projects the week after the move |
| Skill tags per employee | Built | Controlled vocabulary in `skills`, not free text |
| Recommend the best assignee | Built | Blends skill match with post-assignment availability |

The recommender scores `skillWeight × skillMatch + (1 − skillWeight) ×
availability`, where availability decays to zero as the assignment would push
someone past capacity. Ties break on open task count, then name, so the same
inputs always produce the same ranking. Missing skills are reported so a
manager can override knowingly rather than being told only "no".

## 3.5 Messaging and collaboration

| Capability | Status | Notes |
|---|---|---|
| Direct messages | Built | Exactly one per pair, enforced by a sorted-pair unique index |
| Group chats | Built | Private by default |
| Public team channels | Built | Joinable by anyone in the organization |
| Private groups | Built | Invite-only, managed by owner/admin |
| Threaded replies | Built | Reply count on the parent; thread panel in the UI |
| Emoji reactions | Built | Toggle semantics, attributed to the user |
| Mentions | Built | `@[Name](uuid)` markup; resolved only to conversation members |
| File sharing | Built | Presigned upload, presigned download, expiring links |
| Read receipts | Built | Watermark per member, plus per-message rows where wanted |
| Typing indicators | Built | Transient socket frames; never persisted |

A mention of someone outside the conversation is **dropped, not delivered** —
otherwise `@`-ing an outsider would leak private content through a notification.

## 3.6 Groups

Create groups, invite members, assign group admins, link tasks to a group, pin
messages and share documents — all built. Ownership is singular and cannot be
abandoned: the owner must hand over before leaving a group that still has
members.

## 3.7 Notifications

Triggered by: new assignments, approaching due dates, overdue work, mentions,
group invitations, status changes and comments.

| Channel | Status | Notes |
|---|---|---|
| In-app | Built | Pushed over the socket, badge updates without polling |
| Email | Built (seam) | The `notifications` table is the outbox; a provider client drops into `mailer.ts` |

Deadline reminders are deduplicated by `(user, kind, entity, day)`, so an
hourly job cannot spam someone about the same task twice in a day.

## 3.8 Reports and analytics

| Report | Status | Export |
|---|---|---|
| Employee workload | Built | CSV, PDF |
| Capacity utilization | Built | CSV, PDF |
| Task completion trend | Built | CSV, PDF |
| Overdue tasks | Built | CSV, PDF |
| Team productivity | Built | CSV, PDF |
| Assignment history | Built | CSV, PDF |

CSV output is BOM-prefixed for Excel and **neutralises formula injection** — a
task titled `=cmd|...` is escaped so it cannot execute when the export is
opened. PDF generation is dependency-free and paginates automatically.
