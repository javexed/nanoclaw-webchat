# NanoClaw webchat — security additions

Fork-specific security behavior, kept out of the upstream [docs/SECURITY.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/SECURITY.md)
so that file stays a clean mirror of `nanocoai/nanoclaw`. Everything here layers
on top of the upstream model — read that first; this documents only what the
webchat fork adds or changes.

## Per-agent-group egress

Replaces upstream **§5 Egress Lockdown (Forced Proxy)**. One policy for every
agent (`src/channels/webchat/egress-policy.ts`), stored in
`container_configs.egress`:

| Mode | UI | Reaches |
| --- | --- | --- |
| `open` | Open | Anything. Stored as `'open'` — must be chosen. |
| `host-only` | **Allowlist** | The model, central's own services, the install allowlist, and the agent's own hosts. **Default: an unset (NULL) mode means this.** |
| `none` | Model only | The model and central's own services. |

An agent's own hosts (`webchat_agent_egress_hosts`, one JSON array per agent;
agent panel → Network → Also allowed) widen that one agent only, and
only in Allowlist mode. The install allowlist is owner / global admin; an
agent's own hosts follow the agent's admin privilege, like its mode. Both are
re-read within 15 s by the relay and the filter, so a change needs no restart;
each change is audited (`egress.allowlist.set`, `agent.egress.hosts.set`).

The model is always allowed: `api.anthropic.com`, plus the host of the agent's
effective model when it has an endpoint (Ollama, LiteLLM, any OpenAI-compatible
server) — so "Model only" really reaches the model. Adding a model does not
touch the install allowlist: each agent reaches its own model's host and no
other. A model on the host itself (`localhost` / `host.docker.internal`) is dialled
directly by the container, not through the proxy, so the egress filter listens
on that port too and forwards to the host — per connection, held to the
caller's policy (its own model, the allowlist, or Open); a port no model uses
any more is closed at the next spawn. A model on another machine (a LAN GPU
box, plain HTTP) is out of reach of the lockdown network altogether, so the
filter relays it the same way: one port per model host (47100-47899, from a
hash of host:port), forwarding to that host, admitting the agents whose model
it is (and, on Allowlist, a listed host). A filtered agent's model URL names
that port; an Open agent dials the model directly. Central's own services
(the MCP relay) are routed before the check.

**Groups that existed before this policy keep open egress.** An unset mode
used to mean open; migration `webchat-egress-existing-open` stamps `'open'`
on every group present at upgrade time (creating a config row where none
was). Only groups created afterwards start on the allowlist. Change a group's
mode in its agent panel. (An install that ran an earlier build of this
migration, which skipped the stamping where `webchat-runner-egress` had been
applied at an earlier boot, may have groups on Allowlist that were Open:
those are set by hand.)

A model endpoint that is neither on the host nor a public hostname (say an
Ollama box on the LAN) is still dialled directly by the container (`NO_PROXY`),
which the lockdown network cannot route: such a group needs Open, or the
model in front of a host-local proxy. This predates the allowlist.

**Why here:** the OneCLI gateway forwards to any host, and its own rules can
only block or rate-limit, so an allowlist has to be enforced in NanoClaw.

**Limit:** a filtered agent reaches the host at the lockdown bridge address,
where the filter listens. Any other host service bound to `0.0.0.0` (a model
server, SSH, the webchat server) is reachable there too, around the allowlist.
Bind host services to `127.0.0.1`, or firewall the bridge address down to the
filter's ports.

**Enforcement:**

- Both filtered modes run on the lockdown network (or, with the exec relay,
  no network at all) behind central's egress filter
  (`src/channels/webchat/egress-filter.ts`). Switching between Allowlist and
  Model only applies at once; moving to or from Open changes the container's
  network and applies at the next start.
- Refusals: `403` naming the host (the agent can report it), audit
  `runner.egress.blocked`, and Manage → Network → Recently blocked.
- Fail-closed: an agent that cannot be put behind the filter starts with
  `--network none`.
- Model ports, host-local or relayed to another machine, are checked per caller
  on both paths: an agent reaches its own model, or a model host its mode
  allows. Under the exec relay only the MCP relay is passed straight through
  (it checks a per-agent token on every request).
