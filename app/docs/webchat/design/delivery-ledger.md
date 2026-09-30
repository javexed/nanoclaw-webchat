# Outbound delivery: crash semantics

**Question:** if the host dies at the wrong moment, can a final agent response
be lost or duplicated? **Answer: never lost; occasionally duplicated.** Delivery
is at-least-once with boot-time redelivery, and that is the intended trade-off.

## The ledger invariant

- **Obligation** — the container writes the reply to `messages_out` in
  `outbound.db`. It is durable the moment the INSERT commits.
- **Discharge** — the host records completion in the `delivered` table of
  `inbound.db` (`markDelivered` / `markDeliveryFailed`), never by deleting or
  flagging the `messages_out` row.
- **Due** = `messages_out − delivered`, recomputed on every drain pass. The
  sweep poll covers every active session and runs once immediately at boot, so
  nothing strands across a restart.
- **Order is send → confirm → mark.** No path marks before sending, so there is
  no loss window. A missing channel adapter throws into the retry path instead
  of marking.

## Where duplicates come from

A crash after the platform accepted a message but before `markDelivered`
commits redelivers it on restart. For network channels the window is the
response leg of one awaited call; for webchat it is sub-millisecond synchronous
work between two local SQLite writes. A webchat duplicate is a second history
row and re-fires loop-back fan-out (bounded by self-exclusion and the per-room
rate limit). Exactly-once would need per-platform idempotency keys that the
channels don't uniformly support, so it is not worth engineering for.

## Deliberate non-crash drops

- A row that fails three attempts is marked failed and counts as discharged;
  there is no dead-letter redelivery (logged to `logs/nanoclaw.error.log`).
- `task_log` rows, rows missing routing fields, and webchat messages for an
  unknown room are dropped with a log line.

The mark/retry/fail loop is upstream NanoClaw code; any change to these
semantics belongs upstream, not in webchat. Webchat's `reconcile.ts` replays
recent outbound rows missing from `webchat_messages` as a loss-correcting safety
net; it probes before replaying, so it never duplicates.
