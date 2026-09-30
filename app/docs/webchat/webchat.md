# Webchat channel — architecture & feature reference

The webchat channel is a self-registering **channel adapter** that serves an
installable PWA and a full **operator console** from an embedded HTTP + WebSocket
server. It is the only channel that ships its own management surface; everything
else routes through NanoClaw's normal entity model (users → messaging groups →
agent groups → sessions), exactly like Discord/Slack/Telegram.

This is the overview; the user-facing tour is [guide.md](guide.md). Focused
docs cover the harder subsystems in depth:

- Message path: [message-path.md](message-path.md), [architecture-diagram.md](architecture-diagram.md)
- Threads and context sync: [threads.md](threads.md), [threads-qa.md](threads-qa.md)
- User credentials (per-member): [user-credentials.md](user-credentials.md)
- Local-model routing: [llm-router.md](design/llm-router.md), [auto-routing.md](design/auto-routing.md)

Ships **disabled by default** — the adapter factory returns `null` unless
`WEBCHAT_ENABLED=true`.

## Architecture

### How it plugs into NanoClaw

`registerChannelAdapter('webchat', …)` in `src/channels/webchat/index.ts` registers
a factory that builds the adapter only when enabled. The adapter declares
`supportsThreads: true`, so — unlike Chat-SDK-bridged channels — it preserves
`threadId` end to end. From the router's perspective it is an ordinary
`ChannelAdapter` with `onInbound` / `deliver` / `setTyping` / `sendStatus`.

### Message flow

A browser WebSocket frame becomes `onInbound(roomId, threadId, message)`; the
router writes it into the session's `inbound.db` and wakes the container; host
delivery polls `outbound.db` and calls `adapter.deliver`, which stores the reply
and broadcasts it. A rate-limited **loop-back** re-enters the router so other
agents wired to the room can react. The full walk-through is
[message-path.md](message-path.md). `webchat_messages` is a PWA-facing history
mirror; routing and delivery still flow through `inbound.db` / `outbound.db`.

### Storage

A webchat-owned set of ~25 tables in the central DB (`data/v2.db`), created by
`src/channels/webchat/migration.ts`: rooms, messages (+ an FTS5 external-content
mirror `webchat_messages_fts`), threads, thread reads/sync, room settings/primes/
pins/reads/archives, models + per-agent assignments, MCP servers + per-agent
attachments, push subscriptions, user handles, an approvals index, and settings.

### Credential injection

Credentials are never placed in env vars or chat. Per-turn credentials are
injected on the wire by the **OneCLI gateway**, keyed to the container's OneCLI
agent identity, resolved at spawn from trusted session state. See the user-credentials
section and [user-credentials.md](user-credentials.md).

### Approvals bridge

The adapter registers approval listeners so credentialed-action approval cards
surface both in the requesting agent's room and in per-approver DM "inboxes"
(synthetic `approvals:<handle>` messaging groups). Cards clear live on first
response.

## Feature catalog

### Chat

What each feature looks like to a user is in [guide.md](guide.md); the
implementation notes that matter here:

- **Mention routing** — rooms are **mention-only**: an agent replies only when
  @-mentioned. A per-room **prime** agent acts as a catch-all; a per-room engage
  mode governs stickiness.
- **Threads** — a thread *is* an agent session (`resolveSession(…, 'per-thread')`),
  so each `(room, thread)` has isolated context and its own `inbound.db` /
  `outbound.db`; context sync copies a verbatim, incremental slice between a
  thread and main. See [threads.md](threads.md).
- **Markdown** — GFM via vendored `marked` + `DOMPurify`.
- **Attachments** — chunked/resumable uploads above ~512 KB; files are stored as
  separate message rows.
- **Live agent activity** — redacted `status` frames stream a per-turn thinking
  bubble (`start` / `tool` / `progress` / `reasoning` / `done` / `stalled`).
- **Search** — an SQLite **FTS5** external-content table with sync triggers,
  prefix matching and `snippet()` highlighting.
- **PWA** — Web Push (VAPID) with an SSRF-allowlisted endpoint set; a service
  worker (cache-first shell under a content-hashed cache name, `/api` and `/ws`
  bypassed); design tokens per
  [`public/webchat/DESIGN.md`](../../public/webchat/DESIGN.md).

### Security & identity

