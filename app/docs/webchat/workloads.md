# Agent workloads: operator setup

Agents can run their own Docker Compose stacks on the NanoClaw host with
`ncl workloads` (the `workloads` container skill tells them how). This page is
for the operator: what to set up on the host, the settings, what NanoClaw
enforces, and the gateway that publishes an app to people.

Workloads are **off** until all of the following hold. NanoClaw checks them at
startup and every half hour (the preflight) and refuses every verb that starts
something, with the reason, until they do.

1. `NANOCLAW_WORKLOADS=1` in `.env` (the Workloads switch in Admin → Publishing
   writes it, see 7).
2. The workload slice exists with a memory ceiling.
3. The host rules are in place (checked by trying, see below).
4. `docker compose` and `docker buildx` are installed.

## 1. The slice

Every workload container (and NanoClaw's helper and builder containers) runs
under one systemd slice, the ceiling for all of this install's workloads
together, whatever the agents' quotas add up to. The preflight error names the
slice it expects (`nanoclaw-wl-<install>.slice`, or `NANOCLAW_WORKLOAD_SLICE`).

```bash
sudo deploy/workloads-slice.sh --name nanoclaw-wl-<install>.slice --memory 8G --cpus 4
```

Docker creates a missing slice on its own, without limits; the preflight only
accepts one with `MemoryMax` set.

## 2. Host rules

Docker's `--internal` networks only drop traffic forwarded off the network.
Traffic addressed to the host itself is not filtered: from a workload
container, every service listening on the host (the credential gateway,
webchat, a model server, SSH) answers at the network's gateway address. The
host rules drop new connections arriving on a workload bridge (all named
`ncw…`) or from the workload range `198.18.0.0/15`, for IPv4 and IPv6; replies
to connections the host opened still pass, so NanoClaw and the agent's own
proxy reach the services.

```bash
sudo deploy/workloads-host-rules.sh --install-unit   # add now and at every boot
sudo deploy/workloads-host-rules.sh --check
sudo deploy/workloads-host-rules.sh --remove
```

`--install-unit` copies the script to `/usr/local/sbin` (root-owned) and
enables `nanoclaw-workloads-firewall.service`. The preflight does not read the
firewall: it starts a throwaway container on a probe network shaped like a
workload network (`198.19.255.0/24`) and asks a listener on the host's address
there. If it gets an answer, workloads are refused **and every running
workload is stopped** until the rules are back.

With runtime egress on (see [Runtime egress](#runtime-egress-optional)), add
`--stack-egress-port <port>` to every one of these commands, alongside any
`--gateway`: a re-run with fewer flags takes the missing rules out.

Worker machines get the same rules from their installer and run the same
check themselves; central places nothing on a worker whose check has not
passed recently. See [scaling.md](scaling.md).

## 3. Confined builds (optional)

Without them, `build:` is refused and only published images run. With
`NANOCLAW_WORKLOAD_CONFINED_BUILDS=1` (the Confined builds switch in Admin →
Publishing), each agent builds in its own rootless
BuildKit container inside gVisor, on the egress lockdown network behind the
agent's egress filter:

```bash
deploy/install-gvisor.sh      # adds the runsc runtime; Docker is reloaded, not restarted
```

A build:

- starts only from an approved Dockerfile and build args: the Dockerfile is
  hashed again inside the copied build context right before the build;
- reaches the agent's own allowlist plus the registries an owner opts the
  agent into — there is no install-wide registry list, since a registry a
  build can pull from is one it can push to:
  `ncl workloads build-registries --group <id> --hosts '["registry-1.docker.io","auth.docker.io","production.cloudflare.docker.com","production.cloudfront.docker.com"]'`,
  or a build source (Docker Hub, npm, OS packages, PyPI, GitHub images) in
  the agent's Apps (an approval card, see 7);
- runs with an empty Docker config (no registry logins reach it) and never
  through the credential gateway;
- hands back an image file, which a helper container repacks to hold one
  image tagged only with NanoClaw's name for it; after loading, NanoClaw
  checks that its own images (the agent image, helper, BuildKit) kept their
  IDs.

At most 20 builds an hour per agent run without a card (kept in the database).

## 4. Publishing: the app gateway (optional)

An agent publishes one of its services as an app with
`ncl workloads expose`, or deploys and publishes in one step with
`ncl workloads up --publish <route>` (one card for both). People open it at the app's own address — never at
NanoClaw's own origin — signed in by the publishing route the app is on:

- **tailnet** — a Tailscale sidecar per app, `<app>.<tailnet>.ts.net`;
- **cloudflare** — a Cloudflare Tunnel with one Access application per app;
- **port** — one port per app on this machine's own tailnet name,
  `<node>.<tailnet>.ts.net:9001`.

The routes themselves are set up separately (the tailnet in section 5,
Cloudflare in section 6, tailnet ports in section 7). Until one is
on, `expose` is refused with "no publishing route is on" (`up --publish`
with "the tailnet route is not on…", and the hint to deploy without
`--publish`), and nothing is published. Both routes reach the same gateway, set up here.

The gateway is a Caddy container (`nanoclaw-workload-gateway-<install>`, the
image pinned by digest) on the host network. It routes each app's hostname to
the app's fixed address on its agent's workload network, and asks NanoClaw
about every request first (`forward_auth` to a NanoClaw listener on
`127.0.0.1`, which requires a secret only Caddy has). Request and response
bodies stream through Caddy; NanoClaw only sees the headers of the check.

```bash
# .env
NANOCLAW_WORKLOAD_GATEWAY_PORT=8470          # turns it on
NANOCLAW_WORKLOAD_GATEWAY_BIND=127.0.0.1     # where the routes' edges reach it
```

It refuses to run, and says why in the log, when:

- the bind address is every interface (`0.0.0.0`, `::`) — it listens on one
  address, loopback unless you name the address your route's edge connects
  from;
- `WEBCHAT_TRUSTED_PROXY_IPS` is `auto` or `*` — with that, anything that
  reaches a local port can claim an identity to webchat; name the proxy's
  address instead.

**Who can open an app** is set on the card, per app:

| Rule | Who |
|---|---|
| `only-me` (default) | The person who approved the card (or exposed it), and owners |
| `specific` (Cloudflare only) | The people named with `--emails`, each signed in to NanoClaw with that address |
| `agent-members` | Whoever can use the agent: owners, admins, its members |
| `signed-in` | Anyone NanoClaw knows as a user |

Someone NanoClaw has no user for is never let in. The person's identity comes
only from the app's own route: on the tailnet, `Tailscale-User-Login` from that
app's own sidecar; on Cloudflare, the Access token verified for that app's own
Access audience; on a tailnet port, `Tailscale-User-Login` on the gateway's
loopback listener for that port. NanoClaw's own sign-in (cookies, bearer tokens, proxy
headers) plays no part, and the check never redirects.

**What an app receives.** Requests are rebuilt from an allow-list of headers
(content negotiation, caching, ranges, `Cookie`, `Origin`, `Referer`,
`User-Agent`, WebSocket and fetch-metadata headers). `Authorization`, the
`Cf-Access-*`, `Tailscale-*` and `X-Ms-*` headers, any proxy identity header,
and the client's `X-Forwarded-*` / `Forwarded` are dropped; NanoClaw's and the
edges' sign-in cookies are cut out of `Cookie`. Caddy sets `Host` and fresh
`X-Forwarded-For/-Host/-Proto`. The app gets who the person is as
`X-NanoClaw-User`, `X-NanoClaw-Name`, `X-NanoClaw-Auth` (the route) and
`X-NanoClaw-Identity`: an ES256 token with `aud` = the app's hostname, valid
two minutes, verifiable against `/.nanoclaw/jwks.json` on the app's own
address (on the port route, `aud` is `host:port`). Cookies an app sets lose
their `Domain` attribute, so an app cannot set cookies for its neighbours or
for NanoClaw, and a `Set-Cookie` for one of NanoClaw's own cookie names is
emptied.

**Approvals.** `expose` always needs an owner's card, which says where the app
will be, what serves it and who can open it; the route, rule and app name are
pinned to what the card showed (for `specific`, the addresses too). Exposing
again to widen who can open it (for `specific`, naming anyone new), or to move
it to another route, is another card. The approvals pre-judge never
approves it. `unexpose` is immediate. Apps of a stopped workload, or on a
route that is switched off, answer 404 at the gateway; a deleted workload's
apps are removed.

**Deploy and publish on one card.** `ncl workloads up --name <n> --file <f>
--reason <r> --publish tailnet|cloudflare [--who …] [--emails …] [--service …]
[--port …] [--app …]` asks once for both. The card says what runs (each image
by digest, Dockerfile hashes, the size) and where people will open it (the
address, the service and port, who can open it, and who could before). It pins
everything `up` pins and everything `expose` pins, plus the address itself.
The service defaults to the one service that declares an `expose:` port, and
the port to its first. The publish half is refused before any card on the
same grounds as `expose`, and when its route is off the refusal names the
switch in Admin → Publishing and says the agent can deploy without
`--publish`. On approve:

1. the publish is planned again (route on, gateway usable, app name free, the
   same address): if anything moved, nothing runs;
2. the stack is deployed, held to the pinned Compose hash, digests and
   Dockerfiles, as `up` always is;
3. the app is published through the same path as `expose`, with the pinned
   route, rule and name; the approver becomes its "only me".

The agent, and the card in the room, read one line:
`homeboard is running · open it at https://homeboard.<tailnet>.ts.net (only you)`.
The publish step waits for the route's edge as `expose` does (the tailnet
sidecar serving, the Cloudflare Access application and DNS record); when it is
not ready in time the line says so and `ncl workloads routes` gives the link
once it is live. A deploy that ran but could not be published reads as a
failure with the publish's cause; the workload keeps running.

`ncl workloads routes --group <id>` lists an agent's apps from the host.
The gateway's key and secret are under `data/workload-gateway/` (0600).

## 5. The tailnet route (optional)

Publishes apps on your tailnet at `https://<app>.<tailnet>.ts.net`, each with
its own certificate, reachable only from devices your tailnet policy lets in.
Never Funnel: NanoClaw refuses any serve config that would turn it on.

**How it works.** Every app published on the tailnet gets its own Tailscale
sidecar (`nanoclaw-tailnet-<install>-<app>`, `tailscale/tailscale` pinned by
digest), joined to the tailnet as a device named after the app and tagged
`tag:nanoclaw-app`. `tailscale serve` terminates HTTPS for the device's name
and forwards to the app gateway; for a person's device it adds
`Tailscale-User-Login`, which NanoClaw believes only on a request that comes
from that app's own sidecar address. Tagged devices send no identity, so they
are refused.

The sidecars live on an edge network of their own (`nc-tsedge-<install>`,
bridge `nct…`, `198.51.100.0/24` by default, containers cannot talk to each
other), each at a fixed address, and the gateway listens on the host's
address there. The Cloudflare connector (section 6) shares it. Not on the host network: in userspace mode tailscaled forwards
a tailnet connection to any port it does not serve to `127.0.0.1` on that
port, which on the host network would be every local service on this host.
Each sidecar runs in userspace mode (no TUN, no `NET_ADMIN`), with every
capability dropped, `no-new-privileges`, a read-only root, NanoClaw's own
user, its own state folder (`data/workload-tailnet/<route>/`) and socket, and
no metrics or health listener.

**Lifecycle.** On `expose` NanoClaw mints an auth key for the app (single use,
not ephemeral, preauthorized, tagged, valid ten minutes), hands it to the
sidecar as a `0600` file (`TS_AUTHKEY=file:…`, so `docker inspect` shows a
path), waits until the device is on the tailnet under the app's name and
serving, then deletes the file; the agent gets the link. If the tailnet
already has a device with that name (Tailscale would call the new one
`<app>-1`), NanoClaw removes the new device and says so. On `unexpose`, a
deleted workload, or the route switched off, it logs the device out, removes
the sidecar and its state, and removes the device from the tailnet through the
API (retried until the API answers). Every minute it starts missing sidecars
and removes ones without an app; anything else found on the edge network is
disconnected.

### Owner setup

1. **Tailnet:** MagicDNS and HTTPS certificates on (admin console → DNS). Note
   the tailnet DNS name (`tail1234.ts.net`).
2. **Tag:** in the tailnet policy file, declare the tag and who owns it:

   ```json
   "tagOwners": { "tag:nanoclaw-app": ["autogroup:admin"] }
   ```

3. **Access:** grant who may open apps, HTTPS only, and nothing for the apps
   themselves (the sidecars need no access to anything on the tailnet):

   ```json
   "grants": [
     { "src": ["autogroup:member"], "dst": ["tag:nanoclaw-app"], "ip": ["tcp:443"] }
   ]
   ```

   Narrow `src` to a group if not every member should reach them; NanoClaw
   still applies each app's "who can open" rule on top. Keep it to `tcp:443`.
4. **OAuth client** (admin console → Settings → Trust credentials → OAuth
   client): scopes **Auth Keys: write** and **Devices Core: write**, both with
   tag `tag:nanoclaw-app`. Store it in the OneCLI vault for NanoClaw's
   `nanoclaw-tailnet` identity, injected on the token request only:

   ```bash
   onecli agents create --name "NanoClaw tailnet publishing" --identifier nanoclaw-tailnet
   printf '%s:%s' "$CLIENT_ID" "$CLIENT_SECRET" | base64 -w0 > /tmp/ts-oauth && chmod 600 /tmp/ts-oauth
   onecli secrets create --name "NanoClaw tailnet OAuth client" --type generic --file /tmp/ts-oauth \
     --host-pattern api.tailscale.com --path-pattern /api/v2/oauth/token \
     --header-name Authorization --value-format 'Basic {value}'
   rm /tmp/ts-oauth
   onecli agents set-secret-mode --id <agent id> --mode selective
   onecli agents set-secrets --id <agent id> --secret-ids <secret id>
   ```

   (Connect in Admin → Publishing does the same, section 8.) NanoClaw never holds the
   secret: OneCLI adds it to NanoClaw's token request as HTTP Basic client
   authentication, NanoClaw keeps the hour-long access token in memory, and
   each sidecar only ever sees its own single-use key. OneCLI identities in
   `all` secret mode would be given this secret too; the status line warns
   about them.
5. **Host rules for the edge network**, as root, with the gateway's edge
   address and port:

   ```bash
   sudo deploy/workloads-host-rules.sh --gateway 198.51.100.1:8470 --install-unit
   ```

   From the edge network, only that address and port on this host answer;
   every other new connection to the host is dropped, and so is forwarding
   into the workload range, private and link-local ranges (the LAN, other
   Docker networks) and the tailnet's own range. NanoClaw checks by trying
   from a throwaway container, every half hour.
6. **Settings** (`.env`, then restart NanoClaw; or Admin → Publishing, which
   writes the same keys and applies them at once):

   ```bash
   NANOCLAW_WORKLOAD_TAILNET=1
   NANOCLAW_WORKLOAD_TAILNET_DOMAIN=tail1234.ts.net
   NANOCLAW_WORKLOAD_GATEWAY_BIND=198.51.100.1   # the edge network's host address
   ```

The route is on only when all of that holds. Its status reads `Connected` or
names the one thing missing (logged, and shown in Admin → Publishing).

## 6. The Cloudflare route (optional)

Publishes apps on the internet at `https://<app>.<app domain>`, behind
Cloudflare Access: nobody reaches an app unless Access lets them in first, and
NanoClaw's own "who can open" check still runs behind it.

**How it works.** One `cloudflared` connector (`nanoclaw-cloudflared-<install>`,
`cloudflare/cloudflared` pinned by digest) runs this install's tunnel
(`nanoclaw-<install>` in your account). It sits on the edge network from
section 5 at a fixed address (`.239`) and reaches only the gateway on the edge
address, under the same host rules. It runs with every capability dropped,
`no-new-privileges`, a read-only root, NanoClaw's own user, no autoupdate,
metrics on its own loopback only and remote diagnostics off.

The tunnel is *remotely managed*: its hostnames live in Cloudflare and NanoClaw
changes them through the API, so publishing or unpublishing an app never
restarts the connector or drops other apps' connections. Its token is fetched
through the API and written to `data/workload-cloudflare/connector/token`
(`0600`, in a `0700` folder), mounted read-only and passed as `--token-file`:
`docker inspect` shows a path, and the token is in no environment variable or
log. (A locally-managed tunnel would need its credentials file, the tunnel
secret itself, on disk all the same, plus a config file NanoClaw rewrites and
a connector restart on every change.)

**Access.** When the route is switched on, NanoClaw makes a catch-all Access
application on `*.<app domain>` that denies everyone, so a hostname without
its own application is never public. Each published app gets its own Access
application on `<app>.<app domain>`, whose policy is the app's "who can open"
in email addresses:

| Rule | Access policy allows |
|---|---|
| `only-me` | The email of the person who approved the card (the owners' while none is recorded) |
| `specific` | The addresses named on the app |
| `agent-members` | Every NanoClaw user with an email sign-in who can use the agent |
| `signed-in` | Every NanoClaw user with an email sign-in |

A rule that names nobody becomes "deny everyone". NanoClaw rewrites a policy
when the people it names change (members, roles, new users: checked every
minute) and at least hourly, so a change made in the dashboard does not stay.

Each application has its own audience (AUD). The gateway believes a
`Cf-Access-Jwt-Assertion` only from the connector's address, only for that
app's own audience, signed with the team's keys
(`https://<team>/cdn-cgi/access/certs`), with the team domain as issuer and
within its validity; its email names the NanoClaw user `webchat:<email>`, and
someone NanoClaw has no user for is refused. `cloudflared` checks the same
token for that audience before forwarding (`access.required` in the tunnel's
ingress). A token for another app, or for NanoClaw itself
(`WEBCHAT_CF_ACCESS_AUD`), is refused; were an app ever given NanoClaw's own
audience, the route stops.

**Lifecycle.** On `expose`: the app's Access application, then its DNS record
(a proxied `CNAME` to `<tunnel>.cfargotunnel.com`), then its hostname in the
tunnel's ingress — a hostname is never routed before Access guards it. On
`unexpose`, a deleted workload, or the route switched off: the reverse.
Deletes Cloudflare refuses are retried every minute and counted on the status
line. A hostname that already has a DNS record or Access application NanoClaw
did not make is refused, not taken over. Switched off, the connector stops
and its token file is deleted, and every app's records go; the tunnel and the
catch-all stay (they publish nothing).

### Owner setup

1. **App domain:** a zone in your Cloudflare account on a different registrable
   domain from NanoClaw's own address (`WEBCHAT_PUBLIC_URL`,
   `WEBCHAT_ALLOWED_HOSTS`, its tailnet name) — e.g. NanoClaw at
   `chat.example.com`, apps on `example.net`. NanoClaw refuses an app domain on
   the same site. Use the zone apex: Cloudflare's universal certificate covers
   one level below it. Note the account ID and zone ID (the zone's Overview).
2. **Zero Trust:** an identity provider in Access that gives people's email
   addresses — the same addresses they sign in to NanoClaw with. Note the team
   domain (`<team>.cloudflareaccess.com`).
3. **API token** (My Profile → API Tokens → Create custom token):
   - Account → **Access: Apps and Policies** → Edit
   - Account → **Cloudflare Tunnel** → Edit
   - Zone → **DNS** → Edit, for the app domain's zone only

   Store it in the OneCLI vault for NanoClaw's `nanoclaw-cloudflare`
   identity, injected on `api.cloudflare.com` only:

   ```bash
   onecli agents create --name "NanoClaw Cloudflare publishing" --identifier nanoclaw-cloudflare
   printf '%s' "$CF_API_TOKEN" > /tmp/cf-token && chmod 600 /tmp/cf-token
   onecli secrets create --name "NanoClaw Cloudflare API token" --type generic --file /tmp/cf-token \
     --host-pattern api.cloudflare.com --path-pattern '/client/v4/*' \
     --header-name Authorization --value-format 'Bearer {value}'
   rm /tmp/cf-token
   onecli agents set-secret-mode --id <agent id> --mode selective
   onecli agents set-secrets --id <agent id> --secret-ids <secret id>
   ```

   (Connect in Admin → Publishing does the same, section 8.) NanoClaw
   never holds the token. A OneCLI identity in `all` secret mode would be
   given it too, and with it could change who may open every app, so the
   route does not run while one exists; switch them to `selective`.
4. **Host rules for the edge network**, as in section 5 step 5 (once per host).
5. **Settings** (`.env`, then restart NanoClaw; or Admin → Publishing):

   ```bash
   NANOCLAW_WORKLOAD_CLOUDFLARE=1
   NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN=example.net
   NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID=<account id>
   NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID=<zone id>
   NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN=myteam.cloudflareaccess.com
   NANOCLAW_WORKLOAD_GATEWAY_BIND=198.51.100.1   # the edge network's host address
   ```

If NanoClaw itself sits behind Cloudflare Access, its own Access application
stays separate from the apps': keep `WEBCHAT_CF_ACCESS_AUD` set to its AUD.
The route is on only when all of the above holds; its status reads
`Connected` or names the one thing missing.

## 7. The tailnet ports route (optional)

Publishes each app on a port of this machine's own tailnet name:
`https://<node>.<tailnet>.ts.net:9001`. No Tailscale admin setup, no OAuth
client, no sidecars: the host's own Tailscale serves the ports, set up once
by the owner. Reachable only from devices your tailnet policy lets reach this
machine on those ports. Never Funnel.

**Why another port is enough.** A browser keeps a page's powers to its
origin (scheme, host and port), so an app's pages on `:9001` cannot read
NanoClaw's pages or call its API as NanoClaw's own page would. The browser
still counts another port as the same *site*: it sends NanoClaw's sign-in
cookie with requests from `:9001`, and Tailscale adds the visitor's identity
whatever page sent them. So NanoClaw refuses every request that can change
something (anything but `GET`, `HEAD`, `OPTIONS`) unless it comes from a page
on its own origin (`Sec-Fetch-Site` and `Origin`), and its WebSocket checks
`Origin` the same way. The gateway cuts NanoClaw's cookie from what an app
receives and empties an app's `Set-Cookie` for NanoClaw's cookie names.

**How it works.** `tailscale serve` on the host terminates HTTPS on each port
and forwards it to `http://127.0.0.1:<port>`, adding `Tailscale-User-Login`
for a person's device. The gateway (section 4) gives each published app a
listener of its own there, on loopback, and believes that header only from
loopback. NanoClaw never changes Tailscale's config: it reads `tailscale serve
status`, and hands each app a port that forwards whole (`/`) to its own
loopback listener, is not on Funnel, and is free. A port that serves anything
else is left alone and reported. An app keeps its port while it is published;
unpublishing gives it back, and a port given for a card nobody approved is
given back after a week (`data/workload-gateway/ports.json`).

**Shared cookies.** Apps on this route share one host name, and a browser
sends a cookie to every port of a name: app A's cookies reach app B. Their
pages are still kept apart (separate origins: storage, scripts, service
workers). Publish an app that must keep its cookies from other apps on the
tailnet route instead.

### Owner setup

1. **The app gateway** on loopback (section 4): `NANOCLAW_WORKLOAD_GATEWAY_PORT`
   set, `NANOCLAW_WORKLOAD_GATEWAY_BIND` left at `127.0.0.1` (or the edge
   address, when the tailnet or Cloudflare route is on too: the port
   listeners bind loopback either way). The ports must not include the
   gateway's own two.
2. **The ports on the tailnet**, once per host, as root (or Tailscale's
   operator):

   ```bash
   sudo bash deploy/workloads-tailnet-ports.sh --ports 9001-9010
   sudo bash deploy/workloads-tailnet-ports.sh --ports 9001-9010 --check    # exit 0 when all are set up
   sudo bash deploy/workloads-tailnet-ports.sh --ports 9001-9010 --remove   # take them out again
   ```

   It refuses a port that is on Funnel and leaves alone one that already
   serves something else.
3. **Access:** if your tailnet policy limits which ports people reach on this
   machine, allow `tcp:9001-9010` (or your range) for the people who open apps.
   NanoClaw still applies each app's "who can open" rule on top.
4. **Settings** (`.env`, or Admin → Publishing → Tailnet ports, which writes
   `9001-9010`):

   ```bash
   NANOCLAW_WORKLOAD_PORTS=9001-9010   # one port or a range, 1024–65535, at most 50
   ```

The route is on when at least one port is usable. Its status reads
`Connected`, or names the one thing missing; while some ports in the range are
not set up yet, Admin → Publishing shows the setup command for them.

`who: specific` is for the Cloudflare route only.

## 8. In webchat

### Admin → Publishing (owner)

First, **Workloads**: a switch (`NANOCLAW_WORKLOADS`) and the preflight's
result in a few words: `Ready`, `Checking…`, `Host rules missing`,
`Slice missing`, `Docker Compose missing`, … When something is missing on the
host, the line under it is the one command that fixes it, with this install's
path filled in, and a copy button (the page cannot run it: it needs root). The
full reason is in the status line's tooltip. Switching workloads on checks the
host at once, and a failed check is run again when the page is opened a minute
or more later, so the line turns `Ready` soon after the command was run.
Switching them off asks first: published apps stop opening, and agents cannot
start apps (running stacks are left alone).

While workloads are on, **Confined builds** (`NANOCLAW_WORKLOAD_CONFINED_BUILDS`):
a switch and `Ready`, or `gVisor missing` with `deploy/install-gvisor.sh` as
the command.

Then one block per route: a switch, its settings while it is on, **Connect**, and
a status line that reads `Connected`, `Not connected`, or the one thing missing
in a few words (the same check as `tailnetStatus()` / `cloudflareStatus()` /
`portStatus()`, with any warnings under it). **Tailnet ports** has no settings
or credential: a switch (on writes `NANOCLAW_WORKLOAD_PORTS=9001-9010` unless a
range is set), its status line and, while ports are missing on the tailnet,
`deploy/workloads-tailnet-ports.sh` with this install's path and the range,
and a copy button. Above them, one line says when the app gateway
is not running (section 4).

- **The switches and fields are the `.env` keys** of sections 5 and 6 (and
  the Workloads and Confined builds switches are those of sections 1–3):
  turning a route on writes `NANOCLAW_WORKLOAD_TAILNET=1` (or `…_CLOUDFLARE=1`)
  to `.env` and to the running process, the way Admin → Sign-in writes its
  keys, so the page, a hand edit and a restart all see one value. There is no
  separate switch in the database. Turning a route off removes the key; its
  apps stop opening at the next sweep. A value set in the service's own
  environment still wins at the next start, as it does for every setting
  here.
- **Fields:** the tailnet's DNS name; for Cloudflare the app domain, team
  domain, account ID and zone ID. An app domain on the same registrable domain
  as NanoClaw's own address (its public URL, allowed hosts or tailnet names)
  is refused under the field, with the reason.
- **Connect** takes the Tailscale OAuth client (ID and secret) or the
  Cloudflare API token and hands it straight to the OneCLI vault, set up as in
  sections 5 and 6 (the identity, `selective` mode, the host and path it is
  injected on). NanoClaw never stores it, the page clears it after sending,
  and no answer or error carries it back.

Owner only: the endpoints (`GET /api/publishing`, `PUT /api/publishing/{workloads,tailnet,cloudflare,ports}`,
`POST /api/publishing/{tailnet,cloudflare}/connect`) refuse everyone else, and
writes carry the CSRF header. Every change is in the audit log.

### Agent → Apps (the agent's admins)

An accordion in the agent's details, for the people who administer that agent
(owners, global admins, its scoped admins). It is hidden for members and
everyone else, like the agent's Secrets, and on a host where workloads are off
and the agent has none.

One row per app — or per workload that is not published yet: the name, its
state (Running, Stopped, or Needs approval while a card for it waits, the
agent's or a person's), the route (Off, or a route that is on), who can open it
(Only me, Agent members, Anyone signed in; on Cloudflare also Specific
people…), Open ↗ while it is live, its expiry (`Expires 1 Dec`; a warning
three days before, `Expired …` once stopped; a published app reads
`Renews while used` until those last three days), and a ⋯ menu: Start or Stop,
Redeploy, Extend, Logs, Restore backup…, Delete…. The header shows the agent's
disk use against its quota. There is no Compose or build editing here: that is
the agent's job. While workloads are off on the host, a line says so and
where an owner turns them on.

Above the list, while confined builds are on: **Build sources**, one switch
per package source, each over its hosts in the agent's build registries (the
same list `ncl workloads build-registries` sets):

| Source | Hosts |
|---|---|
| Docker Hub | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`, `production.cloudfront.docker.com` |
| npm | `registry.npmjs.org` |
| OS packages | `dl-cdn.alpinelinux.org`, `deb.debian.org`, `security.debian.org`, `archive.ubuntu.com`, `security.ubuntu.com`, `ports.ubuntu.com` |
| PyPI | `pypi.org`, `files.pythonhosted.org` |
| GitHub images | `ghcr.io`, `pkg-containers.githubusercontent.com` |

A switch shows on when all its hosts are in the list. While builds are off, a
line says so instead. The Docker Hub row's element id,
`agent-apps-docker-hub`, is stable for a link to it; the others are
`agent-apps-source-<id>` (`npm`, `os`, `pypi`, `ghcr`).

**A person can always narrow; widening is a card.** A change is compared with
the app as it is now:

| Change | What happens |
|---|---|
| Route to Off (unpublish) | Applied at once (after a confirm: publishing again needs a card) |
| A narrower "who can open", fewer named people | Applied at once |
| Off to a route, one route to the other | An approval card |
| A wider "who can open", anyone named who was not | An approval card |
| A build source: on | An approval card (a registry a build pulls from is one it can send to) |
| A build source: off | Applied at once (it removes that source's hosts from the agent's build registries) |

The card goes to the owners and global admins, **whoever asks, owners
included**: the card is the confirmation and the record, the same for
everyone, and an owner who asked can approve it at once. It names the app, the
route, the address, what serves it and who could open it (and before). What it
showed is pinned: on approve the change is planned again and refused if
anything moved, or if the person who asked no longer administers the agent;
the approvals pre-judge never approves it. The person who asked becomes the
app's "only me". Narrowing to Only me keeps whoever "only me" already meant,
so narrowing can never let a new person in.

Publishing a workload that has no app yet needs NanoClaw to know what to
serve: a service with an address that declares an `expose:` port. With more
than one, the row offers a service select; with none, the route stays Off
here (an ⓘ says why) and the agent publishes it with `ncl workloads expose`.

Each row change applies on its own; there is no Save for the list. A refused
change leaves the row on what is live and says why on that row. Status lines
in Admin → Publishing are a few words (`Connected`, `Not connected`,
`Host rules missing`, …); the full reason, with the setting or command that
fixes it, is in the line's tooltip and the log.

Start, Stop, Redeploy, Extend, Restore and Delete are a person's own actions
on the agent's workloads and apply directly (Restore and Delete after a
confirm): an agent asks for a restore, delete or extend with a card, a person
who administers it does not need one.

- **Redeploy** runs the stack on record again: the approved images by digest,
  and builds rebuilt from the agent's current folder, held to the approved
  Dockerfiles and args like any start (it counts toward the 20 builds an hour).
  A changed Compose file still needs the agent's `ncl workloads up`.
- **Extend** keeps the workload for 30 days from that day. It never shortens
  an expiry and never stacks past 30 days, so it keeps what was approved
  rather than approving more. An agent asks with `ncl workloads extend --name
  <name>` (a card that shows the old and new date).
- **Expiry.** Three days before a running workload expires, its agent gets a
  `[System]` line in its most recent conversation, once per expiry (kept in the
  database across restarts; extending re-arms it), asking it to tell the room
  that an admin can extend it here. At the expiry it is stopped and the agent
  told again.
- **Renews while used.** A published app people open does not expire. The
  gateway's check records when an app was last opened (`last_opened_at`, at
  most once every 10 minutes per app, after the answer, so it never slows a
  request). When a running workload reaches the last three days before its
  expiry, and one of its apps was opened in the last 7 days, the sweep extends
  it exactly as Extend does (30 days from that day, audited as
  `workload.extend` by `system:renew-while-used`), and no reminder goes out.
  An unpublished workload, or an app nobody opened in a week, is never renewed:
  it gets the reminder and stops at its expiry as before.

