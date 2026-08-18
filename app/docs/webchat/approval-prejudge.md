# Approval pre-judge (optional LLM triage)

An optional tier in front of human approvals: a roster model (webchat_models)
looks at an approval hold before any human sees it and answers one question —
*is this specific request routine, low-stakes, and easily reversible?* On a
clean `approve` verdict the approval is resolved through the **exact same
dispatch path a human Approve click takes**; on anything else the card is
delivered to approvers exactly as today. Its purpose is reducing approval
fatigue for low-stakes holds — humans keep everything else.

Two judge shapes are accepted:

- **Local** — an `ollama` / `openai-compatible` roster model with an endpoint
  (LiteLLM/Ollama), called at `<endpoint>/v1/chat/completions`.
- **Claude** — an `anthropic`-kind roster model (endpoint NULL, `model_id` a
  Claude model such as `claude-haiku-4-5`). The consult is an Anthropic
  Messages call routed through the **OneCLI gateway** — the exact credentialed
  path the webchat drafter uses (`anthropicMessagesViaOneCLI` in
  `src/channels/webchat/drafter.ts`, sharing its `webchat-drafter` OneCLI
  identity) — so the host never holds a raw Anthropic key. This makes the
  pre-judge usable on Claude-only installs with no local models: appoint e.g.
  Haiku as the judge.

Code: `src/modules/approvals/prejudge.ts` (rubric text lives there as
`PREJUDGE_RUBRIC`). Hook point: `requestApproval` in
`src/modules/approvals/primitive.ts`, immediately after the pending row is
written and before any card is surfaced.

## What passes through it (and what doesn't)

The intercept sits at one choke point — `requestApproval()` — after the
`pending_approvals` row is persisted, before any card is delivered. Every
producer that calls `requestApproval()` is therefore eligible for triage:

| Producer | Trigger |
|---|---|
| `src/modules/self-mod/request.ts` | agent asks to `install_packages` / `add_mcp_server` |
| `src/modules/agent-to-agent/agent-route.ts` | a2a message to a group the sender has no destination for |
| `src/modules/agent-to-agent/create-agent.ts` | agent requests creating a new agent |
| `src/cli/dispatch.ts` | any `ncl` command whose guard returns **hold** |
| `src/modules/approvals/onecli-approvals.ts` | OneCLI credentialed-action approvals |

**Not** in scope (different pipelines, never triaged): unknown-sender and
channel-registration approvals (the click-link `pending_sender_approvals`
path) and learning-loop skill proposals (drafts staged for review, not
approval cards).

## Defaults — OFF twice over

- `approvalPrejudgeModelId` is NULL: no model, nothing is ever consulted.
- `approvalPrejudgeActions` is empty: even with a model set, **no action is
  pre-judged until it is explicitly opted in**.

Both live as columns on the `webchat_settings` singleton
(`approval_prejudge_model_id`, `approval_prejudge_actions`; migration 207).

## Fail-safe contract

There is **no auto-deny** — the model can only `approve` or `escalate`; deny
stays human-only. Every failure mode escalates to a human: model absent or
wrong kind, endpoint down, timeout (10s), non-200, empty/unparseable output,
any verdict other than exactly `"approve"`, a targeted approval
(`approver_user_id` set), or a crash anywhere in the pre-judge itself.
Verdicts are per-request — nothing is cached.

## Never-list (hardcoded, overrides opt-in)

Actions that always reach a human, regardless of configuration:

| Entry | Why |
|-------|-----|
| `onecli_credential` | Credential use; also resolved via a separate in-memory path |
| `install_packages` | Supply chain — new code baked into the container image |
| `add_mcp_server` | New tool/capability surface for the agent |

Payload patterns (matched against the raw payload JSON of **any** action, so
e.g. a held `cli_command` can never be auto-approved when it touches these):

- `cli_scope` — container privilege level changes
- `roles grant` / `roles revoke` — user privilege changes
- `config update|add-mcp-server|remove-mcp-server|add-package|remove-package` — container config verbs

The PUT endpoint also refuses to opt in a never-listed action outright.

## Enabling it (owner-only)

**UI:** Settings → Approval pre-judge (owner-only). Pick a judge model
(Off = feature off), then switch on the actions to pre-judge; never-listed
actions render disabled.

**API:**

```bash
# Inspect current config + registered actions + the never-list
curl -s https://<host>/api/approvals/prejudge -H "Authorization: Bearer $TOKEN"

# Pick a roster model (webchat_models.id) and opt in an action
curl -s -X PUT https://<host>/api/approvals/prejudge \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{"modelId":"<roster-model-id>","actions":["cli_command"]}'

# Turn it off again
curl -s -X PUT ... -d '{"modelId":null,"actions":[]}'
```

