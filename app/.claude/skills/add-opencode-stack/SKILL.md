---
name: add-opencode-stack
description: Install the OpenCode agent provider AND wire it to a LOCAL Ollama model (not a cloud provider). The stock /add-opencode only documents cloud backends (OpenRouter, DeepSeek, Anthropic, Zen); this skill adds the local-Ollama stack on top — the interface-compat patches, the host-provider .env wiring, and the container→host NO_PROXY fix. Use when you want a NanoClaw agent to run on local Ollama through OpenCode's harness instead of the Claude Agent SDK — OpenCode follows tools/format far better than the Claude SDK does with small local models (no "I'm Claude" / send_message looping).
---

# OpenCode + local Ollama stack

The default `claude` provider points the **Claude Agent SDK** at a model. With a
small local model (an 8B via Ollama) the SDK's Claude-specific system prompt and
tool protocol confuse the model — it narrates internal notifications, loops on
`send_message` destinations, and claims to be Claude. Running the agent on the
**OpenCode** provider instead swaps the harness: no Claude prompt, a model-agnostic
tool loop, and dramatically cleaner behavior on the same weak model.

`/add-opencode` installs the provider but only wires **cloud** backends. This skill
does the **local-Ollama** wiring the base skill lacks, plus three patches that a
local stack needs on a current webchat install.

> **Reality check first.** This does NOT make an 8B model smart — it removes the
> *harness*-induced confusion, not the model's capability ceiling. Complex/agentic
> tasks still need a bigger model (a cloud backend, or a larger local model if the
> GPU allows). Use this when you specifically want *local + free* and can accept
> 8B-class quality.

## Prerequisites

1. Ollama running on the host with a tool-capable model pulled:
   `curl -s http://localhost:11434/api/tags` and e.g. `ollama pull qwen3:8b`.
2. Agent containers can reach the host's Ollama (run `/add-opencode-stack`'s cousin
   checks): the model's container-facing endpoint is `host.docker.internal:11434`.
   On a host with a default-deny firewall you may need
   `sudo ufw allow from 172.17.0.0/16 to any port 11434 proto tcp`. (The webchat
   model "Test reachability" button diagnoses this.)
3. An agent group already exists (`/init-first-agent`).

## 1. Install the OpenCode provider (base)

Follow `/add-opencode` steps 1–6 to wire the barrels and add the SDK dep — with two
install-specific deviations. **Skip the base skill's copies of `opencode.ts` (both
trees) and `mcp-to-opencode.ts`** — step 2 below supplies pre-patched versions of
those three files. Still do the barrel imports, the SDK dep, and the registration /
factory tests.

- **CLI install:** this webchat install installs global CLIs via `container/cli-tools.json`
  (a json-merge), NOT a hardcoded Dockerfile `RUN`. Add the pin there instead of the
  ARG+RUN the base skill describes, and skip its `opencode-dockerfile.test.ts`:
  ```json
  { "name": "opencode-ai", "version": "1.4.17", "onlyBuilt": true }
  ```
- **SDK dep:** `bun add` can be slow (~50s) — if it appears to hang, add
  `"@opencode-ai/sdk": "1.4.17"` to `container/agent-runner/package.json` dependencies
  and run `bun install` in `container/agent-runner`.

## 2. Copy the bundled, pre-patched provider files

This skill ships the three provider files **already patched** for a current webchat
install, under `files/`, and carries the barrel wiring + CLI pin as `nc:` directive
fences — so `pnpm exec tsx setup/index.ts --step provider-install opencode` (what the
webchat "Install OpenCode" button runs) applies them deterministically, and re-running
is idempotent. The SDK dep + image build are the install flow's job (below), not
directives.

Copy the three bundled, pre-patched provider files into place:

```nc:copy
files/opencode.container.ts -> container/agent-runner/src/providers/opencode.ts
files/mcp-to-opencode.ts -> container/agent-runner/src/providers/mcp-to-opencode.ts
files/opencode.host.ts -> src/providers/opencode.ts
```

Register the provider in both barrels (idempotent append):

```nc:append to:src/providers/index.ts
import './opencode.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './opencode.js';
```

