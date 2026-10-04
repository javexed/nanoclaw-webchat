# NanoClaw for VS Code

Runner for NanoClaw central (0.13.x). It does two things:

- **Gives an agent your project.** An agent group an owner places on this machine runs on central; this extension serves it file tools (read, search, edit, and read-only git) over a copy of your project. It runs nothing on this machine.
- **The NanoClaw panel.** Chat with this machine's agent from the editor, and review its changes.

Signs in as you with VS Code's built-in Microsoft account. No credential ever reaches this machine.

## Requirements

- The project folder is a git repository: the agent works on a copy of it, and its changes come back as a diff.

## Sign-in and connection

- **NanoClaw: Connect** signs in (if needed) and opens the runner link. `nanoclaw.autoConnect` connects silently at startup when already signed in.
- A new machine waits for an owner's approval (Manage → Runners).
- The link reconnects on its own, with backoff.
- After sleep/wake: once connected, a missing token is treated as temporary and retried. Focusing the window, or a sign-in change, retries at once.
- While this machine is away the agent's tools fail; it says so in the chat.
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

The agent edits a copy of your working tree: your commit plus uncommitted and untracked files (gitignored ones only those listed in `nanoclaw.agentCopy.includeIgnored`, or all with `*` there; never dependency folders, secret-like files or nested `.git`). Your tree is untouched until you apply.

A text file up to 1 MiB holding a secret (private key, cloud or API token, a long quoted `password`/`token`/`secret`/`api_key` value) is left out of the copy whole; the count is shown, the list is in the NanoClaw output. Larger and binary files are copied unscanned.

- The proposal is listed in the Source Control view, as **NanoClaw** beside Git, and in the panel.
- Per file: **Review** (inline) / **Diff** / **Apply** / **Reject**; plus **Review**, **Apply all**, **Reject all**.
- New and deleted files: Apply / Reject only.
- Applied files leave the list and show in Git's, ready to commit.
- A file you changed since the proposal is merged: your edits and the agent's both go in, and where you both changed the same lines you get conflict blocks (Accept Current = yours, Accept Incoming = the agent's). The file is listed under **Conflicts** (Source Control and the panel) until it is saved with none left; Next / Previous change (Alt+F5 / Shift+Alt+F5) move between the blocks, and the status bar counts them.
- When the agent finishes a turn with new changes, the chat says so with Review / Apply all (a notification when the panel is hidden).

**Inline review.** Old lines red, new lines green, in the real file. **✓ Accept** / **✗ Reject** above each hunk; **Accept all** / **Reject all** above the first.

| While reviewing | Windows / Linux | macOS |
|---|---|---|
| Accept change | Ctrl+Alt+Enter | Cmd+Alt+Enter |
| Reject change | Ctrl+Alt+Backspace | Cmd+Alt+Backspace |
| Next change | Alt+F5 | Alt+F5 |
| Previous change | Shift+Alt+F5 | Shift+Alt+F5 |
| Next file to review | Ctrl+Alt+F5 | Cmd+Alt+F5 |

- Changes whose lines read differently in your file are not shown; **Compare** opens the agent's version beside yours, and the diff's arrows copy a change across. Changes already in the file count as done.
- Each decision is written to disk as you make it, so Git shows progress; the status bar shows the changes left. A file with unsaved edits is instead saved by you at the end. Undo ends the review.
- A review survives a window reload.

## Updates

Central serves the runner package and offers newer builds on connect and keepalive.

- `nanoclaw.autoUpdate`: `prompt` (default) / `auto` / `off`.
- Downloaded over the signed-in connection, sha256 checked against central's announcement, installed by VS Code; reload to activate.
- Offered once per window; a status-bar item stays until installed. **NanoClaw: Check for Updates** asks central now.
- Signed releases: with a release signing key pinned for the server, an update must carry the operator's signature by that key, or it is refused. Central (or its Connect link) offers the key; it is pinned on a confirmation showing its fingerprint, and a different key later asks again. `nanoclaw.releaseSigningKey` pins one yourself. No key pinned: accepted as before, with a one-time notice.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `nanoclaw.serverUrl` | `""` | Central origin, e.g. `https://<app>.azurewebsites.net`. |
| `nanoclaw.autoConnect` | `true` | Connect at startup when signed in. |
| `nanoclaw.agentCopy.includeIgnored` | `[]` | Gitignored folders or files to copy for the agent, relative to the project root, e.g. `site-theme`. `*` copies all. |
| `nanoclaw.agentCopy.exclude` | secrets, `.env*`, keys, `.ssh`, `.aws`, `.azure`, … | Left out of the agent's copy. |
| `nanoclaw.agentCopy.allowSecretsIn` | `[]` | Globs copied even when the secret scan finds a secret in them. |

