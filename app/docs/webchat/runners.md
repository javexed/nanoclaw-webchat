# Runner agents

An agent whose container runs on a developer's machine, driven from VS Code by
the NanoClaw extension (`vscode-extension/` in the overlay repo), while central
keeps the mailbox, the credentials and the policy. Operator view: Manage →
Runners ([guide](./guide.md#runners)). This page is the engineering reference.

**Invariant:** the machine only ever dials out. The extension opens one
authenticated WebSocket to central (`/ws/runner`); everything else rides it.
It signs in one of two ways (`nanoclaw.signIn`): `microsoft` sends an Entra
token from VS Code's Microsoft sign-in, verified by central
(`WEBCHAT_OIDC_ISSUER` / `_AUDIENCE`); `network` sends none, and central knows
the laptop by Tailscale or a trusted proxy's identity headers. Pairing needs
one of those — a person. The shared bearer token and localhost are refused. The agent container has no
network of its own.

## Pairing and placement

| Piece | Where |
| --- | --- |
| Socket, hello/welcome, keepalive | `src/channels/webchat/runner-ws.ts` (off unless `WEBCHAT_RUNNER_ENABLED=true`) |
| Request/response + upstream frames | `src/channels/webchat/runner-transport.ts` |
| Machines, placements (migration 211) | `src/channels/webchat/runner-registry.ts` |
| Approval card, dedicated group, persona | `src/channels/webchat/runner-pairing.ts` |
| Admin API | `GET /api/runners`, `POST /api/runners/machines/:fp/approve` · `/revoke`, `/api/runners/placements/:group`, `PUT /api/runners/image-source` |

A new machine is `pending` until an owner approves it; approval creates a
dedicated agent group (model `sonnet`, network Allowlist, workspace slot
declared) placed on that machine. A group is realized remotely only when its
placement names a connected, approved machine and the machine's user is admitted
to the group.

## Transit

The fleet driver (`src/drivers/fleet-driver.ts`, `NANOCLAW_RUNTIME_DRIVER=fleet`)
keeps local groups on Docker and rewrites placed ones for transit
(`src/drivers/remote-spec.ts`):

- **Bundles** — content-addressed gz-JSON of the mounts central owns (session
  state, group files, agent-runner source, build context); only missing ones
  are shipped (`have` → `bundle` → `prepare`).
- **Slots** — mounts the machine must supply (`/workspace/project`), bound to a
  folder the developer allows (`nanoclaw.slots`, `nanoclaw.workspaceMount`,
  `nanoclaw.mountAllowlist`); secret-like paths hidden (`nanoclaw.workspaceExcludes`).
- **Propose mode** (default) — the slot is a git clone of the developer's repo
  on branch `nanoclaw/proposal`; the agent edits the copy, the developer
  reviews and applies. **Direct** binds the working tree.
- **Image** — policy from central (`webchat_settings.runner_image_policy`):
  unset = **build** on each machine; `pull` = a published image (verified
  against the agent-runner lock label); `machine` = each laptop's setting.
- **Adoption** — `prepare` of an existing container with the same proxy,
  network and mount sources adopts it; anything else is recreated.
- Windows: bundle paths map `: < > " | ? *` to U+F000+c (WSL drvfs), so names
  like `inbox/<uuid>:<group>` survive.

## Relay

The container's `HTTP(S)_PROXY` is `http://127.0.0.1:18080` — a forwarder
daemon inside the container (`vscode-extension/src/relay.ts`, version 4),
attached over `podman|docker exec`. Streams go container → daemon → exec pipe →
extension → socket → central (`src/channels/webchat/runner-relay.ts`), which:

- refuses a stream for a session not placed on that machine (audit
  `runner.relay.refused`);
- routes central's own services (MCP relay, mailbox endpoint) directly;
- checks the destination against the group's network policy
  (`src/channels/webchat/egress-policy.ts`); a refusal closes the stream with a
  reason the daemon returns as `403` to the client;
- otherwise terminates at the OneCLI gateway **as the agent** (credential only
  on central).

The exec pipe drops routinely (Podman); the daemon keeps tunnels, sequences
and acks frames, and replays on re-attach (90 s grace).

## Mailbox

The container syncs its own mailbox with central over the relay
(`container/agent-runner/src/mailbox/relay-sync.ts` ↔
`src/channels/webchat/runner-mailbox-endpoint.ts`, loopback port
`WEBCHAT_RUNNER_MAILBOX_PORT`, default 3103). One token per session
(`NANOCLAW_MAILBOX_TOKEN` in the spec), revoked when the session ends.

| Operation | Carries |
| --- | --- |
| `GET /mailbox/inbound?after=` | messages central holds for the agent |
| `POST /mailbox/outbound` | the agent's answers |
| `GET /mailbox/file?path=inbox/<id>/<f>` | attachments, fetched before the row is inserted |
| `PUT /mailbox/file?path=outbox/<id>/<f>` | files the agent sends, uploaded before the row |
| `POST /mailbox/status` | `status_events` (the thinking bubble / working line) |
| `POST /mailbox/acks` | terminal `processing_ack` rows, so central stops counting handled messages as due |

In-progress acks are not carried (central's stuck-claim rule reads them).

## Sleep and resume

A session whose runner disconnects, or reports its runtime unreachable
(`{type:'runtime', reachable}` frame), is **held**: central keeps its mirrored
heartbeat fresh so neither the idle ceiling nor the stuck-claim rule reaps it,
and ignores the laptop's stale mirror. Hold limit 12 h
(`NANOCLAW_RUNNER_SUSPEND_HOLD_MS`); past it the ordinary ceiling applies.

On return central re-asserts (`start {resume:true}`), retrying with backoff
while the runtime is still down. A resume attaches to a running container and
never revives a stopped one (it is removed; the session respawns). Stops issued
while the machine was away are queued and delivered on return.

The extension treats a missing token after a first connect as transient (wake
before network) and reconnects on window focus.

## Central restarts

`data/runner-sessions.json` (`src/channels/webchat/runner-sessions-store.ts`,
0600) keeps per placed session: key, machine, container name, mailbox token,
hold start; plus queued stops. On a runner reconnecting, remembered sessions
central does not supervise are woken through the ordinary spawn path
(`wakeContainer`); the spec carries the same token, so the runner adopts the
running container. Sessions no longer active, or past their hold, are stopped.
A deploy that changes agent-runner source or composed files still recreates the
container (mount sources change).

## Network

Runner agents follow the install policy (Open / Allowlist / Model only;
default Allowlist), enforced per connection by the relay — see
[security.md](./security.md#per-agent-group-egress).

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
  proposals and direct-mode changes.

## Updates

`npx tsx scripts/publish-runner-extension.ts <vsix>` (or Runners → Publish…)
writes `data/runner-extension/`; the welcome / keepalive offers it; the
extension downloads with its bearer, verifies sha256 and installs
(`nanoclaw.autoUpdate`: prompt | auto | off). `GET /api/runners/extension[/download]`.

## Testing

In `vscode-extension/`:

- `npm run harness` — the real extension core against central's real transport,
  relay and mailbox modules, a real container, a fake gateway (needs central
  built, `staging/dist`).
- `npm run harness:editor` — inline review inside a real VS Code
  (`@vscode/test-electron`), run in the agent image against a host Xvfb.