`GET /api/approvals/prejudge` — guard `owner`; the response includes
`knownActions` (every action with a registered approval handler). `PUT` —
guards `csrf, owner`. The PUT validates `modelId` with the same gate the
runtime uses (`isUsableJudgeModel`): an `anthropic`-kind roster model, or an
`ollama`/`openai-compatible` roster model with an endpoint.

## What the model sees

Action name, card title, the human-readable request text, and the payload
JSON truncated to 2000 chars — all passed through redaction first
(`redactSensitiveData` from `src/channels/webchat/redact.ts`, supplemented
with the agent-runner's bearer/OneCLI/MCP-relay token patterns). Local judges
are called through `safeFetch` (SSRF-guarded) with `temperature: 0`;
anthropic-kind judges go through the OneCLI proxy with a small `max_tokens`
and **no sampling params** (current Claude models reject non-default
`temperature` with a 400). Both paths share the 10s timeout and the strict
verdict parse.

## Audit trail

An auto-approve emits:

- a `log.info('Approval auto-approved (pre-judge)', { action, approvalId, model, reason })` line,
- a system message to the requesting agent's session: `Auto-approved (pre-judge): <reason>`,
- the normal approval-resolved callbacks (webchat cards, etc.) with resolver
  id `prejudge:<model-id>` — the same surfaces a human approval hits, since
  resolution goes through the shared dispatch (`resolveApprovalAsApproved` in
  `src/modules/approvals/response-handler.ts`).

Escalations after a consult are logged too (`Approval pre-judge escalated to
human`); feature-off and not-opted-in cases are silent no-ops.

## What the card shows (triage)

Every card a human sees is one the pre-judge **escalated** — an approve resolves
the hold and no card is ever rendered. So the verdict itself carries no
information at the card. What the approver actually needs is *why this is in
front of me*, which used to exist only in a log line.

The card therefore shows, above the payload:

- **Flag chips** — a closed vocabulary of claims about the request:
  `credentials`, `permissions`, `install`, `capability`, `destructive`,
  `irreversible`, `outbound`, `bulk`.
- **A note** — the model's one-line reason, or why there is no reason.

### Claims, not scores

The chips are deliberately **not** a risk level or a confidence number.

This design already refuses to let the triage model withhold a human review —
there is no auto-deny, because a wrong auto-deny is worse than a wait. A
`risk: low / confidence: 0.92` chip would ask the approver to trust that same
model to *reassure* them, which is the same trust with no fail-safe behind it.
Self-reported confidence is also poorly calibrated, especially in the small
local models this feature targets, and a precise-looking number invites clicking
through the one card whose entire purpose is to make a human look.

A claim like "touches credentials" is different in kind: the payload renders
directly beneath it, so a wrong claim is visibly wrong. Wrong claims are
self-correcting; a wrong confidence score is not.

Values outside the vocabulary are dropped rather than rendered — a model
inventing a confident-sounding category must not reach the card.

### Two tiers, and their disagreement

Chips come from two places, and are shown side by side rather than merged:

| Source | Trust | Rendering |
|---|---|---|
| the never-list (deterministic, no model) | authoritative | tinted chip |
| the triage model | a claim to check | plain chip |

Showing both means a **disagreement is visible**: if the never-list flagged
`credentials` and the model never mentioned it, the model missed something, and
the approver can see that.

Never-list flags are recomputed at render from `(action, payload)` — a pure
function — so they appear even on an approval raised while the feature was off,
or one that predates it. The stored `heuristic_flags` column is kept as a record
of what the never-list said *at decision time*, which is a different question
and may legitimately diverge if the never-list later changes.

### Absence is a state, not a gap

Once chips exist, "no chips" must never be read as "screened, nothing found".
The tier is rendered explicitly:

| Tier | Card says | Means |
|---|---|---|
| `unscreened` | Not screened | feature off, action not opted in, or a targeted approver |
| `heuristic` | Always requires a human | the never-list decided; no model was consulted |
| `model` | *the model's reason* | the model was consulted |
| `unavailable` | Screening unavailable | screening was wanted but could not run |

No stored record reads as `unscreened`, which is the honest answer for both a
feature-off approval and one raised before this existed.

### Storage

`webchat_approval_triage` (migration `webchat-approval-triage`), keyed by
`approval_id` — fork-owned, because `pending_approvals` is upstream's and this
is description rather than decision. Written best-effort as the hold is created:
a triage write that fails logs and is skipped, never blocking delivery.

Flags and reversibility are parsed **after** the verdict is already decided, so
a garbage `flags` value costs the card some chips and nothing else. Describing a
request can never change the decision about it.