## Runtime egress (optional)

By default a running stack reaches nothing outside its own network: no
internet, no LAN, nothing on this host. Runtime egress lets a service call
the few hosts an owner approved for it, for example an app's API service
calling a public API and a LAN model server:

```yaml
services:
  api:
    image: ghcr.io/example/cards-api:1.4
    x-nanoclaw-egress:
      - api.example.com
      - "192.0.2.10:11434"
```

**Turning it on.** Pick a free TCP port (8472 is a fine choice), then:

```bash
# .env
NANOCLAW_WORKLOAD_EGRESS_PORT=8472

sudo deploy/workloads-host-rules.sh --stack-egress-port 8472 --install-unit   # plus --gateway … if you use it
```

The flag inserts one rule before the workload chain's drop: a new TCP
connection arriving on a workload bridge to port 8472 on a workload address
is accepted (IPv4 only). NanoClaw's egress proxy listens there, on the
gateway address of each agent network that runs a stack with approved
egress. The preflight then checks that a probe container's connection to
that port on an address where NanoClaw never listens is refused: if
something answers, a service on this host listens on that port on every
address, workload containers could reach it, and runtime egress is refused
until you pick another port or rebind that service. While the key is unset,
or the check fails, a stack that declares `x-nanoclaw-egress` is refused
with the reason; stacks without it are unaffected.

