# 2. User roles and permissions

## The three roles

| Role | Granted to | Blast radius |
|------|-----------|--------------|
| `member` | Everyone by default | Their own work, their teams' tasks, conversations they belong to |
| `manager` | Team owners | Everything a member has, plus their teams and reportees |
| `admin` | Platform owners | The whole organization, including roles, retention and audit |

Roles are **organization-wide**. A person's relationship to a specific team is
separate (`team_members.role_in_team`), so someone can be a lead on one team and
an ordinary contributor on another without holding manager rights globally.

## Two-layer authorization

A request must pass **both** layers. This is the single most important
structural decision in the product's security model.

```
  Request
     │
     ▼
┌─────────────────────────────┐
│ Layer 1 — role permission   │  "May a manager ever assign tasks?"
│ requirePermission(...)      │  Pure function of the role. No database.
└─────────────────────────────┘  packages/shared/src/permissions.ts
     │ passes
     ▼
┌─────────────────────────────┐
│ Layer 2 — record scope      │  "Is THIS task in a team they manage?"
│ assertCanWriteTask(...)     │  Needs the database: membership, reporting
└─────────────────────────────┘  line, conversation membership.
     │ passes                     apps/api/src/middleware/scope.ts
     ▼
  Handler
```

Layer 1 alone would let a manager edit another manager's team. Layer 2 alone
would need every scope function to re-derive what the role is allowed to do.
Splitting them keeps the matrix auditable and the scope checks small.

## Permission matrix

`●` granted · `—` not granted

| Permission | member | manager | admin |
|------------|:------:|:-------:|:-----:|
| `user:read` | ● | ● | ● |
| `user:create` | — | — | ● |
| `user:update` | — | — | ● |
| `user:deactivate` | — | — | ● |
| `role:assign` | — | — | ● |
| `org:configure` | — | — | ● |
| `audit:read` | — | — | ● |
| `retention:configure` | — | — | ● |
| `team:read` | ● | ● | ● |
| `team:create` | — | ● | ● |
| `team:update` | — | ● | ● |
| `team:delete` | — | ● | ● |
| `team:manage_members` | — | ● | ● |
| `task:read` | ● | ● | ● |
| `task:create` | ● | ● | ● |
| `task:update` | ● | ● | ● |
| `task:update_progress` | ● | ● | ● |
| `task:assign` | — | ● | ● |
| `task:bulk_assign` | — | ● | ● |
| `task:delete` | — | ● | ● |
| `capacity:read_self` | ● | ● | ● |
| `capacity:read_team` | — | ● | ● |
| `capacity:update_self` | ● | ● | ● |
| `capacity:update_team` | — | ● | ● |
| `leave:request` | ● | ● | ● |
| `leave:approve` | — | ● | ● |
| `conversation:read` | ● | ● | ● |
| `conversation:create_group` | ●¹ | ● | ● |
| `conversation:create_channel` | — | ● | ● |
| `conversation:manage_members` | ● | ● | ● |
| `conversation:pin_message` | ● | ● | ● |
| `conversation:read_any_history` | — | — | ●² |
| `message:send` | ● | ● | ● |
| `message:edit_own` | ● | ● | ● |
| `message:delete_own` | ● | ● | ● |
| `message:delete_any` | — | — | ● |
| `report:read_self` | ● | ● | ● |
| `report:read_team` | — | ● | ● |
| `report:export` | — | ● | ● |
| `notification:read_self` | ● | ● | ● |

¹ Subject to `organizations.allow_member_group_creation`, which an admin can
turn off.
² **Never applies to direct messages.** `assertCanReadConversation` refuses a
non-participant on a DM regardless of role. A compliance read of a private
*group* is possible; a read of someone's DMs is not.

## Scope rules in prose

| Question | Rule |
|----------|------|
| Can I see this user? | Myself, anyone in my reporting line (recursively), anyone sharing a team with me, or anything if I am an admin |
| Can I see this task? | I am on the team that owns it, or I am assigned to it |
| Can I edit this task? | I manage the team, I created it, or I am assigned to it |
| Can I assign it to someone else? | Only if I manage the team. Assigning to *myself* is always allowed on a task I can already see |
| Can I read this conversation? | I am a member, or it is a public channel in my organization |
| Can I approve this leave? | I am the person's manager, or an admin — and never my own |

## Deliberate refusals

These are enforced and tested, because each is a plausible escalation:

- A member cannot change their own role (`403`, verified in `rbac.test.ts`).
- A manager cannot create an admin — only an admin mints admins.
- Nobody, including an admin, reads a DM they are not part of.
- Nobody approves their own leave request.
- A role change or deactivation revokes that user's refresh tokens
  immediately, so the change takes effect now rather than when a token expires.
