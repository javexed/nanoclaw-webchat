# Design: Shared-room user credentials via per-member containers

**Status:** shipped — built into the webchat (`src/modules/user-credentials/`).
**Extended by:** [user-credentials-oauth.md](user-credentials-oauth.md) — the Claude **subscription** (OAuth) variant builds on everything here.

## 1. Goal

A shared webchat **room** where several people chat in one window, the agent
always has the **full conversation**, and **each person's turn is billed to their
own Anthropic account** — securely, so that a compromised or prompt-injected
agent cannot spend anyone else's key.

Non-goal: a shared/team key. One credential = one human, used only for that
human's own turns.

## 2. Threat model

- **Adversary:** either (a) a compromised / prompt-injected agent running *inside*
  a member's per-member container, or (b) a malicious but authenticated room
  member calling the webchat HTTP API.
- **Protect:** (1) no member can spend or exfiltrate another member's credential;
  (2) credentials never leak via logs, argv, errors, or to other members;
  (3) credentialed-action approvals route to the correct human; (4) no message
  amplification / DoS / session hijack; (5) no cross-user onboarding.
- **Trusted:** the host process, the OneCLI gateway (assumed to enforce
  per-identity secret isolation), and OS file permissions.

## 3. The rejected approach (and why)

The obvious design — one shared container, inject the *active* member's key per
turn — is **unfixably broken**. Any per-turn secret has to reach the shared
container through `inbound.db`, which the container reads, so a compromised agent
can replay a co-participant's token. This is inherent to the shared-container
model, not a bug a patch can close.

That implementation is preserved as a documented dead-end on the
`archive/user-creds-proxy-deadend` branch. **Do not revive it.**

## 4. Architecture: per-member sessions

Change *where execution happens*, not *how keys are injected*. **Each member's
turn runs in a container bearing that member's own OneCLI agent identity**, and
OneCLI injects that member's key based on the identity it already trusts at
spawn. There is **no per-turn token and no shared secret** — nothing to replay
or steal.

- **Session keying** reuses the existing `per-thread` session mode with a
  composite `thread_id = <userId>::<threadId|main>` (`memberSessionKey` in
  `identity.ts`). No `sessions` schema change and no new mode: each member gets
  their own session / container / inbound+outbound DBs per room thread.
- **The override is a seam hook.** The module registers
  `registerSessionKeyResolver` (per-member keying when the room uses user
  credentials and the sender has an active credential; otherwise routing is
  unchanged) and `registerTurnGate` (the no-key veto, §10).
- **Core stays user-credentials-agnostic.** The hook registries live in
  `src/seam/` (`registerAgentIdentityResolver`, `registerContainerEnvResolver`,
  …); the user-credentials module registers the resolvers. At spawn, `src/container-runner.ts` calls
  `resolveAgentIdentity(agentGroup.id, session.thread_id)` — so the identity is
  derived from **trusted session state, never agent- or user-controllable
  input**.

## 5. Per-member OneCLI identity

`userCredsAgentIdentifier(agentGroupId, userId)` (`src/modules/user-credentials/identity.ts`)
returns `user-creds-<userSlug>-<sha256(agentGroupId|userId)[:12]>`:

