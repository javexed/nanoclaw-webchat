---
name: add-opencode-stack
description: Point the OpenCode provider at a LOCAL Ollama backend instead of a cloud one. Run after /add-opencode, which installs the provider itself. Upstream supports self-hosted OpenAI-compatible endpoints natively, so this skill only configures one - it ships no provider code. Use when you want a NanoClaw agent running on local Ollama through OpenCode's harness.
---

# OpenCode on a local Ollama backend

> **Run `/add-opencode` first.** It installs the provider, its contracts, the
> barrels, the CLI and the image layer, and it authenticates cloud backends.
> This skill does one thing the base skill does not document: point that
> installation at a **local** OpenAI-compatible endpoint. It ships no provider
> code and patches nothing.

## What the base skill already handles

Everything this skill used to carry by hand:

- **A self-hosted endpoint.** `OPENCODE_PROVIDER=openai` with a custom
  `OPENCODE_BASE_URL` pins the `@ai-sdk/openai-compatible` transport (Chat
  Completions), which is what a local runtime speaks.
- **A placeholder credential**, so no OneCLI entry is needed for a keyless
  local endpoint.
- **Model registration** from the group's configured model, else
  `OPENCODE_MODEL`, plus `OPENCODE_SMALL_MODEL`, stripping the provider prefix.
- **Reading `.env`.** The host process does not load `.env` into `process.env`;
  the provider falls back to the file itself.

## 1. Prerequisites

- `/add-opencode` applied and its build green.
- Ollama on the host with a pulled model, reachable from a container as
  `host.docker.internal:11434`.

## 2. Point OpenCode at Ollama

```nc:env-set
OPENCODE_PROVIDER=openai
OPENCODE_BASE_URL=http://host.docker.internal:11434/v1
OPENCODE_MODEL_CONTEXT_LIMIT=32768
OPENCODE_MODEL_OUTPUT_LIMIT=8192
```

**No model is set here — it is the one picked in webchat.** When a group's
effective model (its own assignment, else the workspace default) is an Ollama
model and the group runs on OpenCode, `syncAgentProviderForAssignedModel`
writes it to the group's `container_configs.model` (read first by upstream's
provider) and to `OPENCODE_MODEL` / `OPENCODE_SMALL_MODEL` in `.env` (the
install-wide fallback), and points `OPENCODE_BASE_URL` at that model's
endpoint. Pick a different model in the UI and the harness follows on the next
spawn. Applying this skill by hand, without webchat, set the group's model
yourself:

```bash
bin/ncl groups config update --id <group-id> --model openai/<model>
```

Easy to get wrong:

- **`OPENCODE_PROVIDER` is `openai`, not `ollama`.** The custom-transport pin is
  scoped to the `openai` provider; any other id keeps OpenCode's default
  transport resolution and a local runtime rejects the resulting requests.
- **Model ids keep the `openai/` prefix.** The container strips the provider
  prefix before registering the model, so `openai/qwen3:8b` registers `qwen3:8b`.
- **Set BOTH limits.** A model the registry does not know resolves
  `limit.context` to 0, which silently disables compaction and kills long
  sessions — and OpenCode rejects a `limit` block with only one key
  (`limit.output: "Missing key"`), so a session never opens at all; the
  container log shows nothing but `Query error`. Use the model's real context
  window; webchat writes both when a model is picked, set-if-absent.
- **Leave `OPENCODE_AUTH_MODE` unset.** It exists for the ChatGPT stub; local
  endpoints use the API-key path with the placeholder.

**Per-group models stay per-group.** The old forked payload read a per-agent
`local-model.json`; upstream's provider reads the group's configured model
instead, which webchat writes from the same pick, so two groups can still run
different local models. Pi reads the file. Do not re-fork the provider to change
any of this.

## 3. Let the container reach the host directly

Agents run behind the OneCLI proxy, so `host.docker.internal` has to be exempt
or OpenCode's requests leave through the proxy instead of reaching Ollama.
Webchat already sets `NO_PROXY`/`no_proxy` to the host alias when an Ollama
model is wired to a group, and the OpenCode provider contributes its own
`NO_PROXY` for loopback. Confirm the two compose rather than overwrite:

```bash
docker inspect <agent-container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i '^no_proxy'
```

`host.docker.internal` must appear. If it does not, fix it in the smallest way
that works - exporting `NO_PROXY` for the host service, or an upstream change
that merges the alias - and never by forking the provider again.

## 4. Select the provider and set identity

```bash
bin/ncl groups config update --id <group-id> --provider opencode
```

OpenCode reads persona and instructions from `/workspace/agent/CLAUDE.local.md`,
not `instructions.prepend.md`, and does not expand `@./` includes. If the model
answers as Claude, state the identity explicitly in that file.

## 5. Verify it is local

One turn on the group, then check that the turn used the local endpoint and that
tool calls round-trip:

```bash
bin/ncl sessions list                             # find the session id
bin/ncl sessions history <session-id> --limit 40
curl -s http://127.0.0.1:11434/api/ps          # the model is resident
```

A turn that reaches a cloud backend is a misconfiguration, not a fallback: with
a placeholder credential there is nothing to authenticate with.

## Optional configuration

- `OPENCODE_MODEL_INPUT_MODALITIES` - comma-separated from `text,audio,image,video,pdf`.
  A registry-unknown model declares no modalities, so an image reaches the
  session store and never the model until this is set.
- `pnpm exec tsx scripts/opencode-models.ts --list --refresh` lists what the
  endpoint offers; a custom OpenAI-compatible URL is queried through its own
  `/models`.

## Troubleshooting

**The model answers but ignores tools.** The local runtime must advertise tool
support for the registered model; check the entry the container registers and
the model's own capabilities.

**Long sessions die or repeat.** `OPENCODE_MODEL_CONTEXT_LIMIT` is missing or
wrong, so compaction never triggers.

**Requests leave through the proxy.** See step 3 - `no_proxy` in the container
lacks `host.docker.internal`.

**Images are described as unsupported.** Set `OPENCODE_MODEL_INPUT_MODALITIES`.

**To remove:** switch the group back with `--provider claude`, then follow
`/add-opencode`'s REMOVE.md. This skill owns only `.env` values.

## Why this skill no longer ships provider files

It used to bundle three pre-patched provider files and copy them over the base
skill's install: a memory-hook no-op the seam required, an MCP `stdio|remote`
union, and `.env` plus proxy handling the host provider lacked. Upstream has
since implemented all three, and a copied file would now overwrite a modular,
contract-based provider with an older monolith. What remains genuinely local is
configuration, which is all this skill now does.
