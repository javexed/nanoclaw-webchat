---
name: add-grok
description: Use Grok Build (xAI's coding agent) as a full agent provider — ACP over stdio, tool orchestration, session resume, native CLAUDE.md/AGENTS.md reading — alongside or instead of Claude. Driven by a SuperGrok or X Premium+ subscription via device-code login, never an API key. Per-group via `ncl groups config update --provider grok`.
---

# Grok agent provider

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Grok provider: copy the payload from the fork's `providers-grok` branch, append one import to each of the three provider barrels, rebuild the image (which installs the pinned Grok CLI), then run the device-code auth walk-through.

The provider runs `grok agent stdio` as a child process speaking ACP — JSON-RPC over stdin/stdout. The continuation is an ACP sessionId, which resumes across process **and** container restarts because the CLI's session store is mounted per agent group.

Credentials are **subscription-only**: a device-code login stores the refresh token on the host, outside any container mount, and only a short-lived access token is materialised into the container. No `XAI_API_KEY` is used or needed.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run.

## Install

### Pre-flight

Check whether the payload is already wired. All of these present means installed — skip to **Authenticate**:

- `src/providers/grok.ts` and `src/providers/grok-auth.ts`
- `container/agent-runner/src/providers/grok.ts` and `grok-acp.ts`
- `setup/providers/grok.ts`
- `import './grok.js';` in all three provider barrels
- `ARG GROK_VERSION` in `container/Dockerfile`

### 1. Fetch and copy the payload

Fetch the **`providers-grok`** branch and copy the payload into all three trees (additive — overwrite each file, never merge the branch).


```nc:copy from-branch:providers-grok
src/providers/grok.ts
src/providers/grok-auth.ts
src/providers/grok-reauth.ts
src/providers/grok.test.ts
src/providers/grok-auth.test.ts
src/providers/grok-reauth.test.ts
container/agent-runner/src/providers/grok.ts
container/agent-runner/src/providers/grok-acp.ts
container/agent-runner/src/providers/grok.test.ts
container/agent-runner/src/providers/grok-acp.test.ts
container/agent-runner/src/providers/grok-registration.test.ts
setup/providers/grok.ts
setup/providers/grok.test.ts
container/grok-cli-pin.test.ts
```

The Grok CLI is a native binary, so it cannot ride `container/cli-tools.json` (that
manifest installs through `pnpm install -g`). It goes into the image as a layer
inserted into the Dockerfile's `nanoclaw:image-layers` region — never by copying the
Dockerfile, which would roll back every change trunk has made to it since this
payload was cut (rtk, the bun version, the pinned build frontend).

Two rules the block below follows, because the engine enforces them bluntly:

- Its first line is the install sentinel: re-apply skips the whole block when the
  Dockerfile already has that line.
- No blank lines, no `USER` lines, and no line that also appears elsewhere in the
  Dockerfile. The engine's undo (`removeSkill`, the journal played backwards)
  deletes every line matching one this skill added, anywhere in the file — a
  `USER node` here would take trunk's with it.

```nc:append to:container/Dockerfile at:nanoclaw:image-layers
ARG GROK_VERSION=1.0.5
# grok: native CLI for the grok provider, pinned (never `latest`). It installs under
# grok: /usr/local/bin, never ~/.grok, which the provider mounts per group; the installer
# grok: only symlinks, and reads GROK_BIN_DIR only when it is set on the bash side of the pipe.
RUN curl -fsSL https://x.ai/cli/install.sh \
      | GROK_BIN_DIR=/usr/local/bin bash -s "${GROK_VERSION}" && \
    cp "$(readlink -f /usr/local/bin/grok)" /tmp/grok.bin && \
    rm -f /usr/local/bin/grok /usr/local/bin/agent && \
    mv /tmp/grok.bin /usr/local/bin/grok && \
    chmod 0755 /usr/local/bin/grok && \
    rm -rf /root/.grok && \
    /usr/local/bin/grok --version && \
    test ! -e /home/node/.grok/bin/grok
```

### 2. Wire the barrels

Append the self-registration import to each of the three provider barrels (skipped if already present). Each registration test imports its real barrel and asserts `grok` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './grok.js';
```
```nc:append to:container/agent-runner/src/providers/index.ts
import './grok.js';
```
```nc:append to:setup/providers/index.ts
import './grok.js';
```

### 3. Build

The image build installs the pinned Grok CLI from the layer this skill inserted. `ARG GROK_VERSION=1.0.5` in that layer is the pin, and the layer block above is its single source of truth. There is no `.env` override: `container/build.sh` is no longer part of this payload, so nothing passes a build arg.

**To change the version,** edit the `ARG GROK_VERSION=` line in the layer block above and redeploy. An installer deploy recomposes `container/Dockerfile` from trunk — with the `nanoclaw:image-layers` region empty — before this skill is re-applied, so the result is exactly one layer at the new version.

Re-applying onto a tree whose Dockerfile **already carries the layer** does not update it. The engine recognises an installed layer only by its first line, so a changed `ARG GROK_VERSION=` line reads as not installed and a second layer is inserted beside the old one: two `ARG`s, two installs. Delete the old layer from the region by hand first. There is no uninstall command that does this for you — the engine's undo replays a journal, and that journal exists only inside the process that applied the skill; nothing persists it.

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 4. Validate

```nc:run effect:test
pnpm vitest run src/providers/grok.test.ts src/providers/grok-auth.test.ts setup/providers/grok.test.ts container/grok-cli-pin.test.ts
```
```nc:run effect:test
cd container/agent-runner && bun install --frozen-lockfile && bun test src/providers/grok-acp.test.ts src/providers/grok.test.ts src/providers/grok-registration.test.ts
```

The `bun install` is not redundant. The agent-runner tree is a separate package
whose dependencies normally exist only inside the image, so on a host that has
never run it the registration test fails to even load — it imports the real
barrel, which imports `claude.ts`, which needs the Agent SDK. Installing first
is idempotent and matches the documented container dev loop.

`container/grok-cli-pin.test.ts` guards the packaging invariants that only fail at spawn time: the version stays pinned, the binary installs outside `~/.grok` (which the provider mounts over), and it is dereferenced into a file the unprivileged `node` user can execute.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth grok
```

Runs a device-code login inside a throwaway container: a URL and a short code appear, you confirm on any device with a browser. The resulting refresh token is stored on the host under `data/grok/`; containers only ever receive a short-lived access token. Idempotent — re-running replaces the stored credential, which is also how you recover an expired or revoked session.

One login serves every agent group. A per-group credential file overrides it when present, for a second subscription or a deliberately separate identity.

## Use it

Point a group at Grok:

```bash
ncl groups config update --id <group-id> --provider grok
ncl groups restart --id <group-id> --message "switched to grok"
```

Models available on a subscription are `grok-4.6` (default) and `grok-4.5`. Set one with `--model`.

Do **not** change `DEFAULT_AGENT_PROVIDER` — installed is not authenticated, and a new group defaulting to an unauthenticated provider fails at first message.

## Notes and troubleshooting

**"grok: not found" at spawn.** The image was built without the CLI, or the Dockerfile layer was lost. Check `ARG GROK_VERSION` is present in `container/Dockerfile`, inside the `nanoclaw:image-layers` region, and rebuild. If the region itself is missing, the webchat Dockerfile patch did not apply, and the layer has nowhere to land — re-apply will fail with `append marker "nanoclaw:image-layers" not found`.

**Every room goes silent after switching.** Check credentials exist: `data/grok/credentials.json` should be present and `0600`. If missing, re-run the auth step.

**Resumed sessions repeat themselves.** That would mean replayed history is being forwarded as content — the provider drops it deliberately. Re-run the container provider tests; `grok-acp.test.ts` pins the replay window.

**Memory across a provider switch.** Grok reads `CLAUDE.md` and `AGENTS.md` natively, so a group's existing project doc carries over without conversion. Conversation history does not — the continuation is provider-specific. See `docs/provider-migration.md`.
