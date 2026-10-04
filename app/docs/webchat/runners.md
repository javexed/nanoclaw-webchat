# Runner agents

An agent that works on the project open in a developer's VS Code. The agent
runs on central, like any other; the NanoClaw extension (`vscode-extension/`
in the overlay repo) on the developer's machine serves it file tools over a
copy of that project, which the developer reviews before anything reaches
their own tree. Nothing runs on the machine for the agent. Operator view:
Manage → Runners ([guide](./guide.md#runners)). This page is the engineering
reference.

**Installed as a skill.** None of this is in webchat by default: `/add-vscode-runner`
(`.claude/skills/add-vscode-runner`) copies the runner modules in, registers
them through webchat's extension points (`src/channels/webchat/extensions.ts`)
and the `fleet` session driver kind, and sets `WEBCHAT_RUNNER_ENABLED=true`. Without
it there is no runner endpoint, no Runners tab and no VS Code steps; the
database tables exist either way and stay empty. The paths below are where the
skill installs each module.

**Invariant:** the machine only ever dials out. The extension opens one
authenticated WebSocket to central (`/ws/runner`); everything else rides it.
It signs in one of two ways, as central's sign-in settings say (Manage →
Runners): `microsoft` sends an Entra
token from VS Code's Microsoft sign-in, verified by central
(`WEBCHAT_OIDC_ISSUER` / `_AUDIENCE`); `network` sends none, and central knows
the laptop by Tailscale or a trusted proxy's identity headers. Pairing needs
one of those — a person. The shared bearer token and localhost are refused.

## Pairing and placement

| Piece | Where |
| --- | --- |
| Socket, hello/welcome, keepalive | `src/channels/webchat/runner-ws.ts` (off unless `WEBCHAT_RUNNER_ENABLED=true`) |
| Request/response frames (the laptop tools) | `src/channels/webchat/runner-transport.ts` |
| Machines, placements, machine keys (migrations 211, 219, 222) | `src/channels/webchat/runner-registry.ts` |
| Approval card, dedicated group | `src/channels/webchat/runner-pairing.ts` |
| The agent's standing instructions | `src/channels/webchat/runner-persona.ts` |
| Laptop tools: MCP endpoint, group configuration, stopping | `src/channels/webchat/runner-tools.ts` |
| Admin API | `GET /api/runners`, `POST /api/runners/machines/:fp/approve` · `/revoke`, `PUT` / `DELETE /api/runners/placements/:group` |

**Machine key.** The fingerprint (sha256 of VS Code's machine id, hostname,
platform, arch) names a machine; it is not a secret. The extension generates an
Ed25519 key on first run (`vscode-extension/src/machine-key.ts`), keeps the
private half in VS Code's secret storage and sends the public key (SPKI DER,
base64) as `hello.machine.publicKey`. Central answers `{type:'challenge', nonce}`
(32 random bytes); the extension replies `{type:'challenge.response', origin,
signature}`, signing `nanoclaw-runner-key-v1\n<fingerprint>\n<origin>\n<nonce>`
where `origin` is the server it dialled. Central accepts the origin only if its
host is one central is configured to be reached at: `WEBCHAT_PUBLIC_URL`,
`WEBCHAT_RUNNER_ORIGINS` (comma-separated URLs or host[:port]), its Tailscale
Serve name, or loopback. Never the request's Host or X-Forwarded-Host, which a
server relaying the challenge sets to its own name. With none configured, a
keyed machine on another host is refused (`origin-unconfigured`: set
`WEBCHAT_PUBLIC_URL`). Then central verifies the signature against the key in
`hello`. Only then is the machine
recorded and welcomed.

| Machine | Hello | Outcome |
| --- | --- | --- |
| New | no key | refused `machine-key-required` (not recorded) |
| New | key, proved | recorded `pending` with that key |
| Known, no key bound | key, proved | key bound, audit `runner.machine.key.bound` |
| Paired before keys, none bound yet | no key | admitted, audit `runner.machine.keyless` |
| Known, no key bound (revoked and approved again) | no key | refused `machine-key-required` |
| Key bound | same key, proved | admitted |
| Key bound | no key, other key, bad signature, other origin | refused 4403 `machine-key-mismatch`, audit `runner.machine.key.mismatch` |

