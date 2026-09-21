# 11. API specification

Base URL `/api/v1`. JSON in, JSON out. Authentication is a bearer access token;
the refresh token is an httpOnly cookie. Every endpoint below is implemented.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <accessToken>` on everything except login and refresh |
| Errors | `{ "error": { "code", "message", "details?", "requestId" } }` |
| Lists | `{ "items": [...] }`; paginated lists add `nextCursor` |
| Pagination | Opaque keyset cursor: `?limit=25&cursor=…` |
| Dates | `YYYY-MM-DD`; timestamps are ISO 8601 UTC |
| Weeks | ISO week keys, `2026-W39` |
| Tasks | Addressable by UUID **or** key (`PLAT-214`) |

### Status codes

`200` ok · `201` created · `204` no content · `400` malformed · `401`
unauthenticated · `403` authenticated but not permitted · `404` not found or
not visible · `409` conflict · `422` valid shape, invalid meaning · `429` rate
limited · `503` timed out

---

## Authentication

### `POST /auth/login`

```json
{ "email": "maya@teamspace.dev", "password": "TeamSpace!2026" }
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs…",
  "expiresIn": 900,
  "user": {
    "id": "b290fc99-…", "email": "maya@teamspace.dev",
    "displayName": "Maya Okonkwo", "role": "manager",
    "jobTitle": "Engineering Manager", "timezone": "Europe/Lisbon",
    "skills": ["leadership", "planning"], "weeklyCapacityHours": 40,
    "managerId": "0f1e…", "isActive": true, "avatarUrl": null
  },
  "permissions": ["team:create", "task:assign", "capacity:read_team", "…"]
}
```

Also sets `teamspace_rt=<token>; HttpOnly; SameSite=Strict; Path=/api/v1/auth`.

A wrong password and an unknown account return the identical `401` body.

### `POST /auth/refresh`

Reads the cookie (or `{ "refreshToken": "…" }`). Returns the same shape as
login and rotates the cookie. A token replayed after rotation revokes every
session for that account; see [security](14-security-and-permissions.md).

### `POST /auth/logout` → `204` · `GET /auth/me` · `POST /auth/change-password`

```json
{ "currentPassword": "…", "newPassword": "At-least-12-chars" }
```
`204`. Every other session for that user is revoked.

---

## Users

| Endpoint | Purpose |
|---|---|
| `GET /users?search=&role=&teamId=&managerId=&includeInactive=&limit=&offset=` | Directory |
| `GET /users/:id` | One person, scope-checked |
| `GET /users/:id/reportees` | Direct reports |
| `POST /users` | Create (admin) |
| `PATCH /users/:id` | Update; field-level authorization |
| `DELETE /users/:id` | Deactivate (admin) |
| `GET /users/skills` | Skill vocabulary with usage counts |

`PATCH` enforces who may change what: anyone edits their own profile; a manager
edits a reportee's capacity and reporting line; only an admin changes `role` or
`isActive`. A reporting-line change that would create a cycle is refused `422`.

---

## Teams

| Endpoint | Purpose |
|---|---|
| `GET /teams` | Teams you can see |
| `POST /teams` | Create — `{ name, keyPrefix, description?, managerId?, memberIds? }` |
| `GET /teams/:id` · `PATCH /teams/:id` · `DELETE /teams/:id` | Read, update, archive |
| `GET /teams/:id/members` · `POST /teams/:id/members` · `DELETE /teams/:id/members/:userId` | Membership |

Archiving a team with open tasks is refused `409` with the open count.
Removing someone who still holds open tasks in that team is refused `409`.

---

## Tasks

### `GET /tasks`

`teamId`, `assigneeId`, `status` (csv), `priority` (csv), `label`, `dueBefore`,
`dueAfter`, `parentTaskId`, `includeSubtasks`, `overdueOnly`, `search`,
`limit`, `cursor`.

```json
{
  "items": [{
    "id": "7c1e…", "key": "PLAT-1", "teamId": "2c4a…", "parentTaskId": null,
    "title": "Partition the messages table by month",
    "status": "in_progress", "priority": "high",
    "assignees": [{ "userId": "5778…", "displayName": "Priya Nair",
                    "avatarUrl": null, "allocatedHours": 16 }],
    "dueDate": "2026-09-23", "startDate": null,
    "estimatedHours": 16, "remainingHours": 16, "loggedHours": 0,
    "labels": ["postgres", "retention"],
    "subtaskCount": 0, "completedSubtaskCount": 0,
    "commentCount": 2, "attachmentCount": 0,
    "recurrence": null,
    "createdAt": "2026-09-15T09:00:00.000Z",
    "updatedAt": "2026-09-21T11:04:00.000Z", "completedAt": null
  }],
  "nextCursor": "MjAyNi0wOS0xNVQwOTowMDowMC4wMDBafDdjMWU…"
}
```

### `POST /tasks`

```json
{
  "teamId": "2c4a…", "title": "Write the deployment runbook",
  "description": "Steps for a zero-downtime release",
  "priority": "high", "dueDate": "2026-09-30", "estimatedHours": 6,
  "assigneeIds": ["5778…"], "labels": ["docs"],
  "recurrence": { "frequency": "monthly", "interval": 1, "until": "2027-06-30" }
}
```
`201` with the full task.

### `PATCH /tasks/:idOrKey`

Illegal transition:

```json
{ "error": {
  "code": "unprocessable_entity",
  "message": "A task cannot move from backlog to done",
  "details": { "allowed": ["todo", "in_progress", "cancelled"] } } }
