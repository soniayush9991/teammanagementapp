# 6. Low-fidelity wireframes

Eight screens. Each is described as a layout, the states it must handle, and
the accessibility decisions that are not obvious from the picture.

The persistent frame is the same everywhere: a 236px sidebar, a 56px top bar
with search and the notification bell, and a scrolling main region that carries
the skip-link target.

---

## 6.1 Manager dashboard — `/team`

```
┌──────────┬──────────────────────────────────────────────────────────────┐
│ SIDEBAR  │ [ search…                    /  ]        ◔ 3   MO Maya ▾     │
│          ├──────────────────────────────────────────────────────────────┤
│ My work  │ Team dashboard                            [ Platform    ▾ ]  │
│ Team ◀   │ Week 2026-W39 · 4 people                                     │
│          │                                                              │
│ WORK     │ ┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐ │
│ Board    │ │CAPACITY││PLANNED ││UTILIZ. ││ FREE   ││ ACTIVE ││OVERDUE │ │
│ Tasks    │ │  136h  ││   67h  ││  49%   ││  75h   ││   8    ││   1    │ │
│ Calendar │ └────────┘└────────┘└────────┘└────────┘└────────┘└────────┘ │
│ Planner  │                                                              │
│          │ ┌── Bandwidth by person ───── [1 overloaded][2 with room] ─┐ │
│ COLLAB.  │ │ PERSON        CAP  PLAN  AVAIL  UTILIZATION  STATUS  OPEN│ │
│ Messages │ │ ○ Lin Chen    40h    5h    35h  ▓░░░░░  13%  ○Room    1  │ │
│ Groups   │ │ ○ Maya O.     40h    0h    40h  ░░░░░░   0%  ○Room    0  │ │
│          │ │ ○ Priya Nair  40h   42h     0h  ▓▓▓▓▓▓ 105%  ▲Over    5  │ │
│ INSIGHT  │ │ ○ Tom Berg    16h   20h    −4h  ▓▓▓▓▓▓ 125%  ▲Over    3  │ │
│ Reports  │ └──────────────────────────────────────────────────────────┘ │
│          │ ┌── Work distribution ──┐ ┌── Upcoming deadlines ──────────┐ │
│          │ │ Lin   ▓▓░░░░   9h · 1 │ │ ● PLAT-9  Stale sockets  2d late│ │
│          │ │ Priya ▓▓▓▓▓▓  42h · 5 │ │ ● PLAT-2  FTS indexes    Due 1d │ │
│          │ └───────────────────────┘ └────────────────────────────────┘ │
└──────────┴──────────────────────────────────────────────────────────────┘
```

**States.** Loading (skeleton rows) · empty (no team → "you do not manage a
team yet") · error (retry button) · nobody overloaded (the red badge is absent,
not zero).

**Accessibility.** The bandwidth table is a real `<table>` with a `<caption>`
and row headers. Each meter is `role="meter"` with `aria-valuenow`. The status
column repeats the band as text with a glyph, so the red bar is never the only
carrier of "overloaded".

---

## 6.2 Team member dashboard — `/`