A bound key never changes. Revoking a machine clears it; the machine binds a
new one on its first connection after re-approval, and must bring one:
keyless entry (`webchat_runner_machines.keyless_allowed`, set by migration
221 only for machines paired before keys) ends at the first bind or revoke.
A keyless connection is also refused if a key was bound while it connected.

**Transition:** machines paired before keys existed stay admitted on an
extension without key support (each connect audited `runner.machine.keyless`)
and bind a key on their first connect from an extension with it. Once every
laptop runs such an extension, the keyless row can be refused like a new one.

A new machine is `pending` until an owner approves it; approval creates a
dedicated agent group (model `sonnet`, network Model only) placed on that
machine.

## Laptop tools

A group placed on a machine runs its agent **on central** and works on the
developer's project through tools the extension serves on that machine: Read,
Edit, Write, Glob, Grep and read-only git (GitStatus, GitDiff, GitLog, GitShow,
GitBlame), confined to a proposal copy of the folder bound at
`/workspace/project` (the open workspace folder; secret-like files left out). Nothing on the machine
runs a command the agent chose. A folder is served only once the developer
allows it (once per folder and server). The git tools see the developer's
history beneath the copy but refuse, at any revision, the paths the copy leaves
out, keep them out of diffs, and accept only commits as revisions.

- Central serves the tools as an MCP server at `/laptop` on the MCP relay
  port; the group's container config gets it as `laptop`, with the
  placement's `tools_token` as its `x-nanoclaw-relay` header. Each call is
  forwarded to the machine over the runner socket (`tools.list`,
  `tools.call`); a disconnected machine answers the agent with that, plainly.
  The extension refuses every other op.
- Claude's own shell and file tools are denied in the group's Claude settings
  (`Bash`, `Read`, `Edit`, `Write`, …), so the agent cannot work on a copy on
  central by mistake; denied tools are not even offered to it.
- The standing instructions are the laptop-tools text (`runner-persona.ts`);
  the group's own are kept beside them (`instructions.prepend.container.md`)
  and restored when the placement goes. A text an admin edited is kept. The
  hash of the text written is kept too (`instructions.prepend.tools.sha256`),
  so a new shipped text replaces an older one at startup.
- One proposal copy per group on the machine, re-taken each time an agent
  starts (when it lists the tools) and kept while a proposal is pending. The
  developer reviews it in VS Code (Source Control → NanoClaw, or the panel).
- Removing the placement, revoking or rejecting the machine undoes all of it.
- **Upgrading from the laptop container.** Placements made before it was
  retired (mode `container`) become tools placements at startup, with the
  configuration above. The skill's refresh step deletes the retired modules.
## Stopping

- **Stop all agents** (`nanoclaw.stopAllAgents`) — the extension serves the
  agent nothing more (`tools.list` / `tools.call` refused) until the developer
  resumes (the notification's Resume, `nanoclaw.resumeAgents`, or a message
  from the chat view), and sends `{type:'stopAll'}` (on the next connect if
  central is out of reach). Central stops the running agents of every group
  placed on the machine. Audit `runner.stop_all`.
- **Revoke** — central cuts the machine's chat, stops the agents placed on it,
  closes the socket (4403), and gives each placed group its own configuration
  back.
- **Activity log** — `activity.jsonl` in the extension's global storage, one
  JSON object per line (proposal apply / reject per file, inline review per
  file, stop-all, resume), rotated at 1 MB, three files kept.
  `nanoclaw.showActivityLog` opens it. Anything in the extension records
  through `recordActivity(event, fields)` (`vscode-extension/src/activity-log.ts`).
## Network

