# Pin bump: adopting upstream's mid-turn delivery

Working notes for the upstream bump to `f0d35831`. Written down because the
analysis cost more than the edits will, and none of it is recoverable from the
diff.

## Decision

Take upstream's delivery rework as-is, and set `emitsMidTurnText = false` on
this fork's `claude.ts` — one capability flag on our own provider, not a fork
of upstream's logic.

## Why the flag, and not a merge

Upstream moved delivery from "the final result is the single door" to
"streamed text is the single door": each `<message>` block is delivered the
moment it closes, segment by segment, with cross-segment assembly and an echo
guard keyed on an outbound-DB seq window.

Our single-reply misfire guard cannot be expressed on that path. It reads:

```ts
if (blocks.length === 1 && dest.type === 'channel' && redirectTarget && !originSet.has(...))
```

`blocks.length === 1` is load-bearing — a *lone* reply addressed away from the
turn's origin is the misfire signal, while a deliberate multi-destination reply
must not be touched. That count is only knowable once the turn's text is
complete. Under streaming delivery, block one is already sent before the door
learns whether a block two exists. It is a semantic conflict with the delivery
model, not a merge conflict, which is why `dispatchResultText` shows as a
247-line rewrite against our 18.

The guard matters for this fork specifically: small local models answer into a
room they can see instead of back to their a2a caller, which leaks the answer.
The original rationale for scoping it to *lone* replies is not recorded
anywhere — history is squashed at the public release — so it was preserved
rather than relaxed.

Options weighed and rejected:

- **Guard on the final-result path only.** It would silently stop protecting
  the streaming path, and upstream sets `emitsMidTurnText` on `claude.ts`, so
  that is most turns. A guard that quietly protects less than it claims is
  worse than none.
- **Drop the "lone" condition.** Works with streaming, but redirects a
  deliberate second-destination post. Without the original rationale, that is
  a blind trade.

The flag is reversible the day the guard is re-expressed in a streaming-safe
form — e.g. deferring the first block until a second appears or the turn ends,
which trades a little latency for the count.

## Which of our five poll-loop features survive

Measured against the new tree, not assumed:

| feature | upstream has it now | action |
| --- | --- | --- |
| interrupt handling | yes | drop from our patch |
| lenient output | no | port |
| origin guard | no | port (needs the flag above) |
| terminal-error surfacing | no | port; check overlap with upstream's error-only result door |
| empty-turn net | no | port; upstream's `turnStartSeq` may replace our `getMaxOutboundSeq` counter |

## Remaining work

1. **`poll-loop.ts`** — 8 conflicts. Design: take upstream's
   `dispatchResultText` wholesale; extend `ResultDispatchOptions` with
   `originDests` and `lenient`; pre-count blocks with a non-global regex scan
   so the lone-reply condition survives upstream's single-pass loop; keep the
   guard immediately before `sendToDestination`. `resolveOriginDestinations`
   ports across unchanged. Note `processQuery` gained `emitsMidTurnText`
   between `initialContinuation` and our `turnContext` — every call site needs
   the argument, and one of them (the escalation retry) merges *cleanly* while
   binding the wrong slot.
2. **`claude.ts`** — 6 of 7 hunks apply (5 with offsets, one additive by
   anchor). The last rewrites the SDK message loop, where upstream also
   changed things for mid-turn emission; it carries the reasoning taps and
   `rate_limit_event` handling. Do not regenerate this patch until that hunk
   lands, or those features vanish silently.

## Traps hit, worth not re-learning

- `rerere` is enabled globally and silently resolved a conflict by dropping
  our side entirely — zero markers, zero content. Disable it before applying
  patches.
- Resolving a conflict by concatenating both sides is only valid when each
  side is a whole block. It split a doc comment and dropped a closing brace
  here; both were invisible in the diff and obvious on compile. Typecheck the
  composed tree *before* regenerating patches.
- `pnpm exec` re-resolves Node and breaks the native `better-sqlite3` binding;
  1559 passing tests reported as 507 failures. Run under the pinned Node 22.
- Applying upstream's delta onto our file instead is worse: 12 of 17 hunks
  reject, against 8 conflicts in the forward direction.

## Where the 23 failures actually come from (session 2)

Not behavioural after all — two mechanical faults, one still unexplained.

### 1. `formatter.test.ts` is syntactically broken (mine)

`brace delta 2, paren delta 3`. The keep-both concatenation dropped a
closing `});` on the upstream `describe` block. This accounts for the
3 reported "errors" and cascades into failures. Fix the braces first,
before reading any other failure in that file.

### 2. `options.originDests` arrives non-array

```
TypeError: originDests.filter is not a function
  at dispatchResultText (poll-loop.ts:1470)   const originChannels = originDests.filter(...)
  from processQuery      (poll-loop.ts:974)   dispatchResultText(event.text, routing, { ... originDests, ... })
```

`const originDests = options?.originDests ?? []` — `??` only catches
null/undefined, so a `false` reaching that field survives and then has no
`.filter`. That is the signature of a boolean landing in the slot.

BUT all three `processQuery` call sites were checked and are correctly
ordered against the merged signature:

```
initialContinuation, emitsMidTurnText = false, turnContext?,
originDests = [], lenientOutput = false, signal?
```

sites at poll-loop.ts:391 (escalation retry), :434 (main), :464 (stale-
session retry) all pass `emitsMidTurnText, turnContext, originDests,
lenientOutput, signal` in that order.

So the next step is NOT another read of the call sites. Instrument the
one call — log `typeof originDests` inside `processQuery` immediately
before it builds the options object — and find what is actually bound.
Prime suspect is a fourth caller, or `learning-loop.ts` calling
`processQuery` with the pre-merge argument list.

Do not "fix" this with `Array.isArray(...)` at the read site. That masks
a mis-bound argument, and the same mis-binding would then be silently
feeding `lenient` and `signal` too.