**What a service gets.** `HTTP_PROXY`/`HTTPS_PROXY` (and lowercase) pointing
at its network's proxy with a placeholder credential, `NO_PROXY` for its own
stack (localhost, the subnet, every service name, alias and address) and
`NODE_USE_ENV_PROXY=1`. NanoClaw's override is applied after the stack's own
file, so these win. Only services that declare egress get them.

**The rules for the list** (at most 10 entries per service):

- `host` (ports 443 and 80), `host:port`, or a literal address;
- `*.domain` matches its subdomains on port 443 only; a bare `*` is refused;
- a LAN address must be written literally with its port
  (`192.168.0.20:8080`); a name that resolves to a private address is
  refused at connect time;
- never this host (`localhost`, `host.docker.internal`), the workload range
  `198.18.0.0/15`, Docker's `172.16.0.0/12`, loopback, link-local
  `169.254.0.0/16` (cloud metadata), the tailnet's `100.64.0.0/10`, or the
  publishing edge subnet.

**Who decides.** The list is part of each service's line on the approval
card ("may call …"), so adding or removing a host needs a new card from the
same approvers as any deploy. Every entry must also be something the agent
may reach itself: on its Network allowlist (install and its own hosts) or its
own model's address, never the model floor such as `api.anthropic.com`. At
runtime both apply: a request must match the approved list AND the agent's
current allowlist, so taking a host off the agent cuts its stacks off too.
An agent on **Open** has no allowlist, so for it the approved list alone
applies. Whether the app is published (and to whom) makes no difference.