Before 0.16.11 these were `proposeIncludePaths` and `proposeIncludeIgnored` (now one list), `workspaceExcludes` and `proposeSecretScanAllow`; values set under those names move to the new ones at start-up.
| `nanoclaw.autoUpdate` | `prompt` | `prompt` / `auto` / `off`. |
| `nanoclaw.releaseSigningKey` | `""` | Release signing key (`ed25519:…`) updates must be signed with; empty = the key central offers, pinned per server on confirmation. |

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
| `nanoclaw.review.next` / `.previous` | NanoClaw: Next change / Previous change |
| `nanoclaw.review.nextFile` | NanoClaw: Next file to review |
| `nanoclaw.forgetAllowedFolders` | NanoClaw: Forget allowed folders |
| `nanoclaw.proposal.reviewAll` / `.applyAll` / `.rejectAll` | NanoClaw: Review / Apply all / Reject all (Source Control title bar) |

## App registration (Entra ID)

Sign-in uses VS Code's built-in Microsoft account provider, with the settings central sends (Manage → Runners: tenant, App ID URI, optional client id). Nothing to set on the machine. Two options, set on central:

1. **Own app registration** — set its client id on central. Under *Authentication → Mobile and desktop applications*:
   - `http://localhost` (browser loopback)
   - `ms-appx-web://microsoft.aad.brokerplugin/<client-id>` (Windows broker/WAM; without it VS Code falls back to the browser)
   - *Allow public client flows* = Yes
   - Delegated `user_impersonation` on the NanoClaw App Service app, consented.
2. **VS Code's default client** (`aebc6443-996d-45c2-90f0-388ff96faa56`) — leave the client id empty. EasyAuth's `allowedApplications` must include that id, and the App Service app should list it under *Expose an API → Authorized client applications* (with `user_impersonation`), or users are asked for admin consent.

Do not add `offline_access` to any scope list; the provider adds `openid email profile offline_access` and refreshes silently.

## How it works

- The agent runs on central. Its only way to this machine is the laptop tools, over the runner link: `Read`, `Edit`, `Write`, `Glob`, `Grep`, and `GitStatus`, `GitDiff`, `GitLog`, `GitShow`, `GitBlame`. Nothing runs on this machine for it.
- The copy is taken each time the agent starts, in the background: its tool list is answered at once, and its first tool call waits for the copy (or reports why it was refused).
- Between starts the copy follows your saved edits within seconds, unless it holds an unapplied proposal. A folder listed in `nanoclaw.agentCopy.includeIgnored` follows them only if it is a git repository of its own; otherwise it is copied again at the next start.
- A folder is served only once you allow it (asked once per folder and server; **NanoClaw: Forget allowed folders** asks again).
- Every path is checked against the copy: `..`, absolute paths elsewhere, a link leading out, and `.git` are refused.
- The git tools see your history beneath the copy, but not what the copy leaves out: those paths are refused at any revision and kept out of diffs; revisions must be commits.
- Grep runs in a worker and is stopped after 20 s, so a pattern that backtracks badly cannot freeze the editor.
- **Stop all agents** stops serving the tools until you resume (writing to the agent resumes too), and tells central.
- Storage (extension global storage): `runner/proposals/<group>/laptop-tools` (the agent's copy of the project).

## Development

| Script | Does |
|---|---|
| `npm run build` | Bundle `dist/extension.js` (esbuild). |
| `npm run build:core` | `tsc` → `out/` (used by the editor harness). |
| `npm test` | Unit tests (vitest). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run package` | Build and package `nanoclaw-<version>.vsix`. |
| `npm run harness:editor` | Inline review in a real VS Code: `harness/editor-docker.sh` runs it in the agent image against a host Xvfb. |

Publish to central (staging checkout, `.env` loaded):

```
npx tsx scripts/publish-runner-extension.ts <path>/nanoclaw-<version>.vsix
```
