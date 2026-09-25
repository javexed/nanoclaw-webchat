---
name: add-pi-stack
description: Install the pi coding-agent harness (@earendil-works/pi-coding-agent) as a NanoClaw agent provider wired to a LOCAL Ollama model. pi's harness is minimal by design — no 16k coding preamble, structured thinking events, one-shot JSON mode — so a small local model (8B via Ollama) sees ONLY NanoClaw's own instructions: the smallest prompt of any harness here. Use as an alternative to /add-opencode-stack when you want the leanest local harness. Tools (read, write, edit, bash, and a bundled `message` extension for delivery) are on by default; no MCP.
---

# pi + local Ollama stack

The `pi` provider runs each turn through the pi coding agent in one-shot JSON
mode (`pi -p --mode json --tools … --extension … --append-system-prompt …`)
against the agent's local Ollama model. Compared to OpenCode: no server process,
no SDK dependency, no heavyweight system prompt to strip. With `PI_TOOLS=none`
the provider runs tool-less and passes `--no-tools --system-prompt` (a full
replacement) instead.

> **Scope:** pi has no built-in MCP. Delivery goes through the bundled `message`
> extension tool; NanoClaw's MCP tools are not available.

## Prerequisites

1. Ollama on the host with a tool-capable model pulled (`ollama pull qwen3:8b`),
   reachable from agent containers (`host.docker.internal:11434`; on default-deny
   firewalls: `sudo ufw allow from 172.17.0.0/16 to any port 11434 proto tcp`).
2. An agent group (`/init-first-agent`).
3. For the auto-wiring: the agent's local model assigned in the webchat UI (the
   per-agent wiring file `.claude-shared/local-model.json` is shared by the
   local harnesses; a `.env` `PI_MODEL`/`PI_PROVIDER`/`ANTHROPIC_BASE_URL`
   fallback also works).

## 1. Install the provider files

Copy the three bundled provider files into place. The extension is not
optional: without it pi has no `message` tool, and the provider passes
`--extension` pointing at that path on every spawn.

```nc:copy
files/pi.container.ts -> container/agent-runner/src/providers/pi.ts
files/pi.host.ts -> src/providers/pi.ts
files/pi-message-extension.ts -> container/agent-runner/src/providers/pi-message-extension.ts
```

It lands under `container/agent-runner/src` because that tree is the only one
mounted into the agent container — an extension anywhere else is invisible to
the running pi.

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

## Tuning: tools and thinking level

Two knobs, both env vars. Precedence is code default → per-model profile →
install `.env` → the agent's own Environment panel (per-agent env wins a
collision), so a single agent can differ from the install without a code change.

| var | default | values |
|---|---|---|
| `PI_TOOLS` | `read,write,edit,bash,message` | comma-separated allowlist, or `none` for a chat-only agent |
| `PI_THINKING` | `high` | `off, minimal, low, medium, high, xhigh, max` |

**Tools were off originally, and turning them on matters.** A toolless pi
answers "Create a file called hello.sh…" with *"Creating `hello.sh` now."*
and creates nothing — it cannot know it has no hands. With tools it writes
the file, chmods it, and reports the path. Set `PI_TOOLS=none` only if you
want a deliberately chat-only agent.

**Thinking high is FASTER than low on a reasoning model.** Measured on
ornith-1.5:9b, same task, clean session each time:

| | `low` | `high` |
|---|---|---|
| wall time | 660s | **130s** |
| reasoning events | 68 | **17** |
| answer | announced an intention, never confirmed | reported the path and that it runs |

Starved of budget the model flails in fragments that never converge; given
room it plans once and acts. Lower the level only for a model that does not
reason, where the thinking is pure overhead.

**Latency floor is the model server, not pi.** If the backend evicts the
model between turns (Ollama's default `keep_alive` is 5 minutes), every turn
after an idle gap pays a full cold load — measured at 14.5s cold vs 2.0s
warm for a 9B model. Raise `OLLAMA_KEEP_ALIVE` on the model host before
blaming the harness.

## Notes / gotchas

- **Session continuation** uses pi `--session-id` (runner-minted UUID) with
  sessions stored under the per-session mount (`/pi-agent/sessions`) — they
  survive container respawns.
- **models.json is host-written per spawn** from the agent's current local
  model, so switching the model in the webchat UI re-targets pi automatically.
- **No MCP.** The bundled `message` extension covers delivery; bridging
  NanoClaw's MCP server would need another pi extension.
- **To remove:** switch the harness back (`--provider opencode` or default),
  restart; delete the three provider files + barrel lines + the cli-tools entry.
