# Upstream submission — the module hook seam

Status: **DRAFT — nothing submitted.** This is the package for proposing the
hook seam to `nanocoai/nanoclaw`. Review, edit, then say GO; submission is a
manual step (push branch to a fork of upstream, open the PR with the body
below).

## What is being submitted

The `pub/module-hooks` branch of the seam repo — **20 commits (17 non-merge),
+2,315/−23 across 23 files**, over upstream `879835bf8`, which is upstream HEAD
as of 2026-07-29. The branch is **0 commits behind**, so it applies without a
rebase.

| Commit | What |
|---|---|
| `847ce464` | Runner-side module seam: provider observers + per-query option contributors |
| `c81694db` | Host-side module seams: spawn, delivery, sweep, a2a, approvals |
| `4c9a397b` | Routing seams: delivery-plan resolver, turn gate, session-key override |
| `f54fab61` | `setTyping` gains optional `agentName` for multi-agent attribution |
| `02b6d500` | Outbound session-DB schema extensions |
| `9583a748` | R3 — runner command registry + turn/exchange observers |
| `4953469a` | `QueryInput.moduleInput` — typed extension bag for R2 markers |
| `cc6c1b92` | Warn when a deferred runner command has no `execute()` |
| `01b0959d` | H2 API consistency — container env resolvers compose |
| `980eea0e` | H3 — agent identity resolvers become a first-non-null chain |
| `ede1c9d7` | Decision hooks become chains; `system:%` guard on key overrides |
| `37f31c61` | H7 ordering — module sweep tasks run after core duties |
| `f95c4500` | Security rationale for R2 `allowedTools` + H12 outbound-only scoping |
| `7d188bb8` | R5 — turn-retry handlers (provider escalation without patching core) |
| `a4dfea53` | `SessionKeyResolver` carries the pre-override thread |

Plus `95c9314d` (prettier pass) and `badd4531` (`ci: retrigger for log
capture` — an empty commit that should be dropped before filing; see below).

**Before filing, re-check these numbers.** Every SHA in an earlier version of
this table was stale: the branch was rewritten to strip merge trailers that
carried an internal instance URL, so the old commits no longer exist. Regenerate
with:

```bash
git fetch up main && git log --oneline --no-merges up/main..HEAD
git diff --stat up/main..HEAD | tail -1
```

## Registry review state (operator walkthrough)

