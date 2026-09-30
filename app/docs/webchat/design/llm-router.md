# LLM routing & providers (two-plane design)

Design rationale for running many model backends at once: local (localhost +
LAN), self-hosted GPU, cloud-by-API-key, and **subscription agents over OAuth**.
The routing layer (§16) is built — [auto-routing.md](auto-routing.md) is the
implementation reference. Installed by `/add-litellm` and `/add-routing`.

> See also [local-model-agents.md](local-model-agents.md) — the practical how-to
> for pointing an agent at a local model (alongside Claude) and evaluating
> whether the model can actually *drive* an agent.

## The load-bearing constraint: two credential planes

A generic LLM router (LiteLLM, OpenRouter) speaks provider **APIs** authenticated
with **API keys**. It **cannot** drive **Claude Code** or **Codex** *subscriptions*
— that auth lives in the agent CLIs themselves (`claude setup-token` /
`CLAUDE_CODE_OAUTH_TOKEN`, Codex's ChatGPT login), which a proxy can't mint, refresh,
or present. (Reverse-engineered "subscription through a proxy" hacks are ToS-risky
and brittle — out of scope.) So the backends split into two planes:

| Plane | Backends | Auth | Routed by |
|-------|----------|------|-----------|
| **A — API / endpoint** | local Ollama, local vLLM, LAN/Tailscale models, cloud models *by API key* | bare endpoint or API key | **LiteLLM** (the router container) |
| **B — subscription agents** | **Claude Code** (Pro/Max), **Codex** (ChatGPT) | **OAuth**, per user | **native harness + OneCLI** — *not* a router |

There is **no single off-the-shelf router that covers both planes**. The design
embraces that rather than fighting it.

## Two axes: harness × model-source

Every agent config is **harness × model-source** — two independent choices:

- **Harness / provider** — *who runs the agentic loop* (turns, tool calls):
  `claude` (Claude Agent SDK), `codex`, `mock`.
- **Model source** — *where tokens come from*: Anthropic API key, Claude
  subscription (OAuth), ChatGPT subscription (OAuth), an Ollama/vLLM endpoint, or a
  **LiteLLM endpoint** (a meta-source that itself fans out to many).

```
              HARNESS            ×   MODEL SOURCE
Plane B   Claude Agent SDK       ×   Claude subscription (OAuth)
          Codex (separate track) ×   ChatGPT subscription (OAuth)
Plane A   Claude Agent SDK       ×   LiteLLM ──┬─ Ollama (localhost)
          (Anthropic /v1/messages)             ├─ vLLM (GPU)
                                               ├─ LAN / Tailscale models
                                               └─ cloud models (API key)
```

**LiteLLM is a model source, not a harness.** It occupies the same slot the
Anthropic API endpoint occupies for the `claude` provider: the default Claude
harness points `ANTHROPIC_BASE_URL` at LiteLLM's **Anthropic-spec `/v1/messages`
surface** and consumes it natively — no separate harness, no OpenAI-shaping hop.
Registering LiteLLM is therefore just an `openai-compat` model whose `endpoint`
is the router; the per-agent-group provider+model selection (`container_configs`)
is NanoClaw's real top-level router.

## Credential ownership: OneCLI is mandatory for all agent egress

**Invariant: every agent's credentialed egress goes through OneCLI** — one place
to store, monitor, rotate, approve, and rate-limit credentials. No agent ever
holds a raw key:

- Containers spawn behind OneCLI's `HTTPS_PROXY`; provider keys are injected on
  the wire by host-pattern, never via `.env` or the container environment.
- **LiteLLM does not bypass this.** The agent → LiteLLM hop carries a **single
  LiteLLM virtual key injected by OneCLI**. LiteLLM holds the real provider keys
  *behind* it, so the agent side has exactly one brokered credential. That makes
  LiteLLM a deliberate second credential store for provider-side keys — managed
  in its own UI/API, never reachable from an agent.
- The only exception is a **local, plaintext endpoint** (e.g. Ollama on
  `host.docker.internal`) reached via an explicit `NO_PROXY` bypass — no
  credential is involved. Routed/cloud models never qualify.

## Long-running agentic flows

The router barely affects this — agentic capability is **harness + model**.
Per-session containers are long-lived; among local models only strong
tool-callers do real agentic work. The router must pass through **streaming**
and **tool calls** and set a generous `request_timeout`.

## What this is explicitly NOT

- **Not** pushing subscription OAuth (Claude Code / Codex) through LiteLLM.
- **Not** replacing OneCLI — LiteLLM routes Plane-A models; OneCLI keeps brokering
  credentials (and is the *only* path for Plane B).
- **Not** OpenRouter (the SaaS) — a hosted cloud router that can't see
  localhost/LAN models. (OpenRouter *as a cloud backend behind LiteLLM* is fine.)

## 16. Routing & fallback

(Subsection ids 16a–16g are cited from code and kept stable.)

Two layers, cheapest first, both in Plane A. Routing is **pre-flight** (score
the prompt, then run).

### 16a. Plane-A routing (LiteLLM, native)

Name-based routing + load-balance, retries, `fallbacks` /
`context_window_fallbacks`, and cooldowns for unhealthy deployments — "this
Plane-A model errored → try another" with config only.

### 16b. Classifier — N-way capability routing

**Rank the prompt against capability profiles**, not binary strong/weak (which
is why RouteLLM was rejected). **Arch-Router (~1.5B, open weights)** runs as a
LiteLLM pre-call hook and maps a prompt to an operator-defined **capability
route** (code / vision / long-context / hard-reasoning / …); each route is
**bound to a model**. Routes are human-readable and decoupled from model
identity. A **benchmark-seeded capability table** informs the route→model
bindings — it is not consumed live. Lighter alternative: semantic-router
(embedding buckets); heavier: a trained per-model predictor on your roster.

### 16d. Post-flight quality judge (future, opt-in)

Judge the *answer* and retry on a stronger model if inadequate. Expensive and
unreliable; would be conservative and opt-in.

### 16e. Self-improvement

Offline/batch only — live per-request learning is unstable.

- **Tier 1 — threshold recalibration** (built): tunes per-router timeouts from
  the decision log and writes a report. See auto-routing.md §8.
- **Tier 2 — router retraining** (future): fine-tune on accumulated
  `(prompt → outcome)` labels. Label sources, best first: explicit feedback,
  implicit signals (re-ask, abandon),
  an offline LLM judge. You only observe the route you *took*, so learning about
  alternatives needs ε-exploration or shadow runs; otherwise the router just
  reinforces its habits. Prompt logging raises privacy/retention questions that
  must be settled first.

### 16g. Multiple routers — routing profiles

A `routes.json` may define many named routers, all sharing the one classifier
and the one roster; they differ only in routes and bindings. An agent selects a
profile by **which virtual model it's assigned** (`auto`, `auto-vision`, …);
the decision log, the binder, and recalibration are all per-router.
Config shape and GUI: [auto-routing.md](auto-routing.md) §3, §5, §9.