The agent runs on central, under the group's policy (Open / Allowlist / Model
only) like any other agent: the egress filter, and the exec relay where it is
on. A machine's dedicated group starts at Model only; an admin widens it per
group. See [security.md](./security.md#per-agent-group-egress).
## Chat view (VS Code)

Frames over the same socket (`src/channels/webchat/runner-chat.ts`):
`chat.open` / `chat.send` → `chat.room`, `chat.message`, `chat.status`,
`chat.error`. Only the machine's own placed room is reachable.

- Working line from `chat.status` (replayed when opened mid-turn).
- Code blocks: Copy / Insert / New file.
- Files: attach (`POST /api/rooms/<room>/upload`), open / save (`GET /api/files/…`).
- Editor note `(editor: path:line)` appended to each message.
- Inline review: per-hunk Accept / Reject in the editor
  (`vscode-extension/src/inline-review.ts`, `review-controller.ts`), for
  proposals.

## Updates

`npx tsx scripts/publish-runner-extension.ts <vsix>` (or Runners → Publish…)
writes `data/runner-extension/`; the welcome / keepalive offers it; the
extension downloads with its bearer, verifies sha256 (and the signature, below)
and installs (`nanoclaw.autoUpdate`: prompt | auto | off).
`GET /api/runners/extension[/download]`.

## Signed releases

HTTPS alone means a compromised central could push its own extension to every
laptop. Releases are signed with an operator Ed25519 key that never
goes to central; central stores and serves the signature, the extension
verifies it.

**Signer** — `scripts/sign-runner-release.ts` in the overlay repo, run where
the extension is built (Node 22.18+, or `npx tsx`). Not in the skill payload:
payload scripts are copied into central's install, which is exactly where the
key must not be. It imports the message format from the extension's verifier
(`vscode-extension/src/release-signing.ts`); central's copy
(`runner-extension.ts`) is held to the same fixed test vector.

**Signed message** (UTF-8, Ed25519 over these bytes):

```
nanoclaw-runner-release/1
kind=vsix
server=<install origin: scheme://host[:port], no path>
subject=<version>
sha256=<hex of the .vsix>
```

The `.sig` file is JSON: `format` (`nanoclaw-runner-release-signature/1`),
those five facts, `key` (`ed25519:<base64>`) and `signature` (base64). The
verifier rebuilds the message from what it expects — the origin of its own
`nanoclaw.serverUrl`, the kind, the version it was offered, the hash of the
bytes it has — never from the file, so a signature does not replay across
installs or releases. (`kind=image` signed central's agent image while the
laptop container existed; such signatures are refused now.)

**Operator flow**

1. `node scripts/sign-runner-release.ts keygen ~/.nanoclaw/release.key` (0600) and `release.key.pub`.
2. Runners → Publish… → `release.key.pub`: the install's release key (runner
   client-config override `releaseKey`; `PUT /api/runners/client-config`). Central
   then refuses signatures by any other key.
3. Extension: `sign --key … --server https://<install> nanoclaw-X.Y.Z.vsix` → `.vsix.sig`;
   Publish… both files (or `publish-runner-extension.ts`, which takes the `.sig` beside the package).
   With a release key set, central refuses a package without its signature.

Step 3 in one command, run again after each release (a package central already
serves signed by the key is left alone):

```
NANOCLAW_TOKEN=… node scripts/sign-runner-release.ts publish --server https://<install> \
  --key ~/.nanoclaw/release.key --build
```

**Where the key lives.** `--key <file>` signs on this machine. To keep the key
off build hosts and CI, run the remote signer where it lives:
`serve --key … --listen <host:port> --token-file … --allow-server https://<install> [--confirm]`
(TLS or a tailnet only; `--confirm` asks at its terminal before each signature),
and point the builder at it with `--signer https://<signer>/sign` plus
`NANOCLAW_SIGNER_TOKEN`. A hardware key signs through `--signer 'cmd:<tool>'`
(message on stdin; prints `{"key","signature"}` or a base64 signature with
`--expect-key`). Every signature a signer returns is verified before it is
used, and `--expect-key release.key.pub` also pins which key must have made it.

| Route | Guard | Carries |
| --- | --- | --- |
| `POST /api/runners/extension` | global admin + CSRF | optional `X-NanoClaw-Signature` (base64 of the `.sig`) |
| `PUT /api/runners/extension/signature` | global admin + CSRF | a `.sig` for the package served now |
| `GET /api/runners/extension`, `/download` | signed in | `signature`; the download as `X-NanoClaw-Signature` |

**Extension** — pins a key per install origin (a Connect link keeps only the
origin; central is reached there whatever the path):
`nanoclaw.releaseSigningKey` (machine scope; wins), else the key central offers
(client-config `releaseKey`, or the Connect link's), pinned on a modal showing
its fingerprint; a different key later asks again, like a changed sign-in
audience, and an offer of nothing never unpins. Declining the first key refuses
that install's releases until a later offer is trusted. With a key pinned, an
unsigned or badly signed update is refused with one line. With none, updates
pass as before, with a one-time notice per install.

## Testing

In `vscode-extension/`: `npm test` (unit), and `npm run harness:editor` — the
inline review, merges and conflicts inside a real VS Code
(`@vscode/test-electron`, `harness/README.md`).
