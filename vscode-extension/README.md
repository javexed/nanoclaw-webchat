# NanoClaw for VS Code

Runner for NanoClaw central (0.13.x). It does two things:

- **Runs agents on this machine.** Agent groups an owner places on this machine run in a local container. Central sends the spec; this extension realizes it.
- **The NanoClaw panel.** Chat with this machine's agent from the editor, and review its changes.

Signs in as you with VS Code's built-in Microsoft account. No credential ever reaches this machine.

## Requirements

- Docker or Podman. `nanoclaw.containerRuntime` = `auto` (docker, then podman), `docker` or `podman`; `nanoclaw.runtimePath` if the CLI is not on PATH.
- Windows with a Podman machine works as-is: the model relay runs **inside** the container, over the runtime's `exec` channel. Nothing listens on the host; no firewall rule.
- Podman: the container user is pinned (`--userns keep-id`); `C:\…` is mapped to the machine's `/mnt/c/…`.
- First session: the agent image is built locally from the context central ships (several minutes). See [Agent image](#agent-image).

## Sign-in and connection

- **NanoClaw: Connect** signs in (if needed) and opens the runner link. `nanoclaw.autoConnect` connects silently at startup when already signed in.
- A new machine waits for an owner's approval (Manage → Runners).
- The link reconnects on its own, with backoff.
- After sleep/wake: once connected, a missing token is treated as temporary and retried. Focusing the window, or a sign-in change, retries at once.
- Central holds a session while this machine is away (up to 12 h) and resumes it when the machine and its container runtime return. A container that stopped meanwhile is replaced, never revived.
- Status bar: connection state and who you are signed in as.

## The NanoClaw panel

Activity bar → **NanoClaw**.

| Item | Does |
|---|---|
| Message box | Sends to this machine's agent, with `(editor: path:line)` — the file and line or selection you are on. |
| Working line | Live agent status: `Working…`, tool steps; amber when stalled. |
| + Selection | Inserts the selection (or whole file) as a fenced block. |
| + File | Attaches files (removable chips), sent with the next message. |
| File cards | Files the agent sends: **Open** / **Save…**. |
| Code blocks | On hover: **Copy** / **Insert** (at the cursor, replaces the selection) / **New file**. |

## Reviewing changes

**Propose mode** (default). The agent edits a clone of your repository at your current commit (branch `nanoclaw/proposal`). Your tree is untouched until you apply.

- Per file: **Review** (inline) / **Diff** / **Apply** / **Reject**; plus **Review**, **Apply all**, **Reject all**.
- New and deleted files: Apply / Reject only.

**Direct mode.** The agent edits your working tree. Per file: **Review** / **Diff** / **Keep** (stage) / **Revert**.

**Inline review.** Old lines red, new lines green, in the real file. **✓ Accept** / **✗ Reject** above each hunk; **Accept all** / **Reject all** above the first.

| While reviewing | Windows / Linux | macOS |
|---|---|---|
| Accept change | Ctrl+Alt+Enter | Cmd+Alt+Enter |
| Reject change | Ctrl+Alt+Backspace | Cmd+Alt+Backspace |
| Next change | Alt+F5 | Alt+F5 |

- Hunks whose lines you edited since the proposal are set aside; use Diff.
- The file is saved when the last hunk is decided (if it had no unsaved edits). Undo ends the review.

## Network policy

Each agent is Open, Allowlist (default) or Model only, set in NanoClaw. A refused connection:

```
HTTP 403 — blocked by NanoClaw network policy: <host> is not on the allowlist — an admin can allow it in Manage → Network
```

## Updates

Central serves the runner package and offers newer builds on connect and keepalive.

- `nanoclaw.autoUpdate`: `prompt` (default) / `auto` / `off`.
- Downloaded over the signed-in connection, sha256 checked against central's announcement, installed by VS Code; reload to activate.
- Offered once per window; a status-bar item stays until installed. **NanoClaw: Check for Updates** asks central now.

## Agent image

`nanoclaw.agentImage`: `build` (default) or `pull`. The install-wide policy (Manage → Runners → Agent image; default **Build**) overrides it when set to Build or Pull.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `nanoclaw.serverUrl` | `""` | Central origin, e.g. `https://<app>.azurewebsites.net`. |
| `nanoclaw.signIn` | `"microsoft"` | `microsoft`: Entra sign-in (App Service installs). `network`: no sign-in; central identifies you by Tailscale or an identity-aware proxy, so the laptop must reach central over that network. |
| `nanoclaw.appIdUri` | `""` | App Service Entra Application ID URI (`api://<client-id>`); token audience. |
| `nanoclaw.tenantId` | `""` | Entra tenant ID. |
| `nanoclaw.clientId` | `""` | Own app registration to sign in with; empty = VS Code's Microsoft app. |
| `nanoclaw.autoConnect` | `true` | Connect at startup when signed in. |
| `nanoclaw.containerRuntime` | `auto` | `auto` / `docker` / `podman`. |
| `nanoclaw.runtimePath` | `""` | Full path of the docker/podman CLI. |
| `nanoclaw.workspaceMount` | `workspace` | `workspace`: the open folder fills `/workspace/project`. `off`: none. |
| `nanoclaw.slots` | `{}` | Container path → local directory for slots central declares. Unbound slots are refused. |
| `nanoclaw.mountAllowlist` | `[]` | Directories a slot may resolve into; empty = folders open in this window. |
| `nanoclaw.workspaceExcludes` | secrets, `.env*`, keys, `.ssh`, `.aws`, `.azure`, … | Hidden from the agent inside a slot (empty read-only mounts). Central may add more. |
| `nanoclaw.agentImage` | `build` | `build` / `pull`. |
| `nanoclaw.agentImageRef` | `""` | Image to pull, pinned by digest; empty = central's pin. |
| `nanoclaw.allowUnlabeledAgentImage` | `false` | Accept a pulled image without the agent-runner lock label. |
| `nanoclaw.autoUpdate` | `prompt` | `prompt` / `auto` / `off`. |

## Commands

| Command | Title |
|---|---|
| `nanoclaw.connect` | NanoClaw: Connect |
| `nanoclaw.disconnect` | NanoClaw: Disconnect |
| `nanoclaw.status` | NanoClaw: Show Status |
| `nanoclaw.focusChat` | NanoClaw: Open |
| `nanoclaw.openChat` | NanoClaw: Open Web Chat (browser) |
| `nanoclaw.sendSelection` | NanoClaw: Send Selection to Agent |
| `nanoclaw.checkForUpdates` | NanoClaw: Check for Updates |
| `nanoclaw.installUpdate` | NanoClaw: Install Offered Update |
| `nanoclaw.review.accept` / `.reject` | NanoClaw: Accept change / Reject change |
| `nanoclaw.review.acceptAll` / `.rejectAll` | NanoClaw: Accept / Reject all changes in file |
| `nanoclaw.review.next` | NanoClaw: Next change |

## App registration (Entra ID)

Sign-in uses VS Code's built-in Microsoft account provider. Two options:

1. **Own app registration** — set `nanoclaw.clientId`. Under *Authentication → Mobile and desktop applications*:
   - `http://localhost` (browser loopback)
   - `ms-appx-web://microsoft.aad.brokerplugin/<client-id>` (Windows broker/WAM; without it VS Code falls back to the browser)
   - *Allow public client flows* = Yes
   - Delegated `user_impersonation` on the NanoClaw App Service app, consented.
2. **VS Code's default client** (`aebc6443-996d-45c2-90f0-388ff96faa56`) — leave `nanoclaw.clientId` empty; EasyAuth's `allowedApplications` must include that id.

Do not add `offline_access` to any scope list; the provider adds `openid email profile offline_access` and refreshes silently.

## How a placed session runs

- The spec never names a central path or carries a credential. The gateway URL is replaced by a sentinel; the container's proxy is a forwarder inside it that relays each connection to central, which checks the network policy and terminates it at the credential gateway as that agent.
- The container runs with `--network none`; the relay is its only way out.
- The agent syncs its own mailbox, status, acknowledgements and files with central over the relay.
- Storage (extension global storage): `runner/state/…` (session state), `runner/bundles/<sha256>/` (shipped read-only content), `runner/proposals/<group>/<session>` (proposal clones).

## Development

| Script | Does |
|---|---|
| `npm run build` | Bundle `dist/extension.js` (esbuild). |
| `npm run build:core` | `tsc` → `out/` (used by the harnesses). |
| `npm test` | Unit tests (vitest). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run package` | Build and package `nanoclaw-<version>.vsix`. |
| `npm run harness` | Real runner + real container against a minimal central (staging `dist`). Run before packaging any runner change. |
| `npm run harness:editor` | Inline review in a real VS Code: `harness/editor-docker.sh` runs it in the agent image against a host Xvfb. |

Publish to central (staging checkout, `.env` loaded):

```
npx tsx scripts/publish-runner-extension.ts <path>/nanoclaw-<version>.vsix
```
