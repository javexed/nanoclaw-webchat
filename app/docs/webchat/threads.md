# Per-room threads (webchat)

Status: **built.** Threads are **nested in the sidebar** and created **manually
only**, via an inline "+". Inbound `thread_id` is bounded: only `main`, a
wired-agent lane, or an existing topic thread routes; an unknown id falls back
to `main` rather than creating a thread.

A thread starts with no context (its own session). To move conversation between
a thread and the room's regular chat, see **context sync** (§8).

## 1. Goal & model

Let one webchat room hold several **independent conversations** with its
agent(s), each with its own context, instead of every message collapsing into
one ever-growing session.

The load-bearing idea: in NanoClaw, **a thread is an agent session.** `thread_id`
is already part of the session key — `resolveSession(agentGroup, messagingGroup,
threadId, 'per-thread')` returns **one session per (room, thread)**, and each
session has its own container context, its own continuation (the Claude
transcript), its own `inbound.db`/`outbound.db`, and its own heartbeat. So a
thread gives topic isolation, a smaller per-turn context, and parallel topics
with one agent — and, by design, **no cross-thread awareness**: the agent
answering in thread A cannot see thread B. The UI states this plainly.

Threads as a pure UI grouping over one shared session were rejected: that
reintroduces the context bleed threads exist to remove and fights the session
model.

## 2. Where `thread_id` flows

Core already carries it end to end: `thread_id` columns on `sessions`,
`messages_in`, `messages_out` and `pending_questions`; `per-thread` session
keying; the adapter contract (`onInbound(platformId, threadId, message)` /
`deliver(platformId, threadId, message)`); and outbound rows are stamped with
their session's `thread_id` automatically. The webchat adapter declares
`supportsThreads: true`, stores `thread_id` on every message, and every client
frame carries one.

## 3. Data model

Webchat migrations (idempotent, additive):

```sql
-- Thread registry. thread_id becomes session.thread_id for this room.
CREATE TABLE webchat_threads (
  room_id    TEXT NOT NULL,            -- messaging_groups.platform_id
  thread_id  TEXT NOT NULL,            -- 'main' | 'agent:<folder>' | uuid
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'topic',  -- 'main' | 'agent' | 'topic'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, thread_id)
);

-- Per-thread message history. Default 'main' migrates existing rows cleanly.
ALTER TABLE webchat_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_webchat_messages_thread ON webchat_messages(room_id, thread_id, created_at);

-- Per-thread read markers (widens the (user_id, room_id) PK to include thread).
-- New table + copy, since SQLite can't alter a PK in place.
CREATE TABLE webchat_thread_reads (
  user_id      TEXT NOT NULL,
  room_id      TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  last_read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id, thread_id)
);
```

`thread_id` namespacing:
- **`main`** — every room's implicit default thread (see §6). Created lazily.
- **`agent:<folder>`** — a per-agent lane. Deterministic id so repeated use of
  the same agent reuses the same thread/session. Can be created by hand; it is
  never suggested automatically (a dormant `auto_thread` column is all that
  remains of auto-spawn).
- **`<uuid>`** — a manually-created topic thread.

## 4. Routing flow (the round trip)

**Inbound** (client → agent), example: you send "draft the Q3 roadmap" with the
*Q3 planning* thread selected (`thread_id = u_a1b2`):

1. Client sends `{type:'message', content, thread_id:'u_a1b2'}`.
2. `ws.ts` resolves it and the adapter calls `onInbound(roomId, 'u_a1b2', message)`.
3. Router `resolveSession(group, room, 'u_a1b2', 'per-thread')` → session **S1**,
   keyed to that thread. Message lands in **S1's** `inbound.db`; container spawns.
4. `webchat_messages` row stored with `thread_id='u_a1b2'`.

**Outbound** (agent → client):

5. The agent answers in S1; its outbound rows are stamped `thread_id='u_a1b2'`
   automatically (session routing).
6. Delivery calls `deliver(roomId, 'u_a1b2', msg)`; the adapter broadcasts the
   threadId in the WS payload.
7. Client renders the reply **inside the Q3 planning thread** and bumps the
   per-thread unread badge for anyone not viewing it.

A second thread (`thread_id=u_c3d4`) keys a **different** session S2 with zero
knowledge of S1 — the agent works both in parallel, each reply routed to its own
thread.

## 5. Sidebar-nested UI

Threads render **nested under their room** in the left sidebar, not as a top
tab strip.

```
▾ #eng                •   ← room row = the main thread (unread dot)
    @ Sarah            •   ← per-thread unread dot
    @ Max
    # Q3 planning  +       ← "+" sits inside the last thread row
  ▸ #design
  DMs
    Sarah (dm)
```

- Clicking a room expands/collapses its thread list; clicking a thread opens it
  and loads `GET /api/rooms/:id/messages?thread_id=…` (that thread only).
- **Create** ("+" inside the last thread row, or on the room row when it has no
  threads yet) → inline name input → `POST …/threads` → opens the new (empty)
  topic thread.
- **Rename / delete** via the thread's row context menu (owner/member rules
  mirror room settings).