- **Localhost-first binding** — default `127.0.0.1:3100`; refuses a non-loopback
  bind unless an explicit auth method is configured.
- **Authentication** — five methods, each auto-enabled by the presence of its env
  var and tried in priority order (see table below). There is no mode selector;
  localhost auto-owner is disabled once any explicit method is configured.
- **Roles** — owner / admin, global or scoped to an agent group; the first
  authenticated identity is auto-granted global owner. Fails open to a single
  trusted operator when the permissions module isn't installed.
- **Per-room access gating** — a user can access a room if they can access any
  agent group wired to it.
- **CSRF / CORS / CSP** — mutating routes require an `X-Webchat-CSRF: 1` header
  (else 403), plus same-origin CORS echo, strict CSP, `X-Frame-Options: DENY`,
  nosniff.
- **SSRF guards** — every operator-supplied URL (model / Ollama / MCP probes) goes
  through `assertSafeOutboundUrl` / `safeFetch`: rejects non-http(s) and
  cloud-metadata hosts, always blocks link-local `169.254/16`; private / RFC1918 /
  loopback allowed by default (legit LAN Ollama), blocked under
  `WEBCHAT_BLOCK_PRIVATE_IPS=true`.
- **Redaction** — `redactSensitiveData` masks Anthropic / OAuth / GitHub / AWS /
  Slack / Discord / Azure keys, PEM blocks, connection strings, and env secrets
  before any broadcast or push payload.
- **TLS** — optional `WEBCHAT_TLS_CERT` / `_KEY` upgrade to HTTPS.

### User credentials — per-member

In a shared room, each member's turns run in a container bearing that member's own
OneCLI agent identity, so the gateway bills that member's own credential. Per-member
session keying uses `per-thread` with `thread_id = <userId>::<threadId|main>`;
shared context is preserved by fan-out (sender `trigger:1`, others `trigger:0`).
Full design: [user-credentials.md](user-credentials.md).

- **Credential types** — Anthropic API key (`sk-ant-…`), Claude subscription OAuth
  token, OpenAI API key, Codex (ChatGPT) and Grok subscriptions. Subscriptions are
  minted from the browser (`oauth-mint.ts` drives `claude setup-token` /
  `codex login` through a PTY and reads their output, so a CLI output change can
  break it). Codex / OpenAI types are inert until `/add-codex`.
- **Storage / injection** — credentials go straight to the OneCLI vault (the host
  never holds them); the per-member agent id is a deterministic
  `user-creds-<slug>-<hash>`. Approval reversal is tracked in
  `user_credential_members`.
- **Gating** — per-room `credential_mode` (disabled / optional / required, default
  disabled); a workspace policy sets the default mode, which credential types are
  permitted (out of the box: Anthropic key only), and one subscription switch per
  provider (`allow_{claude,codex,grok}_oauth`).
  Onboarding is bound to the authenticated `userId`, room-access + CSRF gated, and
  rate-limited.

### Operator console

- **Agents** — CRUD, wire to rooms, edit instructions, status (active / paused /
  archived), assign a model, attach MCP servers, and **draft from a prompt**
  (`POST /api/agents/draft` calls Anthropic host-side via OneCLI and returns a
  `{name, instructions}` suggestion — it does not create). The settings panel is a
  two-tab layout: **Settings** (status pills, name, a model picker showing the
  agent's auto-detected model when none is assigned, and MCP-servers / Rooms attach
  accordions driven by one shared bottom-sheet picker) and an **Instructions**
  sub-tab. Clicking an agent in a room's settings — or a room in an agent's — jumps
  straight to that entity.
- **Models** — register `anthropic` / `ollama` / `openai-compatible`; live
  discover / probe (races http/https + Ollama, classifies the provider); bulk
  register; per-agent assignment writes an env override into the group's
  `settings.json` (containers read it on their next spawn). `openai-compatible`
  requires `/add-litellm` (fronts them on the default Claude harness).
- **Ollama host management** — list hosts, stream model **pulls** with progress,
  refresh the router roster.
- **Local-model routing** — a console over a LiteLLM + Arch-Router classifier
  stack: routes editor with a live test bench, decisions tail and metrics, the
  router roster, and multiple named routing profiles. **Settings → Auto routing →
  Install** sets the stack up with no shell (or use `/add-litellm` +
  `/add-routing`); the tab stays hidden until `routes.json` exists. Details:
  [auto-routing.md](design/auto-routing.md).
