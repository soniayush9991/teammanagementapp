# 15. Analytics and reporting

## Metric definitions

Every number below is computed by one function, used by the screen, the report
and the export alike. A report can never disagree with the dashboard it came
from, because they are literally the same code.

| Metric | Definition | Source |
|---|---|---|
| **Weekly capacity** | Contracted hours, or the `capacity_weeks` override for that week | `users.weekly_capacity_hours` |
| **Leave hours** | Working days (Mon–Fri) of approved leave inside the week × hours per day, clamped to the week | `leave_requests`, `holidays` |
| **Effective capacity** | `max(0, capacity − leave − holidays)` | computed |
| **Planned hours** | Sum of open assignments due in the week; `allocated_hours` when split, else the task's `remaining_hours` | `task_assignees`, `tasks` |
| **Logged hours** | Time actually recorded | `work_logs` |
| **Available hours** | `max(0, effective − planned)` | computed |
| **Over-allocation** | `max(0, planned − effective)` | computed |
| **Utilization** | `planned / effective`; infinite when effective is 0 and work exists | computed |
| **Band** | `<60%` underutilized · `60–85%` healthy · `85–100%` near capacity · `>100%` overloaded | computed |
| **Cycle time** | Days from `created_at` to `completed_at` | `tasks` |
| **Overdue** | Open and `due_date < today` | `tasks` |

### Decisions worth stating

**Availability is floored at zero and over-allocation reported separately.**
A single signed number would hide the difference between "exactly full" and
"eight hours underwater".

**Undated work counts against the current week.** The alternative — excluding
it — would make a backlog of unestimated, undated tasks look like free
capacity, which is the opposite of the truth.

**Utilization divides by *effective* capacity, not contracted.** Someone on
three days' leave with two days of work booked is at 100%, not 40%. Dividing by
contracted hours would report them as having spare time they do not have.

**A person fully on leave with work still planned reports infinite
utilization** and the overloaded band, rather than `NaN` or a silent zero.

## The six reports

| Report | Answers | Shape |
|---|---|---|
| **Employee workload** | Who is over, who is under, right now | Row per person: capacity, leave, planned, available, utilization, band, open and overdue counts |
| **Capacity utilization** | Is the team trending toward a crunch | Row per ISO week: capacity, planned, utilization, overloaded headcount |
| **Task completion trend** | Are we finishing as fast as we start | Row per day: created, completed, logged hours — a gapless date series so a quiet day is a zero, not a gap |
| **Overdue tasks** | What is late and who holds it | Row per task: key, title, status, priority, due date, days late, assignees, remaining |
| **Team productivity** | Throughput per person over a window | Row per person: completed, logged hours, average cycle time, overdue now |
| **Assignment history** | Who moved what, and when | Row per event: timestamp, task, action, assignee, previous assignee, actor |

### On the productivity report

Throughput is reported **alongside** cycle time and logged hours, never alone.
A high completed-task count on trivial work is not more output than a low count
on hard work, and a metric presented without that context invites exactly that
misreading. This report is for spotting a person who is stuck, not for ranking
a team.

## Exports

One endpoint serves every report in both formats:

```
GET /reports/:name/export?teamId=…&format=csv|pdf
```

The report name selects the columns; the format selects the serialiser. Adding
a report means adding columns in one place, not two more routes.

### CSV

RFC 4180: CRLF line endings, quotes doubled inside quoted fields, UTF-8 BOM so
Excel detects the encoding rather than mangling accented names.

**Formula injection is neutralised.** A cell beginning `=`, `+`, `-`, `@`, tab
or carriage return is prefixed with an apostrophe, so a task titled
`=HYPERLINK("http://evil","click")` is displayed rather than executed when the
export is opened in Excel or Sheets. This is a genuine attack path: the content
is user-supplied and the recipient is usually someone senior.

### PDF

A dependency-free writer (`lib/pdf.ts`) emits a landscape A4 table using the
standard Helvetica font that every reader has built in. It paginates
automatically, numbers the pages, and escapes the PDF string delimiters
`\`, `(` and `)` so data cannot break the content stream.

The alternative — a headless browser rendering HTML — would add a large binary
and a rendering service to the deployment for output that is a table.

## Dashboard aggregates

| Surface | Query shape |
|---|---|
| Manager dashboard | One capacity query plus four parallel aggregates: counts, deadlines, distribution, status breakdown |
| Member dashboard | Capacity, today, this week, overdue, conversations, notifications — issued in parallel |
| Reporting views | `v_open_allocations`, `v_user_week_load`, `v_task_completion_daily`, `v_conversation_unread` keep the joins in one place |

## Correctness

Rather than asserting fixed numbers, the integration suite asserts
**invariants**, which survive changes to the seed data:

- Availability is never negative for anyone.
- Over-allocation implies zero availability and the overloaded band.
- The workload report and the capacity endpoint agree, person by person, on
  both planned hours and band.
- Every row in the overdue report is genuinely past due and genuinely open.
- The completion trend returns exactly one row per day in the range.
- Exports are downloadable, correctly typed, BOM-prefixed and valid PDFs.
