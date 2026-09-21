# 14. Security and permissions

## Authentication

### Token design

| Token | Form | Lifetime | Stored | Revocable |
|---|---|---|---|---|
| Access | JWT (HS256) | 15 minutes | Client memory only | No — kept short instead |
| Refresh | 48 random bytes, base64url | 30 days | httpOnly cookie; **SHA-256 hash** in the database | Yes |

The refresh token is opaque rather than a JWT because it must be revocable, and
only its hash is stored, so a database leak does not hand over live sessions.

The access token is held in a module variable, never `localStorage`, so an XSS
cannot read it out of storage. The refresh cookie is `HttpOnly`,
`SameSite=Strict`, `Secure` in production, and scoped to `Path=/api/v1/auth` so
it is not attached to ordinary API calls at all.

### Rotation and theft detection

Every refresh rotates: the presented token is revoked and replaced, and the
chain is recorded via `replaced_by`. Presenting an already-rotated token means
a copy exists somewhere it should not, so **the entire token family is revoked**
and an audit entry is written.

Two details that were wrong in the first implementation and are now covered by
tests:

1. **The revocation ran inside the transaction that then threw**, so the
   rollback undid it and the stolen token stayed live. Family revocation now
   runs on a separate connection, after the detecting transaction has rolled
   back.
2. **A ten-second rotation grace window.** Without it, any client that fires
   two refreshes before the first response lands — two tabs, a retry, React's
   development double-effect — looks exactly like theft and logs the user out
   everywhere. Within the window, if the replacement token is still valid, the
   racing request is served the existing session and the client's cookie is
   left alone. A replay hours later is still treated as theft.

### Passwords

bcrypt at cost 12. Minimum 12 characters and at least three of
{lowercase, uppercase, digit, symbol}. Login always runs a bcrypt comparison —
against a dummy hash when the account does not exist — so a missing account and
a wrong password take the same time and return the identical message.

Changing a password revokes every other session.

### Session invalidation

| Event | Effect |
|---|---|
| Logout | The presented refresh token is revoked |
| Password change | All of that user's tokens revoked |
| Role change | All revoked; the token's role claim is also checked against the row on every request |
| Deactivation | All revoked; `authenticate` rejects inactive accounts immediately |
| Refresh reuse | Entire family revoked, audited |

## Authorization

Two layers, both mandatory — see [roles and permissions](02-roles-and-permissions.md)
for the matrix. The client hides controls it knows are unavailable; that is a
usability courtesy and is never the enforcement point.

## Input handling

| Vector | Control |
|---|---|
| SQL injection | Every query is parameterised. Identifiers in DDL (partition names) come from `pg_class` and are quoted |
| XSS | React escapes by default. Message mentions render as text nodes, never HTML. Search highlights are escaped, then only `<mark>` is re-introduced |
| CSV injection | Cells starting `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`, so a task title cannot execute in Excel |
| Payload size | 1 MB JSON cap; 16 KB WebSocket frame cap; 25 MB upload cap |
| Malformed input | zod at every boundary, returning field-level 400s |
| Mass assignment | Explicit allowlists per endpoint; `role` and `isActive` are admin-only fields |
| Path traversal in uploads | Storage keys are org-scoped and generated; the client's filename is sanitised and never used as a path |
| Dangerous uploads | Executable extensions refused; downloads forced to `Content-Disposition: attachment` so an uploaded HTML or SVG cannot execute on our origin |

## Transport and headers

`helmet` with a restrictive CSP (`default-src 'none'`, `frame-ancestors 'none'`
— the API serves JSON only), `Referrer-Policy: no-referrer`, and
`Cross-Origin-Resource-Policy: same-site`. CORS is an explicit origin
allowlist with credentials enabled; `trust proxy` is set so rate limiting sees
the real client address rather than the load balancer's.

## Rate limiting

| Scope | Window | Limit | Keyed on |
|---|---|---|---|
| Auth | 15 min | 20 | IP + email — so one attacker cannot lock out a whole office, and one account cannot be sprayed |
| Writes | 1 min | 120 | Actor |
| Search | 1 min | 60 | Actor |

In-process today; Redis-backed behind more than one instance.

## Data protection

| Concern | Control |
|---|---|
| Passwords | bcrypt, never logged, never returned |
| Refresh tokens | Only SHA-256 hashes stored |
| Log redaction | `authorization`, `cookie`, `set-cookie`, `*.password`, `*.token`, `*.body` are censored by pino |
| Attachments | Server-side encryption; every URL is presigned and expires in five minutes |
| DM privacy | No role can read a DM they are not part of — enforced in `assertCanReadConversation`, tested |
| At rest | Managed PostgreSQL encryption and S3 SSE (deployment concern, not application) |

## Audit trail

Append-only `audit_logs`, indexed by org+time, actor, and entity. Security-
relevant writes pass the transaction client so the audit entry is atomic with
the change. Recorded: logins and failures, refresh reuse detection, password
changes, user creation, role changes, deactivation, team lifecycle, task
deletion, assignment changes, leave decisions, retention changes, org settings.

## Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Credential stuffing | Rate limit, strong password policy, uniform errors | No MFA yet — see roadmap |
| Stolen access token | 15-minute lifetime, memory-only storage | A 15-minute window remains |
| Stolen refresh token | Rotation, reuse detection, family revocation | Detected on the thief's *or* the victim's next use |
| Privilege escalation | Two-layer authorization, admin-only role grants, tested refusals | — |
| Insider snooping | DM privacy is absolute; group compliance reads are audited | An admin can read private *groups* — deliberate, and logged |
| Data exfiltration via export | Exports require `report:export`, scoped to teams you manage, and are audited | — |
| Denial of service | Rate limits, statement timeout, payload caps, pool limits | Application-level only; edge protection is a deployment concern |

## Known gaps

Stated plainly rather than implied:

- **No MFA or SSO.** Both are roadmap items; SAML/OIDC is the more likely
  enterprise requirement.
- **Rate limiting is per-process.** Correct for one instance; needs Redis
  before scaling out.
- **No field-level encryption** for message bodies. Conversations are protected
  by access control and storage encryption, not by per-record keys.
- **No automated dependency scanning** in the repository yet; `npm audit`
  currently reports zero vulnerabilities and CI should enforce that.