- An Ollama server, admitted, still serves an agent inference only
  (`ollama-filter.ts`): chat, generate, embeddings and their OpenAI- and
  Anthropic-compatible forms, plus read-only lookups (tags, ps, show, version,
  models). Pull, delete, create, copy and push get a 403: Ollama has no
  authentication, and an agent could otherwise fill the disk or remove the
  models others use. Every request on a kept-alive connection is checked.

**The lockdown network:** a Docker `--internal` network
(`nanoclaw-egress-<install slug>`, one per install) with no route out. The
OneCLI gateway is kept off it. The container's `host.docker.internal` is the
network's bridge address, where the filter listens on the gateway port from
the proxy URL. The filter identifies the caller by source address (container
→ session → agent group), applies the group's mode, and forwards what it
allows to the gateway with the container's own proxy credential, so OneCLI's
injection, approvals and rules still apply. The host-sweep re-ensures the
network each tick. Identifying callers by source address relies on the
container hardening (no `NET_RAW` / `NET_ADMIN`, so an agent cannot spoof
another's address), which every agent container gets; there is no switch to
turn it off.

**Which gateway (upstream 2.4.0+):** the credential gateway is a skill now
(`/add-onecli`, `/add-iron-proxy`), and each declares where agents reach it.
The filter follows that declaration: the gateway's container (if it is one) is
the one kept off the network, and the endpoint name in the agent's proxy URL is
what is pointed at the bridge.

| Gateway | Behind the filter |
| --- | --- |
| OneCLI (container, `host.docker.internal`) | Yes. The filter forwards to it on the host (`ONECLI_URL`'s address, else loopback). |
| A gateway on the host | Yes, on loopback. |
| iron-proxy (container, reached as `iron-proxy`) | Not yet: central cannot reach that name from the host, so a filtered agent's requests get `502`. Use Open for its groups until the filter learns its published port. |
| A gateway inside the session (sidecar) | No: upstream's driver hands such sessions their own network before any per-group policy is consulted. An agent the egress filter would hold is therefore refused at spawn as `denied-by-policy` (`patches/product/src__drivers__index.ts.patch`), and so is one whose mode cannot be determined; only Open starts, and under `NANOCLAW_EGRESS_LOCKDOWN` not even Open. No shipped gateway is a sidecar today. |

**Known limitation (to do): sidecar gateways.** Refusing is the fail-safe
choice while nothing uses one. When a sidecar gateway arrives, decide between
starting such agents with a logged warning and saying on Manage → Network that
the sidecar, not the allowlist, governs their egress — or feeding the
allowlist into the sidecar so the modes mean the same thing there.

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false` | `true` also puts Open groups on the lockdown network (their policy still allows any host). |
| `NANOCLAW_EGRESS_NETWORK` | `nanoclaw-egress-<install slug>` | Lockdown network name. |
| `NANOCLAW_EGRESS_EXTRA_DEFAULTS` | *(empty)* | Host patterns added to the built-in allowlist defaults. |
| `ONECLI_GATEWAY_CONTAINER` | `onecli` | Gateway container kept off the lockdown network. |

**Allowlist:** Manage → **Network** (owner / global admin; `GET`/`PUT
/api/egress`, audit `egress.allowlist.set`). One pattern per line: `host` or
`*.domain` (subdomains, not the apex), optional `:port` (else 443/80). Stored in
`webchat_settings.runner_egress_allowlist`; NULL = defaults. Built-in defaults:
npm, PyPI, NuGet, GitHub, `learn.microsoft.com`. An install adds its own
(organisation feeds) with `NANOCLAW_EGRESS_EXTRA_DEFAULTS` in `.env` — never in
the repo. Recently blocked offers one-click Allow.

**Direct tunnels:** an install-list entry with an explicit port other than
443/80 (`git.example.com:22`) is tunnelled by the filter itself, past the
gateway (which would read it as TLS). Never to this machine (loopback, any of
its own addresses, the docker bridge gateway `172.17.0.1` where host services
listen) or a link-local address. A private address (RFC 1918, the
100.64.0.0/10 shared space that carrier-grade NAT and Tailscale tailnets use,
IPv6 ULA) only when the entry is that address (`10.0.0.5:22`,
`100.96.1.2:22`): a name that resolves to one is refused, so a name whose
DNS someone else controls cannot reach into the LAN or other tailnet machines.

**Setting a mode:** agent panel → Network (Open / Allowlist / Model only; only
opening asks for confirmation; `PUT /api/agents/:id/egress` reports
`appliesNow`), or `ncl groups config update --egress open|host-only|none`.

**What a filtered agent cannot reach:** anything not listed; SSH, rsync and
other non-HTTP protocols to listed hosts; LAN services by address. A model
server on the host is reached only on its own port, passed straight through
by the filter (see Limit above for other host services).

**Not covered:** Claude Code's own telemetry (Datadog `http-intake.logs.*`) is
refused like any unlisted host; NanoClaw does not set Claude Code's opt-out
variables.

## Credential isolation (secret modes)

Distinct from egress, and easy to confuse with it: egress is what an agent can
**reach**; this is which vault secrets it **receives**.

Every OneCLI agent has a `secretMode`:

| Mode | Meaning |
| --- | --- |
| `all` | receives EVERY vault secret whose host pattern matches the outbound request. No assignment needed. |
| `selective` | receives only secrets explicitly assigned to it. |

A freshly created agent defaults to **`all`** (verified against gateway 1.37 by
creating and deleting a probe agent). So on a fleet that was deliberately locked
down, the next new agent silently re-opens it — isolating by hand is a snapshot,
not a policy.

**Fleet isolation** makes it durable. A session-prepare hook runs on every spawn
and isolates the group if it is not already: `isolateGroup()` pins the model
credential first and **refuses** if there is none (`No model credential to pin —
connect a workspace default first, or isolation would 401`). Already-isolated
groups return early with no vault writes, and a vault failure logs a warning
rather than blocking the spawn.

Set it in **Admin → Access & credentials → Credential isolation**, which is read per
spawn — flipping it takes effect as agents next start, with no restart. The
setting is nullable on purpose:

| `webchat_settings.credential_isolation` | Meaning |
| --- | --- |
| `NULL` | follow `CREDENTIAL_ISOLATION` in `.env` (what installs had before the toggle existed) |
| `0` / `1` | an explicit choice in Admin, which wins |

**It turns on by itself** the first time a secret is saved for one agent or one
person (a scoped tool secret, or a member's own model key): every existing agent
is isolated then and there, and new ones at their first spawn. While any agent is
in `all` mode it would be offered that secret. The save is refused if an owner
chose isolation off, or if an existing agent can't be isolated (the message names
it). With isolation on, a single agent can't be switched back to `all`.

"Never chosen" and "chosen off" must stay distinguishable, or an install that
set the env var would lose it the first time the settings row was written for
any other reason.

Two agents must stay in `all` mode and are out of scope by construction — the
hook only ever receives an `agentGroupId`:

- `default` — the fallback identity.
- `webchat-drafter` — not a per-group agent, so nothing assigns it a secret;
  `selective` would leave it with none. An orphan scan keyed on "identifier not
  in `agent_groups`" WILL flag it. It is live. Do not delete it.

**Operational consequence.** On an isolated fleet a NEW vault secret reaches
nobody until it is assigned. The symptom of forgetting is a `401` from an API
whose credential *is* in the vault — an auth error that reads like a model or
config problem.

> `onecli agents list` silently returns only the first **20** rows. Always pass
> `--max 500` for any audit; a truncated list has already produced one
> confidently wrong inventory.

## What the UI calls the scopes

The panels name a secret by who it **reaches**, and a person's turns use the
nearest scope per host:

| UI words | Scope | Who sends it |
| --- | --- | --- |
| **Only you** | `user` | that person's own turns on that agent |
| **Everyone on this agent** | `agent` | every member's turns on that agent |
| **All agents** | `workspace` | every agent |

The agent panel groups its list by those three (plus "Other people
(read-only)", so an admin can see who holds a key without being offered an
action the server refuses), and opens with a "For you:" line that
states, per host, which of the three the viewer's turns actually send — computed
server-side from the same precedence the reconcile writes. Admin and Settings
keep the same words: **Secrets for all agents** is the workspace scope, **Secrets only
you use** is the user scope, per agent.

## Who may manage credentials

Authorisation follows the **scope**, not one blanket rule. Per-group actions use
`hasAdminPrivilege(userId, agentGroupId)`, matching the rest of the per-group
surface — gating them on owner-only locked scoped admins out of the very agents
they administer.

| Scope | Who may act |
| --- | --- |
| workspace | owner / global admin — it is install-wide |
| agent | whoever administers THAT agent, scoped admins included |
| user (self) | anyone, for an agent they use (`canAccessAgentGroup`) |
| user (someone else) | **nobody, at any privilege level** |

The last row is deliberate and is a tightening: an owner could previously manage
another person's personal credential. A personal credential must be entered by
its owner — an admin doing it on their behalf would have to handle that person's
token, which is precisely what per-user credentials exist to prevent.

### Personal secrets without a Claude credential of one's own

An **Only you** secret needs the person's own OneCLI identity: on the agent's
shared identity it would reach everyone. Connecting a model credential creates
that identity; so does a first personal secret, for someone who has connected
none. Their identity then holds the **workspace** model credential (the one the
shared session runs on), the agent's tool secrets and their own. It is recorded
as an enrollment holding no key of theirs, and it changes where their turns run:

- they get their own session (and container), since a shared session serves the
  whole room and has no "you" to send a personal secret for;
- in every room, **User credentials: Off** included: that setting is about who
  pays for the model, not about personal secrets;
- except a **Required** room, which still turns away anyone without a model
  credential of their own;
- removing their last personal secret puts them back on the shared session;
  connecting their own key moves the identity onto it, and disconnecting it
  later returns them to the workspace credential, personal secrets kept.

Saving a personal secret isolates the fleet first (`ensureFleetIsolation`), as
any per-agent or per-person secret does: an agent left in `all` mode would be
offered it too. Without a workspace credential for the agent's provider there is
nothing for their identity to run on, and the save is refused.

This covers `/api/tool-secrets`, `/api/tool-secrets/isolation` and
`/api/deploy-keys`. The isolation toggle is included because it is the same
feature: per-agent secrets do nothing until the agent is `selective`, so fixing
only the secrets endpoints would leave a scoped admin able to assign secrets but
unable to make them take effect.

On that endpoint CSRF is checked **before** the group-existence lookup, so a
cross-site POST cannot use the `400` vs `403` split to enumerate agent-group ids.

## How a tool credential goes on the wire

A generic vault secret is `<header>: <template containing {value}>`. The header
is inferred from the host — `Authorization: Bearer` for almost everything, with
`dev.azure.com` (Basic, base64 `":<pat>"`) and `gitlab.com` (`PRIVATE-TOKEN`) as
the known exceptions.

Inference cannot work for a self-hosted API, whose host is a LAN address that
says nothing about which service answers there. The default would silently send
`Bearer` to a service that ignores it — storing a credential that looks correct
and never works. So the operator may state the pair instead
(`{headerName, valueFormat}`), validated server-side:

- header name must be an RFC 7230 token, max 64 chars
- request-control headers are refused (`Host`, `Content-Length`,
  `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `Expect`,
  `Proxy-*`) — a credential may authenticate a request, not retarget it
- the template must contain `{value}` **exactly once**
- printable single-line ASCII, max 128 — CR/LF in a header value is request
  splitting, and the template is the one operator-supplied string that reaches
  a header verbatim

For HTTP Basic (e.g. CalDAV with an app-specific password) the form's
**Username + password** type posts `{hostPattern, basic: {username, password}}`
instead of a value. The server encodes base64 of the UTF-8 `username:password`
and stores it as `Authorization: Basic {value}`, so nobody base64-encodes a
password by hand. The username must be non-empty, contain no `:` (RFC 7617) or
control characters, and both fields are capped at 256 characters. `basic` is
refused alongside `value` or `scheme`, errors never quote either field, and like
every tool secret it is write-only.

**Updating** a secret (`PUT /api/tool-secrets?…&id=`, the row's **Update**)
replaces its value, and its type when that changed, in place: the same vault
secret, so every assignment stands and no request goes out without a credential
in between. The body is the add body without `hostPattern` (the host is what
the credential is: another host is remove and add) and passes the same
validation; who may update follows the same scope rules as adding and removing,
and an id outside the scope is refused. The value still never comes back: the
form opens with the current type but an empty value.

Deliberately not a table of named services: every scheme is the same shape, so
per-service entries would add a release cycle to every integration and bake one
deployment's stack into the product.

**Not expressible today:** query-parameter auth (`?apikey=…`). `GenericSecretSpec`
carries `paramName`/`paramFormat` and `onecli-admin` forwards them, but the
installed CLI exposes only `--header-name` / `--value-format`.

## Host listeners

Three, and only one of them is meant for you:

| Port | Bound to | Who dials it |
| --- | --- | --- |
| `WEBCHAT_PORT` (3100) | `WEBCHAT_HOST`, default `127.0.0.1` | browsers; refuses a non-loopback bind until an auth method is configured |
| `WEBCHAT_SERVE_PORT` (main + 10000, 13100) | `127.0.0.1` | Tailscale Serve only |
| `WEBCHAT_MCP_RELAY_PORT` (3102) | the `docker0` bridge IP (e.g. `172.17.0.1`) | agent containers, via `host.docker.internal` |

The relay is the host-side hop that keeps MCP server credentials out of
containers — a remote server with stored auth is synced into container config
as a relay url plus a per-(agent group, server) token, and the real
`Authorization` header is injected here at forward time. It is the MCP
counterpart to what the OneCLI gateway does for model credentials, and exists
separately because it also refreshes OAuth tokens and scopes per (group,
server) rather than per host pattern.

Three properties worth knowing, because "a second listener" deserves them
written down:

- **It binds the bridge, not `0.0.0.0`.** The only legitimate clients are agent
  containers, which reach the host as `host.docker.internal` → the
  default-bridge gateway. Note this is still every container on that bridge,
  not only nanoclaw's — the relay token, which names one (group, server) pair
  and is useless elsewhere, is what gates access.
- **It refuses to bind when it cannot identify that interface.** No `docker0`
  and no `WEBCHAT_MCP_RELAY_HOST` (macOS Docker Desktop, custom networks) means
  the relay does not start and says so loudly; relay-backed MCP servers stay
  unreachable until an operator names the interface. Failing closed matches the
  rest of the credential path — the OneCLI gateway refuses to spawn without
  credentials, and egress lockdown throws rather than spawning open.
- **It only listens while it is used.** The relay binds when a server
  assignment first carries a relay token, and at boot only when one already
  does. An install with no authed remote MCP server never opens the port.

**Interaction with `host-only` egress:** the relay is reached at
`host.docker.internal`, which on the lockdown network is aliased to the OneCLI
gateway rather than the host — so relay-backed MCP servers are expected to be
unreachable for a group set to `host-only`, in the same way host-local LiteLLM
and Ollama are. Not measured; treat it as unreachable until it is.

### The Tailscale Serve listener

Serve forwards each tailnet visitor over loopback with their login in
`Tailscale-User-Login`. Being on loopback proves nothing about who sent that
header: a Cloudflare tunnel, a reverse proxy or any local process connects
from loopback too, and can set both the header and `Host`. So the header is
believed only on connections accepted by the Serve listener, which is bound to
`127.0.0.1` and which only Serve should be pointed at. On the main port it is
never believed, with one transitional exception: while Serve's own config
still proxies to the main port (an install set up before the listener), a
loopback request addressed to Serve's name is believed as before, and startup
warns with the `tailscale serve --bg --https=<port> <serve port>` command
that ends it. See [HTTPS over Tailscale](webchat.md#https-over-tailscale-and-the-serve-listener).

Two related rules:

- **The localhost owner is for a browser on this machine only.** With no
  sign-in method configured, a loopback request is the owner — unless it
  carries a forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`,
  `Cf-Connecting-IP`, `Cf-Ray`, `Tailscale-User-Login`, `X-Forwarded-Host`) or
  arrived on the Serve listener. A tunnel to a loopback-only install therefore
  reaches a login screen, not the owner's session; give it a sign-in method
  (the trusted proxy for Cloudflare Access, OIDC, or a token).
- **Tailnet lookups are remembered briefly.** `tailscale whois` answers are
  kept 30 seconds per peer address (a miss, 10), and the users-row write is
  skipped while nothing about the identity changed (re-written at least once a
  minute). A peer removed from the tailnet is refused within 30 seconds.

### OneCLI's own ports

OneCLI's compose file binds all three of its ports to one `ONECLI_BIND_HOST`,
and on Linux setup sets that to the bridge address so containers can reach the
gateway. Left there, the management API (no auth in a local install: `GET
/api/agents` answers anyone) and Postgres (the compose default password) are
in reach of every container on the host. Whoever can manage the vault can
re-point a secret at a host they control, and the gateway then delivers the
real key there.

Containers need only the gateway. With the add-onecli patch:

| Port | Bound to | Who dials it |
| --- | --- | --- |
| 10254 (API) | `127.0.0.1` | central, the `onecli` CLI, the operator's browser (`APP_URL`) |
| 10255 (gateway) | the bridge **and** `127.0.0.1` | agent containers; host-side callers (they derive its address from `ONECLI_URL`) |
| 5432 (Postgres) | not published | OneCLI's container only, on its compose network |

Fresh installs get this, and an update applies it to an existing install:
`install.sh` and `deploy/webchat-deploy.sh` both end by running
`deploy/onecli-private-ports.sh`, which runs the add-onecli migration
(`setup.ts --private-ports`): it rewrites `~/.onecli/docker-compose.yml`,
recreates the stack (only on a change), points the CLI's `api-host` and this
install's `ONECLI_URL` at loopback, and fails unless the API answers on
loopback and neither the API nor Postgres accepts a connection on the bridge
any more. Restart the service after an update so it picks up a moved
`ONECLI_URL` (`webchat-deploy.sh` restarts it itself).

The update skips the step, touching nothing, when there is no local OneCLI or
the install dials a remote one, and when another NanoClaw install on the host
(a systemd unit with another working directory) still dials the API on the
bridge: moving the API would cut that one off. It then prints the command to
run in each install directory before restarting each:

```bash
pnpm exec tsx .claude/skills/add-onecli/scripts/setup.ts --private-ports
```

A failed migration warns and leaves the update in place; run the same command
to retry. `NANOCLAW_SKIP_ONECLI_PRIVATE_PORTS=1` opts an update out.

Still open, and OneCLI's to fix: the gateway relays a request to any host its
container can resolve, its own API (`http://onecli:10254`) and Postgres
included. A filtered agent is stopped by the egress filter (only its allowed
hosts pass); an agent on Open egress is not. The Postgres password is still
the compose default: with no published port only containers on OneCLI's
network reach it, but rotating it (`ALTER USER`, then `POSTGRES_PASSWORD` in
`~/.onecli/.env` and `docker compose up -d`) is worth doing.

## Container hardening & resource limits

Supersedes upstream **§Resource Limits** for this fork. Every agent container
runs with a hardened baseline (the image runs as `node` under tini and never
escalates, so dropping everything costs nothing):

```
--cap-drop=ALL
--security-opt no-new-privileges
--init
--pids-limit 2048
```

No capabilities are added back. `--init` is not optional: the `--entrypoint bash`
override defeats the image's tini, leaving bun as PID 1 with no signal handler,
and Linux discards default-action signals to PID 1 — without docker-init every
stop ends in SIGKILL after the full grace period.

A running container inspects as `CapDrop=[ALL]`, `CapAdd=[]`,
`PidsLimit=2048`, `SecurityOpt=[no-new-privileges]`.

Note the honest limit, stated in `container-runner.ts`: `cap-drop` and
`no-new-privileges` are **inert** while containers run under the `--user`
mapping — the capability sets are already empty and the image carries no file
capabilities. They are depth against a root-in-container path, not the primary
control. The real boundary is the user mapping plus the mount set.

| Env | Default | Meaning |
| --- | --- | --- |
| `CONTAINER_PIDS_LIMIT` | `2048` | Fork bombs become a contained failure, not a host reboot. Blank or `0` removes the cap (cgroups v2 rejects `--pids-limit 0`, so it is omitted rather than passed). |
| `CONTAINER_MEMORY_LIMIT` | `8g` | **Hard memory cap by default** — a runaway agent has OOM-killed real installs; unbounded-by-default privileges the failure case. Set the literal `none` to restore unbounded. |
| `CONTAINER_CPU_LIMIT` | *(empty — unbounded)* | `--cpus` when set. CPU stays opt-in: contention degrades, it doesn't take the host down. |

On a swapless host `--memory` is a hard cap and a runaway is OOM-killed at the
limit.

## Runner releases

With the VS Code runner (`/add-vscode-runner`), central serves the extension
package to every paired laptop. HTTPS proves only that the bytes came from
central; a compromised central could ship its own. Releases are therefore
signed with an operator Ed25519 key kept off central
(`scripts/sign-runner-release.ts` in the overlay repo), and the extension
verifies against a key pinned per install origin before installing an update.
Central stores and serves signatures and checks uploads against the install's
release key, but cannot make one. The first pin (and any key change) is a modal
confirmation showing the fingerprint — trust on first use; declining it refuses
that install's releases; `nanoclaw.releaseSigningKey` pins out of band.
Details: [runners.md](./runners.md#signed-releases).

## Runner machine identity

A runner connection authenticates twice: as a person (Entra token, Tailscale
or trusted-proxy identity) and as a machine. The machine proves an Ed25519
key held in VS Code's secret storage by signing a fresh challenge bound to its
fingerprint and to the origin it dialled, checked against the addresses
central is configured with (never the request's own headers, which a relaying
server controls); the registry binds the key on first
sight and never replaces it (`webchat_runner_machines.public_key`, cleared by
revoke). A new machine without a key is refused, and so is one revoked and
approved again; machines paired before keys existed are admitted keyless and
audited until they bind one. Protocol and
cases: [runners.md](./runners.md#pairing-and-placement).

## Approval TTL

A pending approval that nobody answers **denies itself** after
`NANOCLAW_APPROVAL_TTL_HOURS` (default `24`, `0` disables). Expiry goes through
the same `finalizeReject` path a human deny uses: the agent is told, cards flip
on every surface, and the container wakes to see the outcome. Rationale: a stale
approval is its own hazard — a request finally tapped three days later executes
in a context nobody remembers.

## Credential redaction in surfaced errors

Error text that reaches chat rooms (provider failures, terminal errors,
unwrapped error results) passes through `redactSecrets()` in the agent-runner:
key shapes (`sk-…`, `ghp_…`, `aoc_…`, `mcr_…`), `Bearer` tokens, and
`key=`/`token=`/`password=` parameters become `[REDACTED]`. OneCLI means
containers rarely hold real secrets — this is the belt for the ones that exist
(MCP bearer tokens, relay tokens, operator-pasted keys).

## Audit log retention

Admin → Audit log → **Keep** (owner / global admin): 30 days, 90 days, 1 year
or Forever, plus a size cap in MB. `logs/audit.jsonl` (`src/audit.ts`;
`NANOCLAW_AUDIT_FILE` relocates it) rolls over daily (UTC) into
`audit-YYYY-MM-DD.jsonl.gz`. Day files older than Keep are deleted when the
log rolls over and once a day. Over the cap, the oldest days go early, even
under Forever, and a runaway day rolls early at a quarter of the cap
(`audit-YYYY-MM-DD.2.jsonl.gz` …), so the disk cannot fill. The page shows the
bytes on disk and the oldest day held.

Defaults: 90 days, 200 MB. `NANOCLAW_AUDIT_KEEP_DAYS` (0 = forever) and
`NANOCLAW_AUDIT_MAX_MB` in `.env` change the starting values, and the page
overrides them. A change is recorded as `audit.retention` (from, to) **before**
it applies, because shortening Keep deletes history. Forward to syslog for a
copy the install can't delete. Admin → Audit shows the live file; older days:
`zcat logs/audit-*.jsonl.gz | grep …`.
