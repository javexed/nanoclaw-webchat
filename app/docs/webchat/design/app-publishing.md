# Agent apps: workloads and publishing

Agents can run their own Docker Compose stacks ("workloads") on the NanoClaw
host and publish a web app from one of them. People open the app at its own
address, signed in by the route it is published on. NanoClaw never serves agent
code on its own origin.

## Principles

- **Every app is its own origin.** Isolation comes from the browser's origin
  model, not from a wrapper page or sandbox tricks. No `/apps/<name>/` path
  mode on NanoClaw's address.
- **An agent can only ask; a person can always narrow.** Creating, exposing,
  widening who can open, or changing route needs an approval card. Stopping,
  unpublishing and narrowing to "Only me" are direct GUI actions with no card.
- **Off by default.** Nothing here runs until the owner turns a route on in
  Admin → Publishing.
- **Credentials live in the gateway.** The Tailscale OAuth client and Cloudflare
  tokens are stored in OneCLI and never shown again.

## Routes

### Tailnet (Tailscale sidecar per app)

Each published app gets a `tailscale/tailscale` sidecar in userspace mode (no
TUN, no `NET_ADMIN`), joined as a tagged device (`tag:nanoclaw-app`) with a
single-use key NanoClaw mints from an OAuth client held by OneCLI. Sidecars sit
on a per-install edge bridge at fixed addresses — never host networking, where
userspace mode would forward unserved ports to the host's loopback — and
`serve` points at the gateway on that bridge's address. Host rules let the edge
bridge reach only that one address and port. The app is reachable at
`<app>.<tailnet>.ts.net` with its own certificate, only from the tailnet.
`serve` adds `Tailscale-User-Login`, believed only from the app's own sidecar
address; the gateway checks it against the app's "who can open" rule and
passes a signed identity to the app. Never Funnel.

### Cloudflare (Tunnel + Access)

One `cloudflared` connector publishes `*.<app domain>` to the gateway. The app
domain must be a different registrable domain from NanoClaw's own address.

- A catch-all Access application on `*.<app domain>` denies by default, so a
  new hostname is never public.
- NanoClaw creates **one Access application per app** through the API, with
  that app's "who can open" as its policy, and deletes it on unpublish. Each
  app's tokens carry its own audience; NanoClaw only accepts tokens for its own
  (`WEBCHAT_CF_ACCESS_AUD`), so an app cannot replay a visitor's token.
- The gateway also verifies the Access token for the app's audience before
  forwarding.

### Gateway (both routes)

Caddy routes by hostname to the app's fixed address on its workload network,
with `forward_auth` to NanoClaw for the "who can open" check. It listens only
where the sidecars and `cloudflared` reach it — never on a public interface —
and refuses to start when proxy trust is `auto`. Requests to apps are built
from an allow-list of headers: `Authorization`, NanoClaw's own cookies,
`Cf-Access-*`, `Tailscale-*`, `X-Ms-*` and any configured proxy header are
dropped; the app gets the signed `X-NanoClaw-*` identity only.

## Workload security requirements

These hold before the Apps tab ships.

- **Builds.** `build:` is refused unless builds are confined (rootless
  BuildKit in gVisor behind the agent's egress filter). Image-only stacks work
  without it. Builds run with an empty `DOCKER_CONFIG`, export to an OCI file,
  and load only under the expected name; protected image IDs (agent, helper,
  BuildKit) are verified unchanged. Helper, BuildKit, Caddy and sidecar images
  are pinned by digest.
- **Approval pinning.** The approved shape includes image digests (resolved at
  approval), Dockerfile text and build args. The Dockerfile is re-hashed inside
  the copied build context and compared right before the build.
- **Containers.** `cap_drop: [ALL]`, `no-new-privileges`, pids/memory/CPU
  limits, systemd slice ceiling, log rotation.
- **Networks.** Per-agent `--internal` /24 with fixed addresses, plus host
  DROP rules so workloads cannot reach host or bridge addresses.
- **Registries.** Build egress to registries is per-agent opt-in, not a global
  allow-list.
- **Disk.** Usage read from `docker inspect` JSON, not comma-split label
  strings.
- **Cards.** One line of agent reason, length-capped and quoted; every
  argument stays visible under Details.

## GUI

### Admin → Publishing (owner)

| Control | Kind |
|---|---|
| Tailnet | switch; Connect (OAuth client → OneCLI); status line |
| Cloudflare | switch; Connect (API token → OneCLI; NanoClaw creates the tunnel); app domain, account, zone, team domain; status line |

The status line says `Connected` or the one thing missing. Saving a
Cloudflare domain that shares NanoClaw's registrable domain is refused.

### Agent → Apps

One row per app: name, state (Running / Stopped / Needs approval), route
(Off / Tailnet / Cloudflare — only routes on in Admin), who can open (Only me /
Agent members / Anyone signed in; Cloudflare adds Specific people…), Open ↗,
and a ⋯ menu (Start/Stop, Logs, Restore backup…, Delete). Disk use in the
header. No Compose or build editing — that is the agent's job via
`ncl workloads`.

### In the room

Requests arrive as approval cards ("Publish notes on your tailnet for agent
members?"); when live, the agent posts the link.

## Phases

1. Workloads core with the security requirements above (image-only; confined
   builds behind a flag).
2. Gateway with hostname routing and `forward_auth`.
3. Tailnet route (sidecars).
4. Cloudflare route (Tunnel, per-app Access applications).
5. GUI: Admin → Publishing, Agent → Apps.
