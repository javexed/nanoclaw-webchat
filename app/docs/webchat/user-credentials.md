# User credentials: per-member containers in shared rooms

**Status:** shipped (`src/modules/user-credentials/`). Covers API keys and
subscription (OAuth) credentials.

## 1. Goal

A shared webchat **room** where several people chat in one window, the agent
always has the **full conversation**, and **each person's turn is billed to their
own account** — securely, so that a compromised or prompt-injected agent cannot
spend anyone else's credential.

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

**Why not one shared container with a per-turn key?** Any per-turn secret would
have to reach the shared container through `inbound.db`, which the container
reads, so a compromised agent could replay a co-participant's credential. That
is inherent to the shared-container model, so it is not an option.

## 3. Architecture: per-member sessions

Change *where execution happens*, not *how keys are injected*. **Each member's
turn runs in a container bearing that member's own OneCLI agent identity**, and
OneCLI injects that member's credential based on the identity it already trusts
at spawn. There is **no per-turn token and no shared secret** — nothing to
replay or steal.

- **Session keying** reuses the existing `per-thread` session mode with a
  composite `thread_id = <userId>::<threadId|main>` (`memberSessionKey` in
  `identity.ts`). No `sessions` schema change and no new mode: each member gets
  their own session / container / inbound+outbound DBs per room thread.
- **The override is a seam hook.** The module registers
  `registerSessionKeyResolver` (per-member keying when the room uses user
  credentials and the sender has an active credential; otherwise routing is
  unchanged) and `registerTurnGate` (the no-key veto, §8).
- **Core stays user-credentials-agnostic.** The hook registries live in
  `src/seam/` (`registerAgentIdentityResolver`, `registerContainerEnvResolver`,
  …); the user-credentials module registers the resolvers. At spawn,
  `src/container-runner.ts` calls
  `resolveAgentIdentity(agentGroup.id, session.thread_id)` — so the identity is
  derived from **trusted session state, never agent- or user-controllable
  input**.

## 4. Per-member OneCLI identity

`userCredsAgentIdentifier(agentGroupId, userId)` (`identity.ts`) returns
`user-creds-<userSlug>-<sha256(agentGroupId|userId)[:12]>`:

- Lowercase `[a-z0-9-]` only (OneCLI's identifier constraint), so the raw userId
  (which contains `:` / `@`) is **never embedded or split**.
- Deterministic, so idempotent onboarding and spawn always agree.
- The owning agent group is recovered from the `user_credential_members` table
  (§7), **not** by parsing the identifier.

## 5. Shared context via fan-out

The agent must see the whole conversation even though turns run in separate
per-member containers. `fanout.ts` pulls on wake: when a member's session wakes,
it copies the last 60 room messages into **that session only** — the current
message as the wake (`trigger = 1`), the rest as context (`trigger = 0`). Stable
ids make the copy idempotent. Other members' sessions are not written; idle
members catch up the next time they speak.

## 6. Data model

- **`user_credentials`** (migration `module-user-credentials.ts`): one row per
  `(user_id, provider)` with the member's vault `secret_id` and a `cred_type`
  (`'api_key' | 'oauth_token'`). Keying per user means one credential can never
  be attached to several members.
- **`user_credential_members`** (same migration): PK
  `(user_id, agent_group_id)`; `onecli_agent_id` (the per-member identity the
  container spawns under), `secret_id` (reused across the member's agent-group
  rows), `status`, timestamps. An index on `onecli_agent_id` powers approval
  reversal (§7). **Stores only ids + status — never the credential**, which
  lives in the OneCLI vault.
- **Credential mode**: `disabled` | `optional` | `required` (§8). Effective
  mode = `webchat_room_settings.credential_mode_override ??
  webchat_settings.default_credential_mode` (default `disabled`).
- **Subscription switch**: `webchat_settings.allow_{claude,codex,grok}_oauth`,
  one per provider, set on the Credentials page. OAuth onboarding is refused
  unless it is on for the room's provider. (The per-room `oauth_allowed` column
  does not gate onboarding.)

## 7. Flow

**Onboard** (member, own credential only) — `POST /api/user-credentials/credential`:
CSRF-guarded, room-access gated, rate-limited, and bound to the
**authenticated** userId (never a body-supplied user). `onboard.ts` creates the
member's vault secret via `onecli` (`storeUserCredential`). At the first spawn in
a group, `ensureGroupEnrollment` ensures the per-member agent, sets it to
`selective` secret mode, and calls `setSecrets` with the merged set
`{ member secret } ∪ { group tool secrets }` (reconstructed each time, so
siblings are never clobbered), then records the mapping in
`user_credential_members`. Credentials are never logged; `onecli` exec errors
are scrubbed of their argv so a key can't leak through an error message.

