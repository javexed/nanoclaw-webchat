# NanoClaw webchat — security additions

Fork-specific security behavior, kept out of the upstream [docs/SECURITY.md](../SECURITY.md)
so that file stays a clean mirror of `nanocoai/nanoclaw`. Everything here layers
on top of the upstream model — read that first; this documents only what the
webchat fork adds or changes.

## Per-agent-group egress

Extends upstream **§5 Egress Lockdown (Forced Proxy)** with a per-group control:
`container_configs.egress`.

Settable two ways:

- **Agent panel → Network** — `Open` or `Locked down`. Locking down confirms
  first; unlocking does not, because restoring reachability cannot break
  anything.
- **`ncl groups config update --egress open|host-only|none`** — the only way to
  set `none`.

| Mode | Meaning |
| --- | --- |
| `open` (default / NULL) | Full egress via the host gateway. |
| `host-only` | THIS group joins the lockdown network regardless of the install-wide flag: an internal Docker network with the OneCLI gateway attached and aliased `host.docker.internal`, so the credential proxy is the only hop out. |
| `none` | `--network none` — no network at all. Not offered in the UI: the agent cannot reach any model API (Anthropic, or a LiteLLM/Ollama on this host), so it cannot run. `ncl` only. |

Most restrictive wins; `host-only` reuses the exact lockdown machinery (same
network, same gateway aliasing, same fail-fast contract) as the install-wide
`NANOCLAW_EGRESS_LOCKDOWN` flag.

**Verified under `host-only`** (2026-07-30, first end-to-end exercise of this
path): the agent answers normally — the gateway forwards arbitrary HTTPS, not
just hosts holding a matching secret — and `agent-browser` works, i.e. Chromium
honours the injected proxy.

**What stops working**, and it stops at the next spawn rather than at the moment
you change the setting, so it presents as a broken agent rather than as a config
change:

- SSH, rsync, and anything else that is not HTTP
- services on the LAN reached by address
- a model server on the host — `host.docker.internal` resolves to the *gateway*
  on this network, not to the host, so an agent pointed at a host-local LiteLLM
  or Ollama does not reach it

> An earlier version of this table claimed host services (LiteLLM, the MCP relay)
> stay reachable under `host-only`. That is not established: the network is
> `--internal` with only the gateway attached, and the alias points at the
> gateway. Treat any host-local dependency as unreachable until measured.

Until 2026-07-30 this control did nothing at all: `configFromDb` mapped every
other scalar but not `egress`, so the spawn path always read `undefined` and
fell through to open egress. The column, the CLI flag and the container-runner
branch all existed, which is why it looked configured from every angle an
operator could see.

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

Set it in **Settings → Features → Credential isolation**, which is read per
spawn — flipping it takes effect as agents next start, with no restart. The
setting is nullable on purpose:

| `webchat_settings.credential_isolation` | Meaning |
| --- | --- |
| `NULL` | follow `CREDENTIAL_ISOLATION` in `.env` (what installs had before the toggle existed) |
| `0` / `1` | an explicit choice in Settings, which wins |

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
| `NANOCLAW_CONTAINER_NO_HARDEN` | *(unset)* | `1` disables the baseline — an escape hatch for a workload a dropped capability genuinely breaks. Report it; don't live there. |
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