- [x] `ProviderMessageObserver` — reviewed 2026-07-26 (context-free events by design; room resolution is host-side; agent-shared ambiguity handled by TurnCompletionObserver)
- [x] `ProviderExchangeObserver` — reviewed 2026-07-26 (digest ring 12×4K/24K; observers-before-provider-hook ordering; digest is the portable context for routed reviews)
- [x] `ProviderQueryOptionsContributor` — reviewed 2026-07-26; review produced seam PR #380 (QueryInput.moduleInput bag, SEAM_API_VERSION 3) deleting the QueryInput marker residue; replace-not-narrow semantics + import-order merge documented
- [x] `RunnerCommand` — reviewed 2026-07-26; at-most-once defer semantics documented deliberate; stem-overlap matcher gotcha recorded (/learn vs /learn-routed); review produced seam PR #381 (warn on defer-without-execute)
- [x] `TurnCompletionObserver` — reviewed 2026-07-26; de-plumbed tool count (consumer derives) owned as a deliberate trade; config read-only by contract; batchMessages = original batch (follow-up quirk inherited from fork); lazy continuation drift is the feature
- [x] `PromptSectionContributor` — reviewed 2026-07-26; boot-time-static semantics to be stated in docstring at submission; token-cost contract (short, conditional, instruction-shaped); provider-neutral for free
- [x] `OutboundSchemaExtension` — reviewed 2026-07-26; idempotent-DDL contract; outbound-only scoping preserves one-writer-per-file (state in PR); reader-tolerates-absence convention; failed DDL = feature dark, turns fine. RUNNER SEVEN COMPLETE.
- [x] `ContainerEnvResolver` — reviewed 2026-07-26; was the seam's only single-slot hook → seam PR #382 makes it compose (order, later-wins-per-key, isolated throw); module-env-outranks-gateway named for security notes; env-shapes-mode vs identity-shapes-scope split documented
- [x] `ContainerConfigAugmentor` — reviewed 2026-07-26; shallow-merge is deliberate (learning-classifier resolver is the documented casualty → residue-shrink backlog); spawn-shaping override disclosure written
- [x] `AgentIdentityResolver` — reviewed 2026-07-27; single-slot → first-non-null chain + identifier format check (seam PR #383); resolver-fails-open + turn-gate-fails-closed layering documented
- [x] `SessionPrepareHook` — reviewed 2026-07-27; zero code findings; prepare→identity→env spawn sequence to be stated as API contract; bounded-time + idempotency doc lines; three-layer failure posture (prepare/resolver fail open, turn gate fails closed)
- [x] `ContainerExitObserver` — reviewed 2026-07-27; no code change; host-restart blind spot documented (exits observed only within the spawning process's lifetime — consumer stall-detection compensates); observers idempotent per session; Session-only payload is YAGNI holding (context param additive later). SPAWN CLUSTER COMPLETE.
- [x] `InboundDeliveryPlanResolver` — reviewed 2026-07-27; plan filters-never-expands + self-exclusion-before-plan named as security properties; fail-open to wiring evaluation; single-slot → queued for the consolidated chain commit (PR #384)
- [x] `SessionKeyResolver` — reviewed 2026-07-27; re-keys session but never reply address (named property); cannot cross groups/rooms (containment); #384 additions: chain shape + system:% namespace guard on override threadId + isolation-weakening disclosure
- [x] `TurnGate` — reviewed 2026-07-27; gate-throw posture resolved (skip-on-throw stays; fail-closed modules catch internally and veto — user-credentials now does); dead veto-notice found and fixed (was written to a never-polled session id); both fixes + tests in the turngate-fixes PR
- [x] `SessionInboundWriter` — reviewed 2026-07-27; best-bounded hook (scope conditional on key-resolver claim); chain conversion landed in seam PR #384; true-asserts-wake-row + own-store assumption + deliveryAddr stamping documented
- [x] `SessionDeliveryObserver` — reviewed 2026-07-27; it's a TICK not an event (1Hz/running-session cost model to docstring); observer latency = delivery latency; two-cadence coverage stated; INVENTORY FIX: onDeliveryAdapterReady folded under H1
- [x] `SweepTask` — reviewed 2026-07-27; ordering improvement queued (module tasks should run AFTER core sweep duties — next seam PR); cadence/self-gate/shutdown-tolerance doc lines
- [x] `ApprovalIntercept` — reviewed 2026-07-27; same-dispatch invariant + approve-only one-way valve are the security story; producers table added to docs/webchat/approval-prejudge.md
- [x] `ApprovalRequestedListener` — reviewed 2026-07-27; fires after intercepts; mirror-only (act path re-authorizes centrally); additive-never-substitutive; completes upstream's own resolved-handler pair
- [x] `A2aRouteObserver` — reviewed 2026-07-27; observation is post-authorization (never sees blocked routes); content in event → observer owns audience rule; single-choke-point contract noted

**WALKTHROUGH COMPLETE — 21/21 reviewed 2026-07-26→27.** Outcomes: 5 seam changes (#380 moduleInput bag, #381 defer warning, #382 H2 compose, #383 H3 identity chain, #384 decision chains + namespace guard), 1 consumer-bug PR (repo B #1: dead veto notice + fail-closed gate), 1 queued seam change (sweep ordering: module tasks after core duties), the contract/security notes sections above, and the approval-prejudge producers doc.

## Design contract (the PR's promises)

1. **Inert by default.** Core registers nothing. With no registrations every
   call-site is a no-op; behavior is byte-equivalent to today. Upstream's own
   suites pass unchanged on the branch (1,156 host + 171 container, including
   the seam's new tests).
2. **A hook can never break a turn.** Every notify/resolve wraps registered
   functions in try/catch; a throwing hook loses its own contribution, nothing
   else.
3. **Modules self-register at import time** from their own files. Installing a
   module = add files + one barrel import line. No core file grows
   module-specific knowledge.
4. **No new dependencies, no schema changes** (schema *extensions* are declared
   by modules through `registerOutboundSchemaExtension`, applied idempotently
   at DB open).

## Contract notes (accumulated from the registry walkthrough)

- **R1 events are context-free by design** — room resolution is host-side; consumers needing batch context use `TurnCompletionObserver`.
- **R2 `allowedTools` REPLACES the default toolset** — it can widen as well as
  narrow, so it deserves the explicit bounds (both are stated at the call site
  in `providers/hooks.ts`): (1) contributors are registered by host-installed
  module code in the provider's own trust domain — code that could already edit
  the provider directly; chat input, containers and network peers cannot reach
  it; (2) the provider's `disallowedTools` floor still applies on top. It is a
  shaping mechanism, not a sandbox; the residual risk is a buggy contributor
  widening a query it meant to restrict — a module correctness bug, not a
  privilege-boundary crossing. The shipped consumer only narrows: a learning
  review drops to `draft_skill` alone (plus read-only source tools for
  `/learn <url|path>`), which matters most because that pass can fire from a
  heuristic auto-trigger rather than an explicit instruction — restricting its
  blast radius is the difference between a background feature and a background
  feature with shell access. Contributor merge order = module import order.
- **RunnerCommand defer is at-most-once**: the row is acked before `execute()` runs — a crash mid-execute loses the command rather than re-running it (duplicate-spend protection). Commands sharing a stem must exclude each other explicitly (`/learn` vs `/learn-routed`: `-` is a word boundary). `classify()` must be pure; side effects belong in `execute()`. Sender authorization is the command's job — the context carries the batch rows for it.
- **TurnCompletionObserver carries no tool count** — consumers derive their own metrics (R1 events or module store). `ctx.config` is read-only by contract. `batchMessages` is the original batch (follow-ups excluded). `getContinuation()` is lazy — later reads are more correct, never cache it.
- **PromptSectionContributor is boot-time static** — evaluated once when the system context is assembled; changes need a respawn. Sections ride every query for the container's life: keep them short, conditional, instruction-shaped.
- **OutboundSchemaExtension DDL must be idempotent** (runs at every open).
  **Outbound-only, deliberately — there is no inbound counterpart.** The
  two-DB split's core invariant is exactly one writer per file (host writes
  inbound, container writes outbound); a module table in inbound.db would hand
  the container a write surface on a host-owned file and break it. Scoped to
  outbound, the hook changes no trust boundary — it lets a module own a table
  in the file that process already writes. It exists because core previously
  carried a module's schema: the activity feed's `status_events` had its DDL in
  core's `connection.ts` and its readers in the host's `session-db.ts`. Now the
  runner module declares the table and owns its writers, the host module owns
  the readers, and core knows only that a mechanism exists. Host-side readers of
  module tables must tolerate absence; a failed DDL means the module's feature
  goes dark, never the turn.
- **The spawn sequence is API contract**: prepare hooks → identity resolution → env resolution → config materialization. Lazy provisioning depends on the order. Prepare hooks run on EVERY spawn (idempotency mandatory), are on the hot path (bound your I/O), and cannot veto a spawn — that's the turn gate's job.
- **ContainerConfigAugmentor merges shallow, deliberately** — top-level keys are the contract; contributing `{learning: {...}}` replaces the stored block. Augmentors needing async work belong in `SessionPrepareHook`.

### R5 call-site placement

R5 has one call site (poll-loop `catch`). Correct upstream, where SDK failures
throw. It is placement-sensitive: a provider that re-emits a failure as a
`type:'error'` event instead of throwing routes around it and the hook never
fires. This is not hypothetical — it is what happened in our tree once our
provider patch started converting throws to error events, and it went unnoticed
because the R5 test exercises the registry (first-non-null, throwers skipped)
without driving the loop. Any future error-event path needs a matching consult,
and a wiring test that drives `runPollLoop` per failure shape.

## Security notes (for the PR body)

- **Identity is the credential boundary.** `AgentIdentityResolver` decides which OneCLI vault scope a container's calls inject from. It must pair with `SessionKeyResolver` (same user mapping) — a mismatch spawns one user's session under another's credentials. New identities auto-create OneCLI agents with `secretMode: all` (the full vault) unless the module scopes them — a resolver that mints identities must own a secret-scoping policy.
- **Spawn-shaping hooks outrank stored config, by design.** `ContainerEnvResolver` output is applied after the gateway env (a module can override `HTTPS_PROXY` — the credential path itself); `ContainerConfigAugmentor` output overrides the operator's DB config (a module can change what the container is). Both are host-side, operator-installed code — the same trust level as editing the spawn code — but the capability deserves naming.
- **`tool_use` events carry unredacted input** inside the container; anything forwarded host-ward relies on the host-side redaction pass.
- **RunnerCommand fires for any room member's message** — commands with cost or side effects must check the sender (the charge-invoker `/learn` is the reference implementation: enrollment/role checks host-side).

## Evidence (why these 21 and not others)

This isn't speculative API design — every registry is load-bearing for a real
product. `nanoclaw-webchat` (PWA, multi-agent rooms/threads, learning loop,
per-user credentials, approvals UI) now installs **nanoclaw as an unmodified
dependency plus this seam**: clone upstream → apply seam → overlay 69
module-owned files → 66 small residue patches (~3.1k diff lines, dominated by
generic fixes we intend to upstream separately). The composed install passes
1,888 host + 279 container tests — exact parity with the monolithic fork it
replaced — re-proven by CI on every push.

The residue patches are the *next* conversations (origin-guard, lenient
output, interrupt handling, terminal-error surfacing — each a standalone
upstreamable fix). The seam is what makes the whole class of "product forks
nanoclaw" maintainable.

## Suggested PR body (copy-paste)

> **feat: module hook seam — 21 registries for building products on nanoclaw without forking core**
>
> This adds a small, inert-by-default hook layer that lets an installed module
> observe and extend the host and agent-runner without patching core files.
> Nothing is registered in-tree, so this PR changes no behavior: with an empty
> registry every call-site short-circuits, and the existing suites pass
> unchanged.
>
> Motivation: we build a webchat product on nanoclaw. Before this seam it was
> a fork touching ~60 core files; every upstream release was a 3-way-merge
> project. On the seam it's `clone nanoclaw` + `add module files` + barrel
> imports — and we believe any channel/provider/product module (Discord-style
> adapters, status feeds, schedulers, learning loops) benefits the same way.
> The full working product composing on this exact branch, with its CI and
> test parity, is public: <repo link>.
>
> Contract: (1) inert when nothing registered; (2) a registered hook can never
> break a turn — all notifies/resolves isolate hook errors; (3) modules
> self-register at import time; (4) no new deps. `SEAM_API_VERSION` lets
> external modules pin.
>
> One placement note, since it will come up in review. **R5 (turn-retry) is
> called from a single site: the poll loop's `catch`.** That is correct here —
> a failing SDK stream throws out of the provider generator, so the catch is
> where turn failures arrive. But the hook is placement-sensitive in a way
> worth stating: a provider that *converts* a failure into a `type:'error'`
> event rather than throwing bypasses that site entirely, and the hook silently
> never fires. We hit exactly that downstream — our own provider patch re-emits
> thrown SDK failures as error events so the loop can surface them, which
> routed every real failure around the one call site. Measured with a handler
> registered: thrown → fired, error-event → did not. We fixed it on our side by
> consulting the seam at the terminal-error branch too. If upstream ever grows
> error-event handling, R5 wants the same second call site or it goes quietly
> dead.
>
> Happy to split this into smaller PRs (runner-side / host-side / routing) if
> that reviews better.

## Mechanics when GO is given

1. Push `seam` → `javexed/nanoclaw` (GitHub fork of upstream) as branch
   `pub/module-hooks` (the fork's established upstream-submission prefix — precedent: #3077 `pub/rate-limit-classification`, merged) — **tree-snapshot commits, javexed identity, per the
   publishing playbook** (kept privately, outside this repo).
2. Open the PR via `gh` against `nanocoai/nanoclaw` main with the body above
   (fill the repo link — decide whether nanoclaw-webchat gets a public GitHub
   mirror first, or link the private instance).
3. The linked-repo decision is the one open question: the evidence repo
   (nanoclaw-webchat) currently lives only on a private instance.
   Options: (a) mirror it to GitHub under javexed first (strongest PR), (b)
   link nothing and describe the numbers (weakest), (c) attach the composed
   tarball artifact to the PR text.
