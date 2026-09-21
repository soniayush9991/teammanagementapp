# 10. Frontend architecture

React 18, TypeScript strict, Vite, React Router 7, TanStack Query 5. No UI
framework: the design system is about 700 lines of CSS driven by custom
properties, which is smaller than the configuration a component library would
need and leaves no opinionated defaults to fight.

## Folder structure

```
apps/web/src/
├── main.tsx                 providers: QueryClient → Router → Auth → Toast
├── App.tsx                  routes and the two guards
├── api/
│   └── client.ts            fetch wrapper, token refresh, downloads
├── state/
│   ├── AuthContext.tsx      session, permissions, silent re-auth
│   └── ToastContext.tsx     transient feedback
├── hooks/
│   ├── useRealtime.ts       one socket per tab, cache invalidation
│   └── useDebounced.ts      search input pacing
├── components/
│   ├── ui.tsx               the design system primitives
│   ├── AppShell.tsx         sidebar, top bar, skip link
│   ├── GlobalSearch.tsx     "/" to focus, debounced, highlighted results
│   ├── NotificationBell.tsx badge and dropdown
│   ├── TeamPicker.tsx       team selection, synced to the URL
│   ├── NewTaskDialog.tsx    task creation
│   └── Toasts.tsx           live region
├── pages/                   one file per route
└── styles/
    ├── tokens.css           colour, space, type, shadow, light and dark
    └── app.css              layout and component styles
```

## State management strategy

The rule is **server state and client state are different problems**, so they
get different tools.

| Kind of state | Owner | Example |
|---|---|---|
| Server data | TanStack Query | tasks, capacity, conversations, reports |
| Session identity | `AuthContext` | current user, permissions |
| Transient UI | `useState` | open menus, drafts, drag state |
| Navigation and filters | URL | selected team, status filter, open conversation |
| Ephemeral realtime | Direct subscription | typing indicators, presence |

There is no Redux store, because there is almost no genuinely global client
state: nearly everything is either server data (Query's job), URL state
(Router's job), or local to one component.

**Filters live in the URL, not in state.** `/tasks?status=blocked&overdueOnly=true`
is shareable, bookmarkable and survives a reload. A `useState` filter is none of
those things.

**Realtime invalidates rather than patches.** A socket event calls
`invalidateQueries`, and Query refetches what is actually on screen. Hand-patching
the cache from events would mean maintaining a second, subtly different copy of
every server-side aggregation. The one place optimistic updates are used is the
Kanban drag, where the latency would otherwise be visible — and it rolls back
with a toast if the server refuses the transition.

## Authentication in the client

The access token is held **in a module variable, never in `localStorage`**, so
an XSS cannot read it out of storage. The refresh token is an httpOnly,
`SameSite=Strict` cookie scoped to `/api/v1/auth`, which JavaScript cannot
touch at all.

```
request → 401 with code token_expired
        → refreshSession()   ← shared promise, so ten parallel 401s
        → replay original       cause exactly one refresh
        → on failure: clear session, redirect to /login
```

A timer refreshes at 12 minutes against a 15-minute token, so a user reading a
long page is never interrupted.

## The design system

Everything resolves to a token in `tokens.css`. Dark mode redefines the same
names, so no component branches on theme:

```css
:root { --surface-card: #ffffff; --text-primary: #161d2b; --band-over: #d13438; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { --surface-card: #171d2b; --text-primary: #e7eaf2; }
}
:root[data-theme='dark'] { /* explicit override, same names */ }
```

Primitives in `ui.tsx`: `Card`, `Button`, `Field`, `Input`, `Select`,
`Textarea`, `Badge`, `Avatar`, `AvatarStack`, `EmptyState`, `Skeleton`,
`LoadingBlock`, `ErrorBlock`, `Metric`, `UtilizationMeter`, `BandBadge`,
`PriorityDot`, `DueDate`, `Modal`, `PageHeader`.

Every list-shaped screen handles four states explicitly: **loading** (skeleton,
not a spinner, so layout does not jump), **error** (message plus retry),
**empty** (an explanation and usually an action), and **populated**.

## Accessibility

Decisions that shaped the components rather than being retrofitted:

| Concern | Approach |
|---|---|
| Colour is never the only signal | Every utilization band carries a glyph (`▲`, `◐`, `●`, `○`) and the numeric percentage |
| Drag-and-drop | Always paired with a labelled `select` on each card; the board is fully operable from a keyboard |
| Focus | `:focus-visible` is restyled, never removed; the modal traps focus, closes on Escape and restores focus to the opener |
| Structure | Real `<table>` with `<caption>` and row headers; `<nav>`, `<main>`, `<aside>` landmarks; a skip link |
| Live regions | Toasts are `role="status"`, errors `role="alert"`; the typing indicator has reserved height so it cannot reflow the transcript |
| Meters | `role="meter"` with `aria-valuenow`/`min`/`max` and a text label |
| Motion | `prefers-reduced-motion` reduces transitions to near-zero rather than merely shortening them |
| Injected content | Search highlights are escaped and only `<mark>` is re-introduced; message mentions render as React text nodes, never as HTML |

## Performance

| Technique | Where |
|---|---|
| Route-level data fetching with caching | Every page, via Query |
| Debounced input | Global search, task search (250–300ms) |
| Keyset pagination | Task list, message history |
| Manual chunks | `vendor` and `query` split from app code |
| Skeletons | Prevent layout shift on load |
| One socket per tab | Shared by every component through `useRealtime` |

Production build: ~95 KB app code, ~24 KB gzipped, plus vendor chunks.

## Verified in a browser

Chromium, at 1440×900 and 390×844: sign-in, member dashboard, manager
dashboard (4 capacity rows, 7 band badges), Kanban (6 columns), planner (4
drop zones), chat (4 conversations, threads, reactions, mentions), reports, and
deep-linking straight to `/tasks/PLAT-1` on a cold load. No horizontal page
scroll at 390px; no unexpected console errors.
