---
name: add-litellm
description: Add a minimal LiteLLM router container exposing one OpenAI-compatible endpoint over local model servers — Ollama (default) or any keyless OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI) — plus opt-in keyed cloud backends (OpenAI, Anthropic, …) with proxy auth. Local-only binding. The dependency base for classifier routing and other LLM-fleet skills. Use when the user wants many models behind a single endpoint for NanoClaw agents.
---

# Add LiteLLM (minimal local model router)

Installs the [LiteLLM](https://docs.litellm.ai) proxy as a local Docker
container: **one OpenAI-compatible endpoint over every model your local
server(s) serve**. Ollama is the default backend; any keyless
OpenAI-compatible server (vLLM, LM Studio, llama.cpp server, TGI, …) works
the same way — hosts are probed and their rosters discovered automatically.
Keyed cloud backends are an explicit opt-in (below). Deliberately minimal —
no classifier, no routing policy. Dependent skills (classifier routing) layer
on top of this.

## Why it looks like this

- **Scope.** One job: the base endpoint. Classifier routing, fallback chains
  between different models, budgets, virtual keys and
  Postgres belong to dependent skills (`/add-routing`); this skill stops at one
  master key and knows nothing about them. It does not manage the model
  servers either.
- **Keyless by default.** With only discovered local backends there is no
  `master_key` and no request auth. That is safe only because the router is
  never publicly reachable: it binds `127.0.0.1` and the docker bridge IP, so
  binding is the perimeter. TLS is owed before the endpoint leaves the machine.
- **Proxy auth arms itself** the moment any declared backend exists, keyed
  or gateway — an unauthenticated endpoint in front of a paid key would be a
  free credential proxy, wherever the key is added (see *Keyed backends*).
- **Agent → router credentials go through OneCLI**, like every other agent
  credential; the keyless local path is the sanctioned plaintext `NO_PROXY`
  case. On webchat installs `webchat_models.credential_ref` is reserved but
  unimplemented — OneCLI injection is the only wired credential path.
- **Pinned image.** `ghcr.io/berriai/litellm` sits outside the pnpm
  supply-chain gate, so the installer's exact-version pin is the only version
  control it gets; `latest` is rejected.

## Prerequisites

1. **Docker** and **Node** on the host.
2. **A local model server running** with ≥1 model — localhost Ollama default;
   verify: `curl -s http://localhost:11434/api/tags`. For an OpenAI-compatible
   server instead: `curl -s http://<host>:<port>/v1/models`. LAN hosts optional.

## Install

```bash
bash "${CLAUDE_SKILL_DIR}/resources/install-litellm.sh" \
  [--hosts http://localhost:11434,http://<lan-ip>:8000] \
  [--port 4000] [--tag <litellm-image-tag>] [--dry-run]
```

Idempotent — re-run whenever a roster or the backends file changes. What it
does:

1. **Discovers** models on every `--hosts` entry — Ollama hosts via
   `GET /api/tags`, OpenAI-compatible hosts via `GET /v1/models` (probed
   automatically, no per-host configuration). A host that does not answer is
   skipped (it stays in the `# hosts:` header; the next rebuild serves it), as
   long as one does.
2. **Generates `data/litellm/config.yaml`** — one deployment per
   (host, model): `ollama_chat/<tag>` for Ollama hosts, `openai/<id>` for
   OpenAI-compatible hosts; the same model name on several hosts
   load-balances under one name (across backend kinds too); streaming-safe
   agentic timeouts.
3. **Runs** `ghcr.io/berriai/litellm` at a pinned version (override with
   `--tag`; the default pin lives in the installer) bound to
   `127.0.0.1:<port>` **and** the docker bridge IP — reachable from agent
   containers at `http://host.docker.internal:<port>/v1`, from nowhere else.
   **Never expose this port publicly.**
4. **Health-checks** `/v1/models` (with auth, in keyed mode).

A second install on the host: `--port`/`--name` (or
`LITELLM_PORT`/`LITELLM_CONTAINER`).

## Verify

```bash
curl -s http://127.0.0.1:4000/v1/models | head -c 400
curl -sN --max-time 90 http://127.0.0.1:4000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model": "<a-roster-tag>", "stream": true, "messages": [{"role":"user","content":"say hi"}]}' | head -5
```

The first token can take 10–30s+ while the backend cold-loads the model — a
slow first completion is normal, not a failure. (Ollama: `/api/ps` on the
host shows the model once loaded.)

## Wire an agent group (config, not code)

The router is a standard OpenAI-compatible endpoint —
`http://host.docker.internal:4000/v1` from agent containers — so any
consumer that speaks the protocol can use it. Zero core-code edits either
way; pick whichever your install has:

- **Webchat Models UI** (if the webchat channel is installed): register a
  model — kind **`openai-compatible`**, `endpoint` as above, `model_id` = a
  name from the roster — and assign it to an agent group. The SSRF policy
  and host-gateway alias already permit the address.
- **Default Claude harness** (no extra provider needed): LiteLLM serves the
  Anthropic `/v1/messages` surface, so the Claude Agent SDK can talk to it
  natively. Either assign an `openai-compatible` model to the group in webchat
  (above), or point the agent group's `ANTHROPIC_BASE_URL` at the LiteLLM
  endpoint (`http://host.docker.internal:4000`) with a roster model — the SDK
  routes through it with no provider hop.
- **Any other OpenAI-compatible client**: base URL + a model name from the
  roster.

The wiring is a runtime operator action with no source footprint, so there
is no in-tree integration point for a test to guard
(docs/skill-guidelines.md, "when there is genuinely nothing to test in-tree").
The generator tests below are optional unit coverage of this skill's own
logic, not integration legs.

## Operations

- **Roster or backends changed** → re-run the installer.
  ⚠ Re-running regenerates `config.yaml` and recreates the container, which
  **drops any dependent-skill layering** (e.g. `/add-routing`'s callback hook
  — its virtual `auto` model stops resolving until it's restored). Re-run the
  dependent skill's installer afterwards: add-litellm first, then the layer.
- **Admin UI**: `http://127.0.0.1:4000/ui` (localhost only).
- **Logs**: `docker logs nanoclaw-litellm`.
- **Tests**: `node --test "${CLAUDE_SKILL_DIR}/resources/generators.test.mjs"`.

## Keyed backends (opt-in)

Cloud/keyed models (OpenAI, Anthropic, a token-guarded vLLM, …) can sit
behind the same endpoint. They can't be discovered, so declare them in
`data/litellm/backends.json`:

```json
[
  { "model_name": "gpt-4o", "model": "openai/gpt-4o", "api_key_env": "OPENAI_API_KEY" },
  { "model_name": "claude-sonnet", "model": "anthropic/claude-sonnet-4-6", "api_key_env": "ANTHROPIC_API_KEY" }
]
```

`api_key_env` is an env-var **NAME** — a literal `api_key` field is a hard
error, so a key value can never end up in the (plaintext) generated config.
Put the values in `data/litellm/env` (one `NAME=value` line each; mode 600,
gitignored via `data/`), then re-run the installer. It then automatically:

- generates `data/litellm/master.key` and turns on **proxy auth**
  (`master_key`) — mandatory once a paid key sits behind the endpoint, since
  an open port would be a free credential proxy;
- passes the env file to the container (`--env-file`) and health-checks with
  auth.

Agents authenticate the sanctioned way — register the master key in OneCLI
so the gateway injects it per request (no restarts, no key in agent env):

```bash
onecli secrets create --name "LiteLLM router" --type generic \
  --value "$(cat data/litellm/master.key)" --host-pattern "host.docker.internal" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

Trust boundary, stated honestly: backend key values live on the host disk
(mode 600) and in the LiteLLM container's environment (visible to anyone who
can `docker inspect`) — the same trust domain as the host itself. Binding
stays localhost + bridge; **TLS is owed before this endpoint ever leaves the
machine**. Keyed-only installs (no local servers) are supported:
`--hosts ''`.

## Gateway backends (OneCLI)

A backend may instead say `"gateway": true` (no `api_key_env`): its key lives
in the OneCLI vault, and the container's traffic goes through the OneCLI
gateway, which adds it per request. LiteLLM holds a placeholder; no provider
key on disk. Needs `data/litellm/onecli.env` (proxy URL, CA trust) and
`data/litellm/onecli-ca.pem`; webchat's Manage → Models → Cloud model writes
both and the vault secret, scoped to the provider's inference and model-list
paths so LiteLLM's pass-through routes (`/cohere/*`, `/mistral/*`) never carry
it. A key stored before path scoping is narrowed to the inference path on the
next cloud-model add or roster refresh; enter the key once more in the Cloud
model form to restore the model list.

A gateway backend still puts a paid key behind the port, so proxy auth is on
(`master_key`, as for keyed backends). Agents never hold the master key:

- the container shares a Docker network (`<container>-gateway`) with OneCLI's
  container only, not OneCLI's own network where the vault's database lives.
  It is an ordinary routable network (never an internal one, such as the
  egress filter's: no published port, no route out). Agents call the router
  by container name (`http://<container>:4000`) **through** the gateway, not
  past it. Recreating OneCLI's container drops the attachment; this installer
  and webchat (at agent spawn) attach it again;
- the master key is a vault secret for that host name, **on inference paths
  only** (`/v1/messages*`, `/v1/chat/completions*`, `/v1/models*`, one secret
  each; `*` is a prefix match): it is LiteLLM's admin credential too, and
  admin routes include ones that run commands by design, so an agent's
  request to any other route arrives without it and is refused. Webchat
  assigns the secrets, with the tool secrets, only to the agents whose model
  the router serves (checked again at each spawn, so a model change follows);
- a filtered agent may reach that host as its model host, nothing more;
- central's own calls (model Test, health checks) go to loopback and send it.

`install-routing.sh` restarts the container through this installer, so the
proxy settings and network stay. The router's own `NO_PROXY` keeps the local
model servers and the routing classifier direct.

## For dependent skills

Import `generate()` from `resources/gen-config.mjs` and post-process, then
restart the container through this installer with
`--reuse-config --mount <src:dst> …` so its port, name, proxy auth and gateway
settings stay the ones it owns. Keep the invariants: local-only binding, key
values only ever in `data/litellm/env` (never in generated config), proxy auth
on whenever a backend is declared, and `data/litellm/` as the config home.
Restoring the base state is always: re-run this installer.