- `agent:*` lane threads appear with the agent glyph + name; `main` has no row
  of its own (the room row is main) and is not deletable; topic threads sort by
  last activity.
- **Unread** is per-thread (`webchat_thread_reads`), shown as dots; the room row
  shows a dot, not a count.
- Active-thread state persists per session (like `lastRoom`).

## 6. The `main` thread + migration

- Every room has an implicit **`main`** thread (`kind=main`), created lazily on
  first use. A room with no threads behaves as a plain room — `main` is just
  the room.
- Migration backfills `webchat_messages.thread_id='main'` (column default), so
  **all existing history lands in `main`** with no data loss.
- Existing `webchat_room_reads` rows copy into `webchat_thread_reads` as
  `(user_id, room_id, 'main', last_read_at)`.

## 7. Edge cases

- **DMs** (`dm:<folder>` rooms): single agent, so they stay single-threaded by
  default. Manual topic threads are still allowed.
- **Engage / mention-sticky** resolves *within the thread's session*, so an
  engaged agent stays engaged **in that thread**, not across the room.
- **Approvals / `ask_user_question`**: `pending_questions.thread_id` routes a
  question from S1 to its thread and the answer back to S1.
- **Delete a thread**: removes the `webchat_threads` row, its
  `webchat_messages` and `webchat_thread_reads`, and tears down its session dir
  (`data/v2-sessions/<group>/<S>/`). Room + other threads untouched. `main` is
  not deletable.
- **a2a / loop-back**: agent-authored fan-out keeps its existing self-exclusion;
  it inherits the thread of the session that produced it.
- **Session sprawl**: many threads mean many sessions, but idle teardown
  applies per session, so cold threads cost nothing while idle.

## 8. Context sync (pull / push)

A new thread starts with **no context** — an empty transcript and an empty agent
memory. Two operations move context between a thread and its room's `main`:

- **Pull (↓ from main):** bring main's recent conversation into the thread.
- **Push (↑ to main):** bring the thread's own conversation back into main.

Both are **verbatim**, **additive**, **demarcated**, and **incremental** (a
high-water mark per direction). **Neither ever overwrites or reorders** the
destination; they only append. "Context" is both the visible **transcript**
(`webchat_messages`) and the destination agent's **session memory**, written as
silent `trigger:0` inbound via `syncSessionContext`.

### What gets copied

A thread's messages split into a pulled-in prefix (copied from main) and its
native messages. Copied rows are **origin-marked** so neither direction ever
echoes: **push copies only native thread rows** (`origin IS NULL`) — the pulled
prefix already exists in main — and **pull copies only native main rows**, so a
push→pull round-trip doesn't duplicate.

```sql
ALTER TABLE webchat_messages ADD COLUMN origin TEXT; -- NULL=native | 'pulled' | 'pushed'

CREATE TABLE webchat_thread_sync (
  room_id            TEXT NOT NULL,
  thread_id          TEXT NOT NULL,
  last_pulled_src_ts INTEGER NOT NULL DEFAULT 0, -- newest main created_at pulled in
  last_pushed_src_ts INTEGER NOT NULL DEFAULT 0, -- newest native thread created_at pushed up
  PRIMARY KEY (room_id, thread_id)
);
```

Copies are **new** rows in the destination (new ids, `created_at` = now so they
land at the destination's current end); the originals are untouched. Marks track
the **source** timestamp last synced, so the next sync selects
`src.created_at > mark`, and cascade-delete with the thread.

### Pull and push

```
src = source messages WHERE created_at > <direction's mark> AND origin IS NULL
      (a fresh pull is also capped to main's recent slice)
if src empty → no-op toast ("Nothing new to pull/push")
insert a divider row + copies of src into the destination (origin='pulled'|'pushed')
syncSessionContext(destination session, src)   -- agent memory, trigger:0
<direction's mark> = max(src.created_at)
broadcast the new messages to the room's clients
```

A fresh thread's first pull has mark `0`, so it brings main's recent slice — the
"snapshot on create". Every later sync in either direction brings only the delta.

Each copied block is preceded by a `context-divider` message (*"Pulled from main
chat"* / *"Pushed from thread"*) that the client renders as a labelled rule, so
imported content is never confused with native conversation. Dividers are
display-only and never written to agent sessions.

### UI and API

- Two header controls, shown **only when a thread is open**: **↓** *"Pull main
  chat into this thread"* and **↑** *"Push this thread into main chat"*. Each
  confirms first (title only); the result toast reports *"Copied N messages"*.
- `POST /api/rooms/:id/threads/:tid/pull` and `…/push` → `{ copied: n }`.
  Room access checks apply and the requests carry `X-Webchat-CSRF`.
- A summary mode (one LLM turn condensing the delta) is a possible later
  addition; copies are verbatim today.

Implementation: `src/channels/webchat/db.ts` (`getThreadSyncMarks`,
`setThreadSyncMark`, `getSyncDelta`, `insertSyncedMessages`),
`server/routes-rooms.ts` (the endpoints), `ui/src/` (controls and divider
rendering); tests in `context-sync.test.ts`.