```
┌──────────────────────────────────────────────────────────────┐
│ Good to see you, Sam                                         │
│ Week 2026-W39 · 3 tasks in focus today                       │
│ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐             │
│ │THIS WEEK ││UTILIZ.   ││ SPARE    ││ OVERDUE  │             │
│ │   18h    ││   45%    ││   22h    ││    0     │             │
│ │of 40h    ││          ││Room      ││On track  │             │
│ └──────────┘└──────────┘└──────────┘└──────────┘             │
│ ┌── Your week ─────────────────────────────────────────────┐ │
│ │ ▓▓▓▓░░░░░░░░░│░░░░░                    ● Healthy         │ │
│ │ 8h of leave is already deducted from this week.          │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌── Today ─────────────────┐ ┌── Due this week ───────────┐  │
│ │ ● Kanban board   9h  1d  │ │ EXP-1 Kanban board  Due 3d │  │
│ │ ● Chat panel    12h  9d  │ │ EXP-3 Chat panel    Due 9d │  │
│ └──────────────────────────┘ └────────────────────────────┘  │
│ ┌── Recent conversations ──┐ ┌── Mentions waiting ────────┐  │
│ │ #platform-standup  ②  3h │ │ Maya mentioned you in …    │  │
│ └──────────────────────────┘ └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**States.** Nothing due today is a genuine empty state ("enjoy the quiet, or
pull something forward"), not a blank box. Overdue only appears when there is
something overdue.

---

## 6.3 Task detail — `/tasks/:key`

```
┌──────────────────────────────────────────────────────────────┐
│ Partition the messages table by month      [ in progress ▾ ] │
│ PLAT-1 · created 6d ago                                      │
│ ┌── Description ───────────────────┐ ┌── Details ──────────┐ │
│ │ Retention needs partition drops  │ │ ASSIGNEES           │ │
│ │ rather than bulk deletes.        │ │ ○ Priya Nair   16h  │ │
│ └──────────────────────────────────┘ │ PRIORITY  ● high    │ │
│ ┌── Progress ──────────────────────┐ │ DUE       Due in 2d │ │
│ │ ▓▓▓▓▓▓░░░░░░░░  4h of 16h        │ │ LABELS  postgres    │ │
│ │ [Log hours][Log work][Remaining] │ │ SUBTASKS  1 of 3    │ │
│ └──────────────────────────────────┘ └─────────────────────┘ │
│ ┌── Comments (2) ──────────────────┐ ┌── Dependencies ─────┐ │
│ │ [ write a comment…      ][Send]  │ │ Blocks              │ │
│ │ ○ Maya  Can we get ranking…  2h  │ │ PLAT-5 Nightly job  │ │
│ │ ○ Priya Yes — setweight A…   1h  │ └─────────────────────┘ │
│ └──────────────────────────────────┘ ┌── Activity ─────────┐ │
│                                      │ Maya moved it from  │ │
│                                      │ todo to in_progress │ │
│                                      └─────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Rules made visible.** The status control offers every status but the server
refuses illegal moves, and the toast names the legal ones. Attempting to close
a blocked task names the blockers.

---

## 6.4 Kanban board — `/board`

```
┌────────────┬────────────┬────────────┬────────────┬──────────┐
│ Backlog  1 │ To do    4 │ In prog. 2 │ In review 1│ Done   1 │
├────────────┼────────────┼────────────┼────────────┼──────────┤
│ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │          │
│ │PLAT-7 ●│ │ │PLAT-3 ●│ │ │PLAT-1 ●│ │ │PLAT-4 ●│ │          │
│ │Overdue │ │ │Refresh │ │ │Partition│ │ │Capacity│ │          │
│ │digest  │ │ │rotation│ │ │messages │ │ │rollup  │ │          │
│ │[node]  │ │ │4h  ○PN │ │ │16h  ○PN │ │ │8h  ○TB │ │          │
│ │Due 12d │ │ │Due 3d  │ │ │Due 2d   │ │ │Due 4d  │ │          │
│ │[move ▾]│ │ │[move ▾]│ │ │1/3 subs │ │ │[move ▾]│ │          │
│ └────────┘ │ └────────┘ │ └────────┘ │ └────────┘ │          │
└────────────┴────────────┴────────────┴────────────┴──────────┘
```

**Accessibility.** Drag-and-drop is an enhancement, never the only route: each
card carries a `move to` select, labelled for screen readers. The drop target
is indicated by border and background, not colour alone.

---

## 6.5 Capacity planner — `/planner`