**Route + spawn** — the session-key resolver keys the session to the member (§3);
`container-runner.ts` spawns the container under the member's OneCLI agent, and
the gateway injects their credential.

**Revoke** — clears the member's secret and mapping; the per-member OneCLI agent
lingers but is inert (the session stops resolving to it). Revoke is the
offboarding lever.

**Approval routing** — a credentialed-action approval from a per-member container
arrives with `externalId = user-creds-<slug>-<hash>`, not an agent-group id.
`onecli-approvals.ts` first tries `getAgentGroup(externalId)`; on a miss it calls
the fallback registered by this module (`registerApprovalAgentGroupFallback`),
which reverses the identity via `user_credential_members(onecli_agent_id →
agent_group_id)`. Approver selection then proceeds normally (scoped admin →
global admin → owner). This is table-based reversal, not string-splitting; a
missing fallback would auto-deny.

## 8. No-key handling

Per the room's effective credential mode (§6):

- **`disabled`** — one shared agent for the room (default).
- **`optional`** — key-holders run per-member; members without a key use the
  shared agent.
- **`required`** — a member without a key is **not woken** (drop reason
  `user-creds-required-no-key`) and gets connect-your-key guidance; there is no
  shared fallback.

## 9. Subscription (OAuth) credentials

A member can run their turns on their own **Claude Pro/Max**, **ChatGPT** (Codex)
or **Grok** subscription instead of a metered API key. Every rule above applies
unchanged; only custody of the token and the container's auth mode differ.

| | API key | Subscription (OAuth) |
|---|---|---|
| Credential | `sk-ant-…` (or an OpenAI key) | `sk-ant-oat…` from `claude setup-token`; Codex / Grok `auth.json` |
| At-rest custody | OneCLI vault | OneCLI vault — the host never holds it |
| Injection | proxy swaps in `x-api-key` | proxy swaps the `Authorization: Bearer` value |
| Container env | nothing | Claude: sentinel `CLAUDE_CODE_OAUTH_TOKEN=placeholder` |

**How the Claude path works.** The sentinel only flips the SDK into OAuth mode
(it sends `anthropic-beta: oauth-2025-04-20` and the real Claude Code identity);
its value is irrelevant. Anthropic traffic still goes **through OneCLI** (no
`NO_PROXY`), and OneCLI rewrites the bearer on the wire with the member's real
token. The request that reaches Anthropic is a genuine OAuth request — OneCLI
swaps only the bearer value, it does not fake the client identity. This is the
same mechanism `onecli run claude` uses and the drafter
(`src/channels/webchat/drafter.ts`) relies on. The real token never enters the
container.

**Minting from the browser.** Members connect without a terminal:
`oauth-mint.ts` runs `claude setup-token` or `codex login --device-auth` inside a
throwaway container under a PTY and captures the result server-side (it is never
round-tripped through the browser); `server/grok-member-login.ts` does the same
for Grok's device login. The mint scrapes CLI output, so a CLI output change can
break it.

**Terms of use.** Consumer subscription terms forbid one subscription serving
many people. This design cannot do that: each token is used only for its owner's
own turns, in its owner's own container. If a provider restricts headless use,
disable that provider's switch without touching API-key credentials.

**Expiry.** `setup-token` tokens are long-lived, so there is no refresh-token
custody; an expired token surfaces as a 401 and the member reconnects.

## 10. Security properties

- **No per-turn credential reaches a shared container → no replay.**
- A compromised agent in a member's container holds **only that member's own**
  credential, so it cannot spend or exfiltrate anyone else's.
- The per-member identity is fixed **at spawn from `session.thread_id`**, not
  from any agent-controllable input.
- Residual operational risks: onboarding argv exposure to local processes, and
  OneCLI as the trust anchor.

## 11. Touch points

- **Module-owned:** `src/modules/user-credentials/` (identity, db, onboard,
  onecli-admin, fanout, policy, index), migration `module-user-credentials.ts`.
- **Core hooks (additive):** `src/seam/` (session-key, turn-gate and resolver
  registries), `src/router.ts` (calls them), `src/container-runner.ts`
  (spawn identity + env), `src/modules/approvals/onecli-approvals.ts` (approval
  fallback).
- **Webchat:** `db.ts` / `migration.ts` (settings), `server/routes-users.ts`
  (credential endpoints), `oauth-mint.ts`, and the UI (`ui/src/`).
