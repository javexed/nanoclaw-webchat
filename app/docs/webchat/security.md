# NanoClaw webchat — security additions

Fork-specific security behavior, kept out of the upstream [docs/SECURITY.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/SECURITY.md)
so that file stays a clean mirror of `nanocoai/nanoclaw`. Everything here layers
on top of the upstream model — read that first; this documents only what the
webchat fork adds or changes.

## Per-agent-group egress

Replaces upstream **§5 Egress Lockdown (Forced Proxy)**. One policy for every
agent, local or runner (`src/channels/webchat/egress-policy.ts`), stored in
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
directly by the container, not through the proxy, so the egress filter passes
that port straight through to the host. Central's own services (MCP relay,
runner mailbox) are routed before the check.

**Groups that existed before this policy keep open egress.** An unset mode
used to mean open; migration `webchat-egress-existing-open` stamps `'open'`
on every group present at upgrade time (creating a config row where none
was). Only groups created afterwards start on the allowlist. Change a group's
mode in its agent panel.

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

- **Runner agents** — central's relay checks every relayed destination
  (`src/channels/webchat/runner-relay.ts`). A change applies within seconds.
- **Local agents** — both filtered modes run on the lockdown network behind
  central's egress filter (`src/channels/webchat/egress-filter.ts`). Switching
  between Allowlist and Model only applies at once; moving to or from Open
  changes the container's network and applies at the next start.
- Refusals: `403` naming the host (the agent can report it), audit
  `runner.egress.blocked`, and Manage → Network → Recently blocked.
- Fail-closed: an agent that cannot be put behind the filter starts with
  `--network none`.

**The lockdown network:** a Docker `--internal` network
(`nanoclaw-egress-<install slug>`, one per install) with no route out. The
OneCLI gateway is kept off it. The container's `host.docker.internal` is the
network's bridge address, where the filter listens on the gateway port from
the proxy URL. The filter identifies the caller by source address (container
→ session → agent group), applies the group's mode, and forwards what it
allows to the gateway with the container's own proxy credential, so OneCLI's
injection, approvals and rules still apply. The host-sweep re-ensures the
network each tick.

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
| A gateway inside the session (sidecar) | No: upstream's driver hands such sessions their own network before any per-group policy is consulted. The sidecar confines the session; the allowlist does not apply. |

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
| user (self) | anyone |
| user (someone else) | **nobody, at any privilege level** |

The last row is deliberate and is a tightening: an owner could previously manage
another person's personal credential. A personal credential must be entered by
its owner — an admin doing it on their behalf would have to handle that person's
token, which is precisely what per-user credentials exist to prevent.

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

Deliberately not a table of named services: every scheme is the same shape, so
per-service entries would add a release cycle to every integration and bake one
deployment's stack into the product.

**Not expressible today:** query-parameter auth (`?apikey=…`). `GenericSecretSpec`
carries `paramName`/`paramFormat` and `onecli-admin` forwards them, but the
installed CLI exposes only `--header-name` / `--value-format`.

## Host listeners

Two, and only one of them is meant for you:

| Port | Bound to | Who dials it |
| --- | --- | --- |
| `WEBCHAT_PORT` (3100) | `WEBCHAT_HOST`, default `127.0.0.1` | browsers; refuses a non-loopback bind until an auth method is configured |
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

Verified against a live container (2026-07-30): `CapDrop=[ALL]`, `CapAdd=[]`,
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
