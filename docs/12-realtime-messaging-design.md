# 12. Realtime messaging design

Transport is a single WebSocket per browser tab at `/ws`, shared by every
component through the `useRealtime` hook.

## Why WebSockets

Chat needs bidirectional frames (typing indicators travel client→server), so
Server-Sent Events would need a second channel for the upstream half. Polling
at the cadence a chat needs would cost more than an idle socket.

## Handshake

```
Client                                  Server
  │  GET /ws?token=<accessToken>          │
  │──────────────────────────────────────▶│  verify JWT
  │                                       │  load the user's team ids
  │◀─────────── 101 Switching Protocols ──│
  │                                       │
  │  { "type": "subscribe",               │
  │    "conversationIds": [...] }         │
  │──────────────────────────────────────▶│  filter to conversations the user
  │                                       │  is actually a member of, or that
  │                                       │  are public channels in their org
```

The token travels as a query parameter because browsers cannot set headers on a
WebSocket. It is short-lived, the connection closes immediately if it fails to
verify, and the URL is not logged by the application.

**A client cannot subscribe its way into a private group.** The subscribe frame
is treated as a request, not an instruction: the server intersects it with
actual membership before adding anything to the connection's subscription set.

## Protocol

### Client → server

| Frame | Payload | Effect |
|---|---|---|
| `subscribe` | `{ conversationIds }` | Adds the permitted subset |
| `unsubscribe` | `{ conversationIds }` | Removes them |
| `typing` | `{ conversationId, isTyping }` | Broadcast to that conversation, excluding the sender |
| `read` | `{ conversationId, messageId? }` | Advances the read watermark, broadcasts a receipt |
| `ping` | — | Liveness |

Frames are capped at 16 KB. Message bodies travel over HTTP, not the socket, so
that one code path handles validation, mention resolution, persistence and
notification fan-out.

### Server → client

| Event | When |
|---|---|
| `task.created` / `task.updated` / `task.deleted` / `task.assigned` | Task writes, to the owning team |
| `capacity.changed` | Assignment, status change, logged work, leave approval |
| `message.created` / `message.updated` / `message.deleted` | Message writes, to the conversation |
| `message.reaction` | Reaction toggled |
| `message.read` | Read watermark advanced |
| `typing` | Someone is typing |
| `presence` | A user's first connection or last disconnection |
| `notification.created` | A notification was created for this user |
| `conversation.updated` | Membership, rename, pin |
| `error` | Malformed or unsupported frame |

The union is declared once in `realtime/events.ts` and imported by both sides,
so adding a variant is a compile error in the client until it is handled.

## Event flow: sending a message

```
POST /conversations/:id/messages
   │
   ├─ assertConversationMember                     authorization
   ├─ validate parent is in the same conversation  threads cannot cross rooms
   ├─ resolveMentions → intersect with membership  outsiders are dropped
   │
   ├─ BEGIN
   │    INSERT message (trigger builds search_vector,
   │                    trigger touches conversation.last_message_at)
   │    claim attachments (partition key read back from the row)
   │    advance the sender's own read watermark
   │  COMMIT
   │
   ├─ publishToConversation(message.created)   ──▶ every subscribed socket
   ├─ notify(mentioned users, 'mention')       ──▶ notification.created
   └─ 201 with the hydrated message
```

Events are published **after commit**. Publishing inside the transaction would
let a client observe a message that a rollback then erased.

## Fan-out

```
service ──publish──▶ EventBus ──▶ Gateway.dispatch ──▶ matching sockets
```

Targets are resolved at publish time, not guessed by the socket layer:

| Target | Delivered to |
|---|---|
| `users` | Every socket belonging to those user ids (three tabs get three frames) |
| `conversation` | Sockets subscribed to that conversation |
| `team` | Sockets whose user is on that team |

`exceptUserId` suppresses echoing an action back to the person who caused it.

## Scaling beyond one instance

`bus.ts` is the seam. In-process today; with several API instances, replace
`publish`/`subscribe` with Redis pub/sub:

```
API-1 ──publish──▶ Redis channel ──▶ API-1, API-2, API-3 gateways ──▶ sockets
```

No service code changes, because services never touch the gateway directly.
Sticky sessions are not required: any instance can serve any socket, since
subscription state lives on the connection.

## Reliability

| Concern | Handling |
|---|---|
| Dead connections | 30-second ping; a socket that misses a pong is terminated |
| Reconnection | Exponential backoff to 30s, **with jitter** so a restart does not bring every client back in the same millisecond |
| Resubscription | The hook replays its subscription set on reconnect |
| Missed events | The socket is an optimisation, not the source of truth — on reconnect, React Query refetches; the notification bell also polls every 120s as a safety net |
| Delivery guarantee | At-most-once. Anything that must not be lost (assignments, mentions) is also a row in `notifications` |
| Send failure | Logged at debug; a dropped frame never crashes the process |

## Client integration

```ts
const realtime = useRealtime();
realtime.subscribeToConversations(ids);      // idempotent, replayed on reconnect
realtime.send({ type: 'typing', conversationId, isTyping: true });
useEffect(() => realtime.subscribe(handleTransient), [realtime]);
```

Durable events invalidate React Query caches centrally in `applyToCache`, so
screens stay declarative. Transient events (typing, presence) bypass the cache
entirely — writing them into it would mean cache churn for state that is
meaningless three seconds later.