Pin the `opencode-ai` CLI into the image via the json-merge manifest (this webchat
install installs global CLIs via `container/cli-tools.json`, not a Dockerfile RUN):

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "opencode-ai", "version": "1.4.17", "onlyBuilt": true }
```

What the three patches carry (for review, and to re-apply by hand if a future
`origin/providers` advances past these bundled snapshots):

- **`opencode.container.ts`** — the `origin/providers` file predates the
  `pub/module-hooks` seam, whose `AgentProvider` requires `registerMemorySessionHook`.
  Adds `import type { MemorySessionHookRegistration } from '../memory/session-hook.js'`
  and a no-op `registerMemorySessionHook(_hook) {}` (OpenCode loads memory via its
  `instructions` pipeline, not a session hook).
- **`mcp-to-opencode.ts`** — handles the `McpServerConfig` `stdio | remote` union
  (`'command' in cfg` → `type: 'local'`, else `type: 'remote'`) with optional
  `args`/`env`/`headers`.
- **`opencode.host.ts`** — the host provider reads config from `ctx.hostEnv`
  (= `process.env`), but a webchat install does **not** load `.env` into
  `process.env`, so `.env`-based OpenCode config (and `ANTHROPIC_BASE_URL`, which the
  container provider needs as the baseURL) was silently dropped. Reads them via
  `readEnvFile` instead, and adds `host.docker.internal` to `NO_PROXY` so a LOCAL
  provider (Ollama) is reached directly, past the OneCLI proxy.

Verify both trees typecheck clean:
```bash
pnpm run build                                                  # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit  # container
```

## 3. Build the image

```bash
./container/build.sh          # bakes opencode-ai CLI + @opencode-ai/sdk
```
If step #15 (`install-cli-tools.sh`) stalls on a pnpm registry fetch, it's transient —
kill and re-run. Confirm: `docker run --rm --entrypoint sh <agent-image> -c 'opencode --version'`.

## 4. Wire .env to Ollama

Ollama's OpenAI-compatible API is at `/v1`. In the install's `.env`:
```env
OPENCODE_PROVIDER=ollama
OPENCODE_MODEL=ollama/qwen3:8b
OPENCODE_SMALL_MODEL=ollama/qwen3:8b
ANTHROPIC_BASE_URL=http://host.docker.internal:11434/v1
```
No OneCLI credential is needed — Ollama ignores the placeholder key the provider sends.
The container provider registers a provider named `ollama` with this baseURL + a
`tool_call: true` model entry; OpenCode talks to it over `/v1/chat/completions`.

## 5. Select the provider + set identity + restart

```bash
bin/ncl groups config update --id <group-id> --provider opencode
```
OpenCode loads persona/instructions from `/workspace/agent/CLAUDE.local.md` (NOT
`instructions.prepend.md`, and it does not expand `@./` includes). If the model
claims to be Claude, add an explicit identity to `groups/<folder>/CLAUDE.local.md` —
though note a weak 8B may ignore it (capability ceiling, not a config bug).

Restart so the container respawns on the new provider + env:
```bash
systemctl --user restart nanoclaw   # loads the patched HOST provider + .env
bin/ncl groups restart --id <group-id>
```

## 6. Verify (local, no cloud)

Send the agent a message, then confirm it ran on Ollama, not Anthropic:
```bash
curl -s http://127.0.0.1:11434/api/ps                 # qwen3 loaded in VRAM
journalctl -u ollama --since "-2 min" | grep /v1/chat # POST from 172.17.0.x → 200
journalctl --user -u nanoclaw --since "-2 min" | grep -c api.anthropic.com   # 0
```
A clean reply with no `Unknown provider: opencode`, no `api.anthropic.com` 401, and
`/v1/chat/completions` in the Ollama log means the stack is live.

## Notes / gotchas

- **The patches survive a reinstall via this skill's bundled files.** A fresh
  `install.sh` re-fetches the stale `origin/providers` sources, but re-running step 2
  copies this skill's pre-patched `files/*.ts` back over them — no hand-editing. The
  bundled files are pinned snapshots of a seam install; if `origin/providers` advances
  materially, refresh `files/` from a known-good install and re-verify the typechecks.
- **Two meanings of "opencode".** `--provider opencode` selects the OpenCode *harness*;
  `OPENCODE_PROVIDER` is the backend id *inside* OpenCode (here `ollama`).
- **Harmless startup warning — ignore it.** OpenCode logs `NpmInstallFailedError …
  @opencode-ai/plugin … fetch() proxy.url must be a non-empty string` on start. It is a
  background plugin-install fetch and is **non-fatal** — agents still reply. The OneCLI
  proxy is fine (`bun add @opencode-ai/plugin` succeeds through it); the fault is
  OpenCode's *internal* fetch mis-constructing its proxy option, an upstream bug in the
  compiled CLI. We use no OpenCode plugins, so nothing is lost. Don't chase it as a
  routing/Ollama failure. Ollama itself is reached at `host.docker.internal` (in
  `NO_PROXY`), so it never touches the proxy.
- **To remove:** set `--provider claude`, restart; see `/add-opencode`'s REMOVE.md for
  the provider files.
