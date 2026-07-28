# NanoClaw Webchat

**A local-first chat desk for your [NanoClaw](https://github.com/nanocoai/nanoclaw) agents** —
multi-agent rooms, per-room threads, per-member credentials, local-model
routing, and a full operator console, in one installable PWA that binds to
`127.0.0.1`.

Not Slack. Not a hosted widget. Your agents, your keys, your machine.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![PWA](https://img.shields.io/badge/PWA-installable-5a3.svg)](#)

---

## Quickstart

You need Node 22 + pnpm, Bun, and Docker. **NanoClaw itself is a dependency —
this installer fetches it for you.**

```bash
git clone https://github.com/javexed/nanoclaw-webchat
cd nanoclaw-webchat
bash install.sh --dir ~/nanoclaw          # clone nanoclaw, apply the hook seam,
                                          # overlay webchat, build
cd ~/nanoclaw
bash configure-webchat.sh                 # auth, TLS, Web Push (VAPID)
pnpm run dev                              # or install the service
```

Open **http://127.0.0.1:3100**. On localhost you're signed in as the owner
automatically; the first run walks you through connecting a model and creating
your first agent.

**Reaching it from other devices** — pick one auth method; each enables itself
from its env var:

| Method | Set | For |
|---|---|---|
| Localhost | _(default)_ | one user, same machine |
| Tailscale | `WEBCHAT_TAILSCALE=true` | your devices over your tailnet |
| Bearer token | `WEBCHAT_TOKEN=…` (≥24 chars) | a shared secret |
| SSO / proxy | `WEBCHAT_TRUSTED_PROXY_IPS=…` | Entra ID, Cloudflare Access… |

Localhost auto-owner switches off the moment any explicit method is configured.

→ **[Install guide](app/docs/webchat/install.md)** (Proxmox LXC, Docker host,
service setup) · **[Full user guide](app/docs/webchat/guide.md)** (screenshot
tour of every feature)

---

## What you get

**Chat.** A shared lobby where you route with `@agent` mentions, plus per-agent
DMs. **Per-room threads** — each thread is its own agent session with its own
context and memory, in a nested sidebar with per-thread unread. Markdown with
code copy, drag-and-drop attachments with resumable uploads, full-text search
(SQLite FTS5), and a live **thinking bubble** streaming the agent's tools and
reasoning with an interrupt button.

**Multi-agent rooms.** Several agents in one room, each deciding whether a turn
is theirs; an agent's reply fans out to the others as context so they stay in
sync. Optional "prime" catch-all agent per room.

**Per-member credentials.** In a shared room each member can connect **their
own** Anthropic key. Their turns run in a container bearing their own
credential identity — nothing shared, nothing replayable. Keys go straight to
the OneCLI vault, never through the host.
→ [details](app/docs/webchat/user-credentials.md)

**The learning loop.** `/learn` (or an automatic trigger on a busy turn) runs a
*restricted* review pass — toolset dropped to skill-drafting alone — that
proposes a reusable skill from what just happened. You keep or discard it.
→ [details](app/docs/webchat/learning-loop.md)

**Local-model routing.** One button installs the whole stack (LiteLLM +
Arch-Router classifier), then a console scores each turn and sends the easy
ones to a local model while keeping a frontier model for the hard ones. Starts
in shadow mode so you can watch before switching.

**Operator console.** Create and wire agents, register models with live
discovery, pull Ollama models with progress, manage MCP servers, roles and
members, and an approvals inbox for credentialed actions — all in the browser.

**Security posture.** Binds `127.0.0.1` by default and refuses a public
interface without explicit auth. CSRF header on mutations, strict CSP, SSRF
guards on every operator-supplied URL, secret redaction on every broadcast and
push payload, optional TLS.
→ [security model](app/docs/webchat/security.md)

---

## How it's built

Webchat installs **NanoClaw as an unmodified dependency** plus a small **hook
seam** — 21 module registries (`register*()`) with inert call-sites, proposed
upstream as [`pub/module-hooks`](https://github.com/javexed/nanoclaw/tree/pub/module-hooks).
Webchat's own code arrives as a pure overlay; a shrinking set of residue
patches covers what the seam doesn't reach yet.

```
install.sh          composes an install from three pinned inputs (versions.json)
  1. clone nanoclaw @ upstreamRef      ← unmodified dependency
  2. merge the hook seam @ seamRef     ← 21 registries, inert until used
  3. overlay app/                      ← webchat's own files (pure adds)
  4. apply patches/                    ← residue; see patches/INVENTORY.md
  5. register barrels + migrations, install deps, build
```

| Path | What |
|---|---|
| `app/` | Webchat's source, laid out in nanoclaw's tree shape. **Everything here ships into an install** — including `app/docs/webchat/`, which operators and agents read in a running system. |
| `patches/` | Edits to nanoclaw-owned files, sorted by destiny: `upstreamable/` (generic fixes bound for upstream), `product/` (features awaiting a seam registry), `local/`. See [INVENTORY.md](patches/INVENTORY.md). |
| `overlays/` | Conditional patches applied only when a gated provider is installed (today: the Codex activity feed). |
| `versions.json` | The three pins: upstream, seam, and the transitional fork reference. |
| `docs/` | Documentation **about this repo** (contributor-facing) — as opposed to `app/docs/`, which ships. |
| `scripts/` | Dev harness: compose a tree, regenerate patches, check coverage, migrate a fork install. |

The composed install passes upstream's full suites plus webchat's own
(1,900+ tests), re-proven by CI on every push. Two guards catch the failures
tests can't see: `scripts/check-manifest.sh` keeps `app-manifest.txt` in step
with the app tree (a migration missing an entry ships but never runs), and —
while the pre-split fork is still referenced — `scripts/check-coverage.sh`
accounts for every file that differs from it. See
[docs/coverage-guards.md](docs/coverage-guards.md).

---

## Documentation

**Using it:** [guide](app/docs/webchat/guide.md) ·
[install](app/docs/webchat/install.md) ·
[threads](app/docs/webchat/threads.md) ·
[user credentials](app/docs/webchat/user-credentials.md) ·
[learning loop](app/docs/webchat/learning-loop.md) ·
[approval pre-judge](app/docs/webchat/approval-prejudge.md) ·
[security](app/docs/webchat/security.md)

**Working on it:** [docs index](docs/README.md) ·
[patch inventory](patches/INVENTORY.md) ·
[upstream drift & sync](app/docs/webchat/upstream-drift.md) ·
[hook-seam submission](docs/upstream-submission.md) ·
[frontend design contract](app/public/webchat/DESIGN.md) ·
[migrating a fork install](app/docs/webchat/design/migrate-from-fork.md)

## License

MIT — see [LICENSE](./LICENSE). Contains material derived from
[nanoclaw](https://github.com/nanocoai/nanoclaw) (MIT) in `app/` and `patches/`.