```

Blocked completion:

```json
{ "error": {
  "code": "conflict",
  "message": "This task is blocked by work that is still open",
  "details": { "blockedBy": ["PLAT-1"] } } }
```

### Other task endpoints

| Endpoint | Purpose |
|---|---|
| `GET /tasks/board?teamId=` | Kanban columns in order |
| `GET /tasks/calendar?from=&to=&teamId=&assigneeId=` | Tasks with due dates in range |
| `GET /tasks/:idOrKey` · `DELETE /tasks/:idOrKey` | Read, delete |
| `GET`/`POST /tasks/:idOrKey/comments` | Comments |
| `GET /tasks/:idOrKey/activity` | Field-level change log |
| `GET`/`POST /tasks/:idOrKey/dependencies`, `DELETE …/:dependencyId` | Dependencies |
| `POST /tasks/:idOrKey/work-logs` | `{ hours, loggedOn?, remainingHours?, note? }` |

Work logging burns down `remainingHours` automatically unless an explicit
re-estimate is supplied.

---

## Capacity

| Endpoint | Purpose |
|---|---|
| `GET /capacity/me?week=` | Your week |
| `GET /capacity/users/:id?week=` | Someone else's, scope-checked |
| `GET /capacity/teams/:id?week=` | Team view plus rollup |
| `GET /capacity/teams/:id/horizon?weeks=4` | Several weeks ahead |
| `PUT /capacity/overrides` | `{ userId, weekKey, capacityHours, note? }` |
| `GET`/`POST /capacity/leave` | List and request |
| `POST /capacity/leave/:id/decision` | `{ "decision": "approved" }` |

### `GET /capacity/teams/:id`

```json
{
  "teamId": "2c4a…", "weekKey": "2026-W39",
  "members": [{
    "userId": "9b2f…", "displayName": "Tom Berg", "jobTitle": "Full-stack Engineer",
    "skills": ["node", "postgres", "react"], "weekKey": "2026-W39",
    "capacity": {
      "weeklyCapacityHours": 32, "leaveHours": 16, "effectiveCapacityHours": 16,
      "plannedHours": 20, "loggedHours": 0,
      "availableHours": 0, "overAllocationHours": 4,
      "utilization": 1.25, "band": "overloaded"
    },
    "openTaskCount": 3, "overdueTaskCount": 1
  }],
  "rollup": {
    "totalCapacityHours": 152, "totalEffectiveCapacityHours": 136,
    "totalPlannedHours": 67, "totalAvailableHours": 75,
    "totalOverAllocationHours": 6, "utilization": 0.49,
    "overloadedCount": 2, "underutilizedCount": 2, "memberCount": 4
  }
}
```

---

## Assignments

| Endpoint | Purpose |
|---|---|
| `PUT /assignments/tasks/:idOrKey/assignees` | `{ userIds, allocations? }` |
| `POST /assignments/move` | `{ taskId, fromUserId, toUserId }` — the planner drag |
| `POST /assignments/bulk` | `{ taskIds, userIds }` |
| `GET /assignments/compare?teamId=&week=&estimatedHours=` | Projected load per person |
| `GET /assignments/recommend?taskId=&teamId=&skills=&estimatedHours=&limit=` | Ranked candidates |
| `GET /assignments/history?teamId=&userId=&from=&to=` | Who moved what, when |
| `PATCH /assignments/tasks/:idOrKey/allocation` | `{ userId, allocatedHours }` |

### `GET /assignments/recommend`

```json
{
  "weekKey": "2026-W39",
  "recommendations": [{
    "userId": "5778…", "displayName": "Priya Nair",
    "score": 0.5, "skillMatch": 1, "availabilityScore": 0,
    "matchedSkills": ["postgres"], "missingSkills": [],
    "band": "overloaded", "projectedUtilization": 1.25
  }, {
    "userId": "1a3c…", "displayName": "Lin Chen",
    "score": 0.34, "skillMatch": 0, "availabilityScore": 0.68,
    "matchedSkills": [], "missingSkills": ["postgres"],
    "band": "underutilized", "projectedUtilization": 0.33
  }]
}
```

### `POST /assignments/bulk`

```json
{ "assigned": ["PLAT-11"], "failed": [{ "taskId": "PLAT-999", "reason": "Task not found" }] }
```

---

## Conversations and messages

| Endpoint | Purpose |
|---|---|
| `GET /conversations?kind=&includePublic=&search=&limit=` | Your conversations with unread counts |
| `POST /conversations` | Create a group or channel |
| `POST /conversations/direct` | `{ userId }` — idempotent per pair |
| `GET`/`PATCH /conversations/:id` | Read, rename, retopic, change visibility |
| `GET`/`POST /conversations/:id/members`, `DELETE …/:userId`, `PUT …/:userId/role` | Membership |
| `POST /conversations/:id/join` · `POST /conversations/:id/leave` | Public channel join, leave |
| `PUT /conversations/:id/notification-level` | `all` \| `mentions` \| `none` |
| `GET`/`POST /conversations/:id/tasks` | Link work to a conversation |
| `GET /conversations/:id/messages?parentMessageId=&limit=&cursor=` | History or one thread |
| `POST /conversations/:id/messages` | Send |
| `PATCH`/`DELETE /conversations/:id/messages/:messageId` | Edit own, delete own or moderate |
| `POST /conversations/:id/messages/:messageId/reactions` | Toggle `{ emoji }` |
| `POST /conversations/:id/messages/:messageId/pin` · `GET /conversations/:id/pinned` | Pins |
| `POST /conversations/:id/read` | `{ messageId? }` |
| `GET /conversations/:id/attachments` | Shared files with presigned URLs |

### `POST /conversations/:id/messages`

```json
{ "body": "Retention window is 365 days — @[Priya Nair](5778…) please confirm.",
  "parentMessageId": null, "attachmentIds": [] }