```
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ ○ Priya Nair      ▲Overload │ │ ○ Lin Chen         ○ Room    │
│   Backend Engineer          │ │   QA Engineer               │
│   ▓▓▓▓▓▓▓▓▓▓│▓▓  105%       │ │   ▓▓░░░░░░░░│░░░   13%      │
│   42h planned of 40h        │ │   5h planned of 40h         │
│   [node][postgres][k8s]     │ │   [testing][automation]     │
│   ┌───────────────────────┐ │ │   ┌───────────────────────┐ │
│   │ PLAT-1  Partition 16h │ │ │   │ PLAT-6  Regression 5h │ │
│   │ PLAT-2  FTS index 12h │◀┼─┼──▶│                       │ │
│   └───────────────────────┘ │ │   └───────────────────────┘ │
│                             │ │   After drop: 17h → 43%     │
└─────────────────────────────┘ └─────────────────────────────┘
```

The projection line appears on the hovered target **while dragging**, so the
consequence is visible before the commitment.

---

## 6.6 Chat — `/chat/:id`

```
┌─────────────┬────────────────────────────────┬──────────────┐
│ #platform ◀ │ #platform-standup   4 members  │ Thread     ✕ │
│   22m       │ Daily async standup            │              │
│ ○ Priya  ①  ├────────────────────────────────┤ ○ Priya      │
│   3h        │ ○ Priya  3h                    │ Standup: …   │
│ #general    │   Standup: partitioning is in  │ ──────────── │
│   1d        │   review, search indexes next. │ ○ Maya       │
│ Q4 planning │   [🚀 1]  1 reply              │ Nice. @Priya │
│             │                                │ can you note │
│             │ ○ Maya  33m                    │ the window?  │
│             │   Retention is 365 days —      │              │
│             │   @Priya Nair please confirm.  │ [ reply… ]   │
│             │   [👍 1]  1 reply              │              │
│             ├────────────────────────────────┤              │
│             │ Priya is typing…               │              │
│             │ [ Write a message…    ][Send]  │              │
└─────────────┴────────────────────────────────┴──────────────┘
```

**States.** Typing indicator is a reserved-height live region, so its
appearance never reflows the transcript. Deleted messages remain as a tombstone
so thread structure survives. Mentions render as highlighted text nodes, never
as injected HTML.

---

## 6.7 Group management — `/groups`

```
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ # general          [public]   │ │ ◍ Q4 planning     [private]   │
│ Anything and everything       │ │ Roadmap and staffing          │
│ 7 members   [Members][Join]   │ │ 3 members  [Members][Owner]   │
└───────────────────────────────┘ └───────────────────────────────┘

  Members dialog
  ┌──────────────────────────────────────────┐
  │ Members of Q4 planning                ✕  │
  │ [ Choose someone to invite…  ▾][Invite]  │
  │ ○ Maya Okonkwo   [owner]                 │
  │ ○ Ana Duarte     [admin]      [Remove]   │
  │ ○ Noor Haddad          [Make admin][Rm]  │
  └──────────────────────────────────────────┘
```

The dialog traps focus, closes on Escape and restores focus to the control that
opened it.

---

## 6.8 Reports — `/reports`

```
┌──────────────────────────────────────────────────────────────┐
│ Reports                    [Platform ▾][Export CSV][Export PDF]│
│ Capacity, planned hours and utilization per person.           │
│ [Workload][Utilization][Completion][Overdue][Productivity]    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ EMPLOYEE      CAP  LEAVE PLAN  AVAIL  UTILIZATION   OPEN │ │
│ │ Lin Chen      40h    0h    5h    35h  ▓░░░░  13%      1  │ │
│ │ Priya Nair    40h    0h   42h     0h  ▓▓▓▓▓ 105%   5 [2] │ │
│ │ Tom Berg      32h   16h   20h    −4h  ▓▓▓▓▓ 125%   3 [1] │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

The report switcher is a set of toggle buttons with `aria-pressed`, not a
select, because there are few options and switching is the main action.

---

## Responsive behaviour

| Breakpoint | Change |
|---|---|
| `> 960px` | Full three-region shell |
| `≤ 960px` | Sidebar becomes an off-canvas drawer behind a toggle; chat collapses to a single pane; the planner and board scroll horizontally |
| `≤ 480px` | Metric tiles stack one per row; tables scroll horizontally inside their card rather than squashing |

Verified at 390px: no horizontal page scroll.