- **MCP registry** — register / probe (real MCP client, lists tools) / assign MCP
  servers to agents; syncs into `container_configs.mcp_servers`, co-existing with
  `ncl`-added servers. A remote server's tool surface is hash-pinned at approval,
  so description drift flags it until re-approved; per-server tool allowlists
  feed the SDK's `allowedTools`. Servers with host-side auth (bearer or OAuth 2.1)
  reach containers through a relay URL with a per-(agent, server) token, so the
  real credential never enters `container.json`.
- **Approvals inbox** — pending list + respond; in-room and per-approver cards.
- **Permissions** — user list, role grants/revokes, per-agent-group admin/member
  matrix (role grants owner-only; member grants delegable to scoped admins).
- **Topology & Wiring** — a Rooms→Agents→Models graph and a rooms×agents matrix.
- **Dashboard** — health strip, message-activity metrics, container/agent
  drill-downs, uptime, and a "Router · last 7 days" panel when routing is installed.

## Authentication methods

Each method is on when its env var is set, tried in priority order; **Admin →
Sign-in** turns Tailscale, OIDC and the trusted proxy on and off (below).
Localhost auto-pass is off once any explicit method is set.

| Method | Env var(s) | Detection | Identity |
|---|---|---|---|
| Bearer | `WEBCHAT_TOKEN` (≥24) | `Authorization: Bearer` or WS subprotocol `bearer.<t>`; constant-time compare | `webchat:owner` |
| OIDC (Microsoft Entra ID or any provider) | `WEBCHAT_OIDC_ISSUER`, `WEBCHAT_OIDC_AUDIENCE`, and the endpoints from discovery (below) | A signed id token — the web app's own sign-in, App Service's `x-ms-token-aad-id-token`, or a JWT presented as `Authorization: Bearer` (the VS Code extension). RS256 or ES256, pinned to the key's type; signature, issuer, audience, expiry checked against the issuer's keys. A token that fails falls through to the methods below; an expired one adds `X-Webchat-Auth-Hint: token-stale` and the browser renews it via `/.auth/refresh` | Microsoft: `webchat:<preferred_username>`; other providers: `webchat:<email>`, only when `email_verified` |
| Trusted-proxy / SSO | `WEBCHAT_TRUSTED_PROXY_IPS` (`auto`/`*`/CIDR list), `WEBCHAT_TRUSTED_PROXY_HEADER` | The mode is only an IP gate: `auto`/`*` accepts any source, a CIDR list requires the hop to match. Either way the same headers are read — Azure EasyAuth / Cloudflare Access paired headers first (presence only, unsigned), then `WEBCHAT_TRUSTED_PROXY_HEADER` | `webchat:<identity>` |
| Tailscale | `WEBCHAT_TAILSCALE=true` | `tailscale whois --json <ip>` → `LoginName` | `webchat:tailscale:<email>` |
| Localhost | _(none)_ | remote is loopback **and** no explicit method configured | `webchat:local-owner` |

### Admin → Sign-in

Owners and global admins turn each method on or off in **Admin → Sign-in**:
Tailscale, OIDC, the trusted proxy, and the access token. Changes are written
to `.env` and apply at once — no restart. The HTTPS-over-Tailscale switch sits
on the same page.