```

```json
{
  "id": "d4251c89-…", "conversationId": "4554…", "parentMessageId": null,
  "authorId": "b290…", "authorName": "Maya Okonkwo", "authorAvatarUrl": null,
  "body": "Retention window is 365 days — @[Priya Nair](5778…) please confirm.",
  "mentions": ["5778…"], "reactions": [], "attachments": [],
  "replyCount": 0, "isPinned": false, "editedAt": null, "deletedAt": null,
  "createdAt": "2026-09-21T14:02:11.804Z", "readBy": ["b290…"]
}
```

Messages are routed to every subscribed socket as `message.created`, and the
mentioned user receives a `mention` notification. A mention of someone who is
not in the conversation resolves to nothing.

---

## Attachments

```
POST /attachments/upload-url
{ "fileName": "runbook.pdf", "contentType": "application/pdf",
  "byteSize": 284122, "scope": "message", "conversationId": "4554…" }

201 → { "attachmentId": "…", "uploadUrl": "https://…", "expiresIn": 300, "storageKey": "…" }
```

The client PUTs the bytes straight to object storage, then passes
`attachmentIds` when sending the message. `GET /attachments/:id/download-url`
re-derives access from the owning entity and returns a 5-minute link.

---

## Search

```
GET /search?q=retention&types=task,message,attachment&conversationId=&authorId=
           &teamId=&from=&to=&limit=20
```

```json
{ "items": [{
  "type": "task", "id": "9f2c…", "title": "PLAT-5 Nightly retention job",
  "snippet": "Drop expired partitions, purge orphan uploads.",
  "link": "/tasks/PLAT-5", "rank": 0.6079,
  "createdAt": "2026-09-15T09:00:00.000Z", "contextLabel": "Platform"
}] }
```

Snippets carry `<mark>` around matches. Quoted phrases and `-exclusions` are
accepted (`websearch_to_tsquery`). `GET /search/suggest?q=` powers typeahead.

---

## Reports

| Endpoint | Purpose |
|---|---|
| `GET /reports/workload?teamId=&week=` | Per-person capacity and load |
| `GET /reports/utilization?teamId=&weeks=8` | Week-by-week trend |
| `GET /reports/completion-trend?teamId=&from=&to=` | Created vs completed, gapless |
| `GET /reports/overdue?teamId=` | Everything late |
| `GET /reports/productivity?teamId=&from=&to=` | Throughput and cycle time |
| `GET /reports/:name/export?teamId=&format=csv\|pdf` | Download |

Export responses carry `Content-Disposition: attachment` and either
`text/csv; charset=utf-8` (UTF-8 BOM, CRLF, formula-injection guarded) or
`application/pdf`.

---

## Notifications

| Endpoint | Purpose |
|---|---|
| `GET /notifications?unreadOnly=&kind=&limit=&offset=` | `{ items, unreadCount }` |
| `POST /notifications/read` | `{ notificationIds }` |
| `POST /notifications/read-all` | Mark everything read |
| `GET`/`PUT /notifications/preferences` | Per-kind channel settings |

---

## Dashboard and admin

| Endpoint | Purpose |
|---|---|
| `GET /dashboard/manager?teamId=&week=` | Capacity, counts, deadlines, distribution |
| `GET /dashboard/me?week=` | Today, this week, overdue, conversations, mentions |
| `GET /dashboard/users/:id?week=` | A reportee's view, for a manager |
| `GET /dashboard/me/upcoming?days=7` | Next N days |
| `GET /admin/permissions` | The role matrix |
| `GET /admin/audit-logs?actorId=&action=&entityType=&from=&to=` | Audit trail |
| `GET`/`PUT /admin/retention-policies` | Retention configuration |
| `PATCH /admin/organization` | Org settings |
| `GET`/`POST /admin/holidays` | Holiday calendar |

## Health

`GET /healthz` — liveness · `GET /readyz` — database reachable.