- Lowercase `[a-z0-9-]` only (OneCLI's identifier constraint), so the raw userId
  (which contains `:` / `@`) is **never embedded or split**.
- Deterministic, so idempotent onboarding and spawn always agree.
- The owning agent group is recovered from the `user_credential_members` table
  (§7/§9), **not** by parsing the identifier.

## 6. Shared context via fan-out

The agent must see the whole conversation even though turns run in separate
per-member containers. `src/modules/user-credentials/fanout.ts` pulls on wake:
when a member's session wakes, it copies the last 60 room messages into **that
session only** — the current message as the wake (`trigger = 1`), the rest as
context (`trigger = 0`). Stable ids make the copy idempotent. Other members'
sessions are not written; idle members catch up the next time they speak.

## 7. Data model

- **`user_credentials`** (migration `module-user-credentials.ts`): one row per
  `(user_id, provider)` with the member's vault `secret_id`.
- **`user_credential_members`** (same migration): PK
  `(user_id, agent_group_id)`; `onecli_agent_id` (the per-member identity the
  container spawns under), `secret_id` (the member's OneCLI vault secret, reused
  across their agent-group rows), `status`, timestamps. An index on
  `onecli_agent_id` powers approval reversal (§9). **Stores only ids + status —
  never the key**, which lives in the OneCLI vault.
- **Credential mode**: `disabled` | `optional` | `required` (§10). Effective
  mode = `webchat_room_settings.credential_mode_override ??
  webchat_settings.default_credential_mode` (default `disabled`).
- The OAuth variant adds a `cred_type` discriminator only; the token lives in the
  OneCLI vault like an API key — see [user-credentials-oauth.md](user-credentials-oauth.md).

## 8. Flow

**Onboard** (member, own key only) — `POST /api/user-credentials/credential`
(`src/channels/webchat/server.ts`): CSRF-guarded, room-access gated, and bound to
the **authenticated** userId (never a body-supplied user). `onboard.ts` then
creates the member's vault secret via `onecli` (`storeUserCredential`). At the
first spawn in a group, `ensureGroupEnrollment` ensures the per-member
agent (`userCredsAgentIdentifier`), sets it to `selective` secret mode, and calls
`setSecrets` with the merged set `{ member secret } ∪ { group tool secrets }`
(reconstructed each time, so siblings are never clobbered), and persists the
mapping in `user_credential_members`. Keys are never logged; `onecli` exec errors are
scrubbed of their argv (so a key can't leak via an error message).

**Route + spawn** — the session-key resolver keys the session to the member (§4);
`container-runner.ts` spawns the container under
`resolveAgentIdentity(group, session.thread_id)` → the member's OneCLI agent →
their key injected by the gateway.

**Revoke** — clears the member's secret/mapping; the per-member OneCLI agent
lingers but is inert (the session simply stops resolving to it). Revoke is the
offboarding lever.

## 9. Approval routing

A credentialed-action approval from a per-member container arrives with
`externalId = user-creds-<slug>-<hash>` — not an agent-group id.
`src/modules/approvals/onecli-approvals.ts` first tries `getAgentGroup(externalId)`;
on a miss it calls a registered fallback (`registerApprovalAgentGroupFallback`,
provided by the user-credentials module) that reverses the identity via
`user_credential_members(onecli_agent_id → agent_group_id)`. Approver selection then
proceeds normally (scoped admin → global admin → owner). This is **table-based
reversal, not string-splitting** — robust to the identifier charset, and the only
thing keeping user credentials approvals routable (a missing fallback would auto-deny).

## 10. No-key handling

Per the room's effective credential mode (§7):

- **`disabled`** — one shared agent for the room (default; unchanged behavior).
- **`optional`** — key-holders run per-member; members without a key use the
  shared agent.
- **`required`** — a member without a key is **not woken** (drop reason
  `user-creds-required-no-key`) and gets connect-your-key guidance; there is no shared
  fallback.

## 11. Security properties

- **No per-turn credential reaches a shared container → no replay** — the flaw
  the proxy approach (§3) could not fix.
- A compromised agent in a member's container holds **only that member's own**
  credential, so it cannot spend or exfiltrate anyone else's.
- The per-member identity is fixed **at spawn from `session.thread_id`**, not
  from any agent-controllable input.
- **Adversarial review (2026-06):** per-member isolation, fan-out discipline,
  approval routing, and onboarding authz all held up. One credential-in-logs
  hygiene finding (an `onecli` exec error embedding the key in its argv) was
  fixed at the `onecli()` chokepoint. Residual operational risks: onboarding
  argv exposure, and OneCLI as the trust anchor.

## 12. Touch points

- **user-credentials-owned:** `src/modules/user-credentials/` (identity, db,
  onboard, onecli-admin, fanout, policy, index), migration
  `module-user-credentials.ts`.
- **Core hooks (additive):** `src/seam/` (session-key, turn-gate and resolver
  registries), `src/router.ts` (calls them), `src/container-runner.ts`
  (spawn identity + env), `src/modules/approvals/onecli-approvals.ts` (approval
  fallback), `src/session-manager.ts`, `src/modules/index.ts`,
  `src/db/migrations/index.ts`, and the webchat `db.ts` / `server.ts` /
  `migration.ts` + the UI (`ui/src/`).