**Threat model.** The proxy knows a caller by its source address: the
listener's own address names the agent's network, and the source must be a
service address NanoClaw assigned to a running stack on it. Stack containers
drop every capability (no `NET_RAW` or `NET_ADMIN`), so they cannot claim
another address; the agent's own containers on the same network (addresses
`.128` and up) hold none and are refused, as is any service that declared
nothing. The proxy reads the approved record, never the agent's file.
Connections go directly from this host, **never through the credential
gateway** (which would add the agent's secrets), to the address the name
resolved to, checked at that moment against this host's own addresses,
loopback, link-local, the workload range, every current Docker network, the
edge subnet and the tailnet range, so a DNS answer cannot steer it inward.

**Ollama.** An Ollama server NanoClaw knows from the model registry is
normally refused on the agents' proxy. A service whose approved list names it
may send it inference over plain HTTP (an `http://` URL, not a tunnel): one
request per connection, with a `Content-Length` body (no chunked bodies),
and only the inference and read-only paths an agent's model port allows
(never pull, create, copy, push or delete).

**Limits.**

- HTTP and HTTPS through the proxy only: a client that ignores
  `HTTP(S)_PROXY`, or a protocol other than HTTP (a database, SMTP, raw
  TCP), has no way out.
- Central only: a stack that declares egress is placed on central, an agent
  pinned to a worker cannot have one, and an existing stack on a worker
  cannot add it.
- Refusals are kept in memory for a day: `ncl workloads status --name <n>`
  shows the approved list and the latest refusals; Agent → Apps shows
  "Can call" and a refusal count. Each refusal is also audited as
  `runner.egress.blocked` with the caller `workload:<id>/<service>`.

## Settings (`.env`)

| Key | Default | |
|---|---|---|
| `NANOCLAW_WORKLOADS` | off | `1` turns workloads on (subject to the preflight); Admin → Publishing's Workloads switch. |
| `NANOCLAW_WORKLOAD_SLICE` | `nanoclaw-wl-<install>.slice` | The slice all workload containers run under. |
| `NANOCLAW_WORKLOAD_CONFINED_BUILDS` | off | `1` allows `build:` in confined builders; Admin → Publishing's Confined builds switch. |
| `NANOCLAW_WORKLOAD_BUILDER_RUNTIME` | `runsc` | The Docker runtime confined builders run in. |
| `NANOCLAW_WORKLOAD_HELPER_IMAGE` | pinned Alpine | A mirror for the helper image; must name a digest. |
| `NANOCLAW_WORKLOAD_BUILDKIT_IMAGE` | pinned rootless BuildKit | A mirror for BuildKit; must name a digest. |
| `NANOCLAW_WORKLOAD_GATEWAY_PORT` | off | The app gateway's port; set, the gateway runs. |
| `NANOCLAW_WORKLOAD_GATEWAY_BIND` | `127.0.0.1` | The one address it listens on; every-interface addresses are refused. |
| `NANOCLAW_WORKLOAD_GATEWAY_INTERNAL_PORT` | gateway port + 1 | NanoClaw's check listener, on `127.0.0.1`. |
| `NANOCLAW_WORKLOAD_GATEWAY_IMAGE` | pinned Caddy | A mirror for the gateway image; must name a digest. |
| `NANOCLAW_WORKLOAD_TAILNET` | off | `1` turns the tailnet route on (once set up, see 5). |
| `NANOCLAW_WORKLOAD_TAILNET_DOMAIN` | — | The tailnet's DNS name, e.g. `tail1234.ts.net`. |
| `NANOCLAW_WORKLOAD_TAILNET_TAG` | `tag:nanoclaw-app` | The tag sidecars join with; the OAuth client must own it. |
| `NANOCLAW_WORKLOAD_TAILNET_IMAGE` | pinned Tailscale | A mirror for the sidecar image; must name a digest. |
| `NANOCLAW_WORKLOAD_EDGE_SUBNET` | `198.51.100.0/24` | The edge network for both routes; its `.1` is where the gateway listens. `NANOCLAW_WORKLOAD_TAILNET_SUBNET` is read when this is unset. |
| `NANOCLAW_WORKLOAD_CLOUDFLARE` | off | `1` turns the Cloudflare route on (once set up, see 6). |
| `NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN` | — | The app domain: apps are `<app>.<domain>`. Not NanoClaw's own site. |
| `NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID` | — | The Cloudflare account the tunnel and Access applications live in. |
| `NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID` | — | The app domain's zone. |
| `NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN` | `WEBCHAT_CF_ACCESS_TEAM_DOMAIN` | The Access team domain, e.g. `myteam.cloudflareaccess.com`. |
| `NANOCLAW_WORKLOAD_CLOUDFLARE_IMAGE` | pinned cloudflared | A mirror for the connector image; must name a digest. |
| `NANOCLAW_WORKLOAD_PORTS` | off | The tailnet ports route's ports, e.g. `9001-9010` (see 7). |
| `NANOCLAW_WORKLOAD_EGRESS_PORT` | off | Runtime egress's port on each agent network's gateway (see [Runtime egress](#runtime-egress-optional)); the host rules need `--stack-egress-port` with the same port. |

## What NanoClaw enforces

- **The stack.** An allow-list of Compose keys; no host ports, host paths,
  sockets, devices, privileges, host namespaces, custom networks, `env_file`,
  volume `name:`, `${…}` substitution (every `$` is escaped), YAML merge keys
  or tags, or `nanoclaw*`/`com.docker.*` labels.
- **The container.** Every capability dropped (a service may add back a short
  list: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`,
  `NET_BIND_SERVICE`, `KILL`), `no-new-privileges`, pids, memory and CPU
  limits, the slice, rotated logs, a fixed address on the agent's own
  internal `/24`.
- **Approval.** `up`, `delete`, `restore` and `extend` need an owner's card. The card
  says in words what will run — each image with the digest it resolved to,
  each build with its Dockerfile and build-arg hashes, added capabilities and
  the size — under the agent's reason (one line, quoted) and the full command
  line. Those values are pinned into the approved arguments: if anything
  changed before the owner answered, the deploy is refused. Images then run
  by that digest, even if the tag moves.
- **Quota.** Memory and CPU per agent across its stacks
  (`ncl workloads quota-set --group <id> --memory_mb … --cpus … --disk_gb …`),
  and the slice across all agents. Disk is measured every ten minutes (volume
  and container ownership read from `docker inspect`); over the quota the
  agent's stacks are stopped.
- **Backups.** Each stack's volumes nightly (local 01:00–06:00), newest 3
  kept, under `data/workload-backups/`.

## Limits

- Two NanoClaw installs on one Docker host would both carve networks from
  `198.18.0.0/15`; Docker refuses the overlap, so run workloads on one of them.
- Base images in a Dockerfile's `FROM` lines are not pinned unless written
  with a digest; the Dockerfile and build args are.
- Until a route is on, nothing can be published.
- On the tailnet ports route, apps share cookies with each other (one host
  name), and there are only as many apps as ports set up.
- On the tailnet, an app name already used by another device on the tailnet
  cannot be published there.
- On Cloudflare, people are named by email: only NanoClaw users whose id is
  an email sign-in (`webchat:<email>`, from OIDC, Cloudflare Access or an
  email proxy header) can be in a policy. Someone known to NanoClaw only by a
  Tailscale login or a chat handle, or whose sign-in name differs from the
  email the Access identity provider reports (an Entra UPN that is not their
  address), is not let in there. One policy names at most 500 addresses.
- Whether the app domain shares a site with NanoClaw's own address is decided
  by a short built-in list of public suffixes, not the full Public Suffix
  List; an unusual suffix makes it refuse more, rarely less.