- **OIDC**: **Microsoft** takes the tenant (its GUID or a verified domain) and
  the app registration's client ID; **Other** takes the issuer URL, the client
  ID and a name for the login button. Either takes an optional client secret
  (write-only). Saving reads the provider's OpenID configuration — Microsoft's
  for the tenant, or `<issuer>/.well-known/openid-configuration`, whose
  `issuer` must be exactly the one typed — and stores the issuer, keys and
  endpoints from it; every endpoint must be https. A provider that takes the
  secret only as HTTP Basic gets it that way. The page shows the **redirect
  URI** to register with the provider: `<origin>/auth/oidc/callback`
  (`/auth/microsoft/callback`, the first version's path, still works).
  Microsoft also takes the VS Code extension's optional **App ID URI** and
  **client ID**; the extension signs in with Microsoft only, so with another
  provider it signs in over the network (Tailscale).
- **Trusted proxy**: the proxy's IPv4 address(es) or CIDRs and the identity
  header. `auto` / `*` (trust any source) is `.env`-only: it is safe only when
  nothing but the proxy can reach the port, which the page cannot check.
- **Lockout rules**: you cannot turn off, or re-point, the method you are
  signed in with (sign in another way first), nor the last usable method on an
  install reachable beyond this machine. Signed in as the localhost owner, only
  Tailscale can be turned on — the first tailnet identity then becomes an
  owner, as in the setup wizard.

Audit: `auth.signin.set` (method, on/off, and for OIDC the provider, issuer and
client id — never the secret).

### The web app's OIDC sign-in, and linking sign-ins

With OIDC on, the login screen offers **Sign in with <provider>** — the web
app's own sign-in, no App Service or proxy needed. It is the OpenID Connect code
flow with PKCE (most providers accept `http` redirect URIs only for
`localhost`, so a tailnet install needs **HTTPS over Tailscale** first). The id
token is verified like any OIDC token, plus the nonce minted for that attempt.
A successful sign-in starts a 14-day session in an `HttpOnly`, `SameSite=Lax`
cookie; only a SHA-256 of its token is stored (`webchat_signin_sessions`).
Turning OIDC off ends every session.
Each sign-in attempt is bound to the browser that started it (a short-lived
`HttpOnly` state cookie the callback must match), so a callback link someone
else started cannot sign you in as them. A WebSocket upgrade riding the session
cookie must come from the same origin.

**Settings → Sign-ins** links a second sign-in to the same account: **Link
<provider>** (a round trip through the provider) or **Link Tailscale**
(this device's tailnet identity). Linking needs both sign-ins in the person's
hands at once; nothing takes an identity typed by hand. The **older** identity
stays the account, so its roles, credentials and paired machines stay put; an
identity that already holds a role, or has sign-ins of its own, cannot become
a linked sign-in. Unlinking applies on the next request. Audit:
`auth.signin`, `auth.link`, `auth.unlink`.

## Environment variables

Loaded from `.env` into `process.env` (if unset) by the adapter's `env-load.ts`
(service runners don't inherit `.env`).

| Var | Meaning | Default |
|---|---|---|
| `WEBCHAT_ENABLED` | Enable the adapter (else the factory returns null) | off |
| `WEBCHAT_HOST` | Bind host | `127.0.0.1` |
| `WEBCHAT_PORT` | Bind port | `3100` |
| `WEBCHAT_TOKEN` | Bearer secret (≥24 chars) | `''` |
| `WEBCHAT_TAILSCALE` | `=true` enables Tailscale-whois auth | off |
| `WEBCHAT_TRUSTED_PROXY_IPS` | `auto`/`*` or CSV IP/CIDR allowlist → enables proxy/SSO auth | `''` |
| `WEBCHAT_TRUSTED_PROXY_HEADER` | Header carrying the proxy identity | `x-forwarded-user` |
| `WEBCHAT_OIDC_PROVIDER` | `microsoft` or `other` | `microsoft` for a login.microsoftonline.com issuer |
| `WEBCHAT_OIDC_NAME` | The provider's name on the login button (other providers) | `SSO` |
| `WEBCHAT_OIDC_ISSUER` | Exactly the `iss` the provider's tokens carry → enables OIDC (with the audience) | `''` |
| `WEBCHAT_OIDC_AUDIENCE` | The client id (the token's `aud`) | `''` |
| `WEBCHAT_OIDC_JWKS_URI` | Signing-key URL (from discovery; derived for Microsoft when blank) | derived |
| `WEBCHAT_OIDC_AUTHORIZE_URL` / `_TOKEN_URL` | The sign-in flow's endpoints (from discovery; derived for Microsoft when blank) | derived |
| `WEBCHAT_OIDC_TOKEN_AUTH` | `basic` sends the client secret as HTTP Basic instead of in the body | body |
| `WEBCHAT_OIDC_CLIENT_SECRET` | For a confidential client (Microsoft: a **Web**-platform redirect URI); omit for a public client (PKCE) | `''` |
| `WEBCHAT_OIDC_LOGIN` | `false` hides the sign-in button while keeping token checks | on with OIDC |
| `WEBCHAT_PUBLIC_URL` | The origin users reach central at, when a proxy means the request's own Host is not it (builds the redirect URI) | from the request |
| `WEBCHAT_ALLOWED_HOSTS` | Extra host names the server answers to (a tunnel or custom domain), comma-separated; `*` accepts any. IP addresses, `localhost`, this machine's name, its Tailscale name, `WEBCHAT_PUBLIC_URL` and requests through the trusted proxy are always accepted; anything else gets `421` | `''` |
| `WEBCHAT_TLS_CERT` / `WEBCHAT_TLS_KEY` | Enable HTTPS (both required) | unset |
| `WEBCHAT_PUBLIC_DIR` | PWA static dir | `public/webchat` |
| `WEBCHAT_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` | Web-Push VAPID keys (push off if unset) | unset |
| `WEBCHAT_VAPID_SUBJECT` | VAPID subject | `mailto:admin@example.com` |
| `WEBCHAT_DRAFTER_MODEL` | Model for draft-from-prompt | `claude-haiku-4-5` |
| `WEBCHAT_BLOCK_PRIVATE_IPS` | `=true` extends the SSRF block to loopback/RFC1918/CGNAT | off |
| `WEBCHAT_MCP_RELAY_PORT` | Port for the MCP auth relay (see below) | `3102` |
| `WEBCHAT_MCP_RELAY_HOST` | Interface the relay binds — the address agent containers reach as `host.docker.internal`. Required on hosts with no `docker0` | auto (docker0 IP) |
| `OLLAMA_HOST` | Dashboard "is Ollama up" probe only | `''` |

## HTTP API

The route table (`API_ROUTES` in `src/channels/webchat/server.ts`) is the source
of truth for endpoints. Every mutating route requires the `X-Webchat-CSRF: 1` header.

## File layout

Adapter (`src/channels/webchat/`):

| File | Role |
|---|---|
| `index.ts` | Adapter registration; `onInbound` / `deliver` / `setTyping` / `sendStatus`; loop-back fan-out; approval-card listeners |
| `server.ts` | The HTTP server: manual route dispatch, static serve, WS upgrade, TLS, CORS/CSP |
| `ws.ts` / `state.ts` | WebSocket handling; `broadcast` + per-user approval push |
| `auth.ts` / `access.ts` / `roles.ts` | The five auth methods; per-room access; owner/admin roles |
| `db.ts` | All webchat table CRUD, thread/sync helpers, FTS search, approvals index, models/MCP |
| `migration.ts` | The ~25 webchat tables |
| `models.ts` / `ollama-manage.ts` | Model registry + SSRF policy + env injection; Ollama pull + router state |
| `mcp-registry.ts` / `mcp-probe.ts` | MCP registry + probe |
| `drafter.ts` / `oauth-mint.ts` | Host-side agent drafter; browser OAuth/Codex mint |
| `push.ts` / `redact.ts` / `reconcile.ts` / `env-load.ts` | Web Push + allowlist; secret masking; delivery-race recovery; `.env` shim |

PWA (`public/webchat/`): `index.html` (all views/modals), `app.js` (behavior; built from `ui/src/`),
`style.css`, `sw.js`, `manifest.json`, `DESIGN.md` (design-language contract),
vendored `marked.min.js` / `dompurify.min.js`, icons/logos.

Cross-cutting: `src/modules/user-credentials/`, `src/modules/agent-status/`,
migrations `src/db/migrations/module-*.ts` + `src/channels/webchat/migration.ts`.

## How it ships

Webchat is its own product repo; `install.sh` composes a working install
from three pinned inputs (`versions.json`) — it is deliberately not merged
into NanoClaw core (too large a surface):

- **Upstream nanoclaw** is cloned at the pinned ref, unmodified.
- **The hook seam** (`pub/module-hooks`, a set of module registries) merges in —
  inert until modules register.
- **`app/`** — webchat-owned dirs (`src/channels/webchat`, `public/webchat`,
  `src/modules/user-credentials`, the agent-status + learning modules,
  migrations, docs) overlay as pure adds; **`patches/`** carries the small
  residue of core-file edits not yet expressible via the seam (shrinking as
  fixes land upstream — see [upstream-drift.md](./upstream-drift.md)).
- Migrations register, pinned deps (`ws`, `busboy`, `web-push`, `undici`,
  `@modelcontextprotocol/sdk`) install, host and container build.
- `configure-webchat.sh` writes `.env` (enable flag, network mode, VAPID keys).
