# 5. User flows

Nine journeys that carry the product. Each names its failure modes, because
those are where the design decisions live.

## 5.1 Sign in and session resume

```
Visitor → /login → credentials → POST /auth/login
   → access token (memory) + refresh cookie (httpOnly, SameSite=Strict)
   → redirect to the page they originally wanted
```

On a later cold load there is no token in memory, so the app calls
`POST /auth/refresh` **before** deciding the visitor is anonymous — otherwise a
page reload would bounce a signed-in user to the login screen.

*Failure modes.* Wrong password and unknown account return the identical
message, so the endpoint cannot enumerate accounts. Two refreshes racing (two
tabs, a retry, React's development double-effect) are tolerated by a ten-second
rotation grace window; a replay after that window revokes every session for the
account and writes an audit entry.

## 5.2 Manager plans the week

```
/team → read utilization → spot the red band
   → /planner → drag the task from the overloaded person to someone with room
   → projected utilization appears on the target before the drop
   → drop → PATCH assignment → capacity recalculates → assignee notified
```

*Failure modes.* Dropping on someone outside the team is refused (`422`, naming
the ineligible people). The optimistic move rolls back and toasts if the server
refuses.

## 5.3 Assigning with a recommendation

```
/planner → unassigned task → "Suggest"
   → GET /assignments/recommend?taskId=…
   → ranked list, each row showing matched skills, missing skills,
     and the utilization that person would land on
   → Assign
```

The recommendation is advice, not automation: the manager sees *why* someone
ranked first and can override with full information.

## 5.4 Member works a task

```
/ (My work) → today's list → /tasks/PLAT-42
   → move to "in progress" → log 4h → remaining burns down 8h → 4h
   → capacity.changed pushes to every open tab
   → blocked? → set status "blocked" → comment explaining why
```

*Failure modes.* Marking a blocked-by-open-work task as done is refused with
the blocking keys listed. Logging more hours than remaining floors remaining at
zero rather than going negative.

## 5.5 Requesting and approving leave

```
Member → /capacity → request 12–14 Oct
   → manager notified → approves
   → those weekdays are deducted from effective capacity
   → the member's utilization rises without any new work being assigned
```

*Failure modes.* Overlapping an existing request is refused (`409`). A person
cannot approve their own leave. Deciding twice is a conflict, not a silent
overwrite.

## 5.6 Conversation with a mention

```
/chat → channel → type "…@[Priya Nair](uuid) can you confirm?"
   → POST message → mentions resolved against conversation membership
   → mention notification to Priya only
   → realtime message.created to every subscribed socket
   → Priya's bell increments without polling
```

*Failure modes.* Mentioning someone who is not in the conversation resolves to
nothing and notifies nobody — the message does not leak.

## 5.7 Finding a decision from months ago

```
Any screen → "/" focuses search → "retention window"
   → GET /search across tasks, messages and attachments
   → ranked, highlighted results, each scoped to what the searcher may see
   → click → /chat/:id?message=:id, highlighted in place
```

## 5.8 Reporting to leadership

```
/reports → Employee workload → read on screen
   → Export CSV (opens cleanly in Excel, UTF-8 BOM, injection-safe)
   → or Export PDF (paginated, printable)
```

The exported numbers are produced by the same functions as the on-screen table,
so the two cannot disagree.

## 5.9 Admin handles a leaver

```
/admin → Users → deactivate
   → refresh tokens revoked immediately, so any live session dies at the next
     API call rather than when the access token happens to expire
   → the platform refuses if they still manage a team, naming the handover
     that must happen first
   → the audit trail records who did it and when
```
