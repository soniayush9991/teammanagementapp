# 4. Information architecture

## Object model in one breath

An **organization** contains **users**. Users are grouped into **teams**, each
owned by a manager. Teams own **tasks**, which are assigned to users and
consume their **capacity**. Users talk in **conversations** — DMs, private
groups and public channels — which contain **messages**, optionally threaded.
Anything notable produces a **notification** for a person and an **audit log**
entry for the organization.

## Navigation

```
TeamSpace
├── My work                     (/)                      everyone
├── Team dashboard              (/team)                  capacity:read_team
├── WORK
│   ├── Kanban board            (/board?teamId=…)        everyone
│   ├── All tasks               (/tasks)                 everyone
│   │   └── Task detail         (/tasks/:key)            everyone
│   ├── Calendar                (/calendar)              everyone
│   └── Capacity planner        (/planner?teamId=…)      capacity:read_team
├── COLLABORATE
│   ├── Messages                (/chat, /chat/:id)       everyone
│   └── Groups                  (/groups)                everyone
├── INSIGHT
│   └── Reports                 (/reports?teamId=…)      report:read_team
└── ADMINISTRATION
    └── Admin                   (/admin)                 audit:read
        ├── Users
        ├── Audit trail
        ├── Retention
        └── Permissions
```

Sections a role cannot use are not rendered. Navigating to them directly still
yields an in-app "you do not have access" panel, and the API refuses the
underlying request regardless.

## URL design

| Pattern | Why |
|---|---|
| `/tasks/PLAT-214` | Human-readable keys, not UUIDs, so a link is quotable in chat and recognisable in a standup |
| `?teamId=…` on team-scoped pages | The selected team lives in the URL, so a shared link opens on the team the sender was looking at |
| `/chat/:conversationId?message=:id` | Deep-links to a specific message, which is what a mention notification needs |
| Filters in the query string | `/tasks?status=blocked&overdueOnly=true` is shareable and bookmarkable |

## Content hierarchy per screen

| Screen | First thing you see | Second | Third |
|---|---|---|---|
| My work | Am I overloaded? | What is due today | Conversations and mentions |
| Team dashboard | Team utilization and who is red | Bandwidth table per person | Distribution and deadlines |
| Kanban board | Columns and flow | A card's priority and owner | Labels and subtask progress |
| Task detail | Title and status | Progress and effort | Comments, then dependencies and activity |
| Capacity planner | Who has room | What each person holds | Skills, for the fit judgement |
| Chat | The conversation | Unread elsewhere | Threads |
| Groups | What exists and who is in it | Visibility | Membership controls |
| Reports | The chosen report's data | Export controls | Report switcher |

## Terminology

The product uses one word per concept, everywhere, including in the database:

| Concept | The word | Not |
|---|---|---|
| A unit of work | **task** | ticket, issue, item, card |
| Hours a person can work | **capacity** | availability, bandwidth (in data) |
| Hours already committed | **planned** | allocated, booked, scheduled |
| Hours still needed | **remaining** | left, outstanding, ETC |
| A chat space | **conversation** | room, thread (a thread is a reply chain) |
| A reply chain | **thread** | conversation, sub-chat |
