---
name: add-pi-stack
description: Install the pi coding-agent harness (@earendil-works/pi-coding-agent) as a NanoClaw agent provider wired to a LOCAL Ollama model. pi's harness is minimal by design — no 16k coding preamble, structured thinking events, one-shot JSON mode — so a small local model (8B via Ollama) sees ONLY NanoClaw's own instructions: the smallest prompt of any harness here. Use as an alternative to /add-opencode-stack when you want the leanest local harness; chat-first (no MCP tools in v1 — delivery is the <message to> envelope, same as the lean OpenCode path).
---

# pi + local Ollama stack

The `pi` provider runs each turn through the pi coding agent in one-shot JSON
mode (`pi -p --mode json --no-tools --system-prompt …`) against the agent's
local Ollama model. Compared to OpenCode: no server process, no SDK dependency,
no heavyweight system prompt to strip — pi accepts a full `--system-prompt`
replacement, so the model gets NanoClaw's instructions and nothing else.

> **Scope (v1): chat-first.** pi has no built-in MCP; the provider runs
> tool-less and delivers via the `<message to="…">` envelope — exactly how the
> lean local OpenCode path already operates. Mid-turn MCP tools (send_message)
> would need a pi extension; see Notes.

## Prerequisites

1. Ollama on the host with a tool-capable model pulled (`ollama pull qwen3:8b`),
   reachable from agent containers (`host.docker.internal:11434`; on default-deny
   firewalls: `sudo ufw allow from 172.17.0.0/16 to any port 11434 proto tcp`).
2. An agent group (`/init-first-agent`).
3. For the auto-wiring: the agent's local model assigned in the webchat UI (the
   per-agent wiring file `.claude-shared/opencode-model.json` is shared by the
   local harnesses; a `.env` `PI_MODEL`/`PI_PROVIDER`/`ANTHROPIC_BASE_URL`
   fallback also works).

## 1. Install the provider files

Copy the two bundled provider files into place:

```nc:copy
files/pi.container.ts -> container/agent-runner/src/providers/pi.ts
files/pi.host.ts -> src/providers/pi.ts
```

Register the provider in both barrels (idempotent append):

```nc:append to:src/providers/index.ts
import './pi.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './pi.js';
```

Pin the pi CLI into the agent image via the CLI manifest (json-merge — this
install manages global CLIs there, not in the Dockerfile):

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "@earendil-works/pi-coding-agent", "version": "0.83.0", "onlyBuilt": true }
```

Pin deliberately — pi moves fast; bump the version consciously, never `latest`.

## 2. Build and verify

```bash
pnpm run build                                                  # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit  # container typecheck
./container/build.sh                                            # bakes the pi CLI
```

Confirm the CLI landed:
```bash
docker run --rm --entrypoint sh <agent-image> -c 'pi --version'
```

## 3. Select the harness + restart

Webchat: Agent → Harness → **pi** (available once this skill is applied and the
host restarted). Or from the host:

```bash
bin/ncl groups config update --id <group-id> --provider pi
systemctl --user restart nanoclaw
bin/ncl groups restart --id <group-id>
```

## 4. Verify (local, no cloud)

Send the agent a message, then:
```bash
curl -s http://127.0.0.1:11434/api/ps                  # model loaded
journalctl -u ollama --since "-2 min" | grep /v1/chat  # POST from 172.17.0.x → 200
```
A clean reply with no `Unknown provider: pi` means the stack is live. Thinking
models stream reasoning into the webchat bubble (pi emits structured
thinking_delta events); a reasoning-only stall auto-retries with `/no_think`
(same recovery as the OpenCode provider).

## Notes / gotchas

- **Session continuation** uses pi `--session-id` (runner-minted UUID) with
  sessions stored under the per-session mount (`/pi-agent/sessions`) — they
  survive container respawns.
- **models.json is host-written per spawn** from the agent's current local
  model, so switching the model in the webchat UI re-targets pi automatically.
- **No MCP (v1).** For mid-turn tools, pi supports TypeScript extensions —
  a future rev can bundle an extension bridging NanoClaw's MCP server.
- **To remove:** switch the harness back (`--provider opencode` or default),
  restart; delete the two provider files + barrel lines + the cli-tools entry.
