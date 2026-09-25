# Installing NanoClaw

Three ways in, depending on where you're starting. Each ends at NanoClaw with the
webchat setup wizard on port 3100 — open it, and the browser walks you through
Claude/Codex sign-in or a local model. No API key on the command line, no
`claude` login on the box.

## 1. Fresh Debian/Ubuntu host — one command

A VM, a Raspberry Pi, bare metal, or a container guest:

```bash
git clone <this repo> nanoclaw-webchat && cd nanoclaw-webchat && bash install.sh --dir ~/nanoclaw --local
```

`--local` composes, builds, installs the OneCLI vault and starts a `--user`
service on `http://127.0.0.1:3100` (localhost signs you in as owner). Without
`--local`, `install.sh` only composes and builds; enable the webchat with
`bash configure-webchat.sh` in the install dir. Needs Node 22, pnpm and Docker
already present.

For a LAN-reachable host that prints a **URL + bearer token**, use the fresh-host
provisioner instead — details, env overrides, and the update flow:
**[../../deploy/README.md](../../deploy/README.md)**.

## 2. Proxmox VE — LXC helper script _(in testing)_

A Proxmox VE Helper-Scripts (`ct/` + `install/`) entry, maintained at
**[javexed/ProxmoxVED](https://github.com/javexed/ProxmoxVED)**. It creates a
Debian 13 LXC and installs NanoClaw on the community `build.func` framework. Not
yet in the upstream community-scripts catalog — run it from the fork branch:

```bash
COMMUNITY_SCRIPTS_URL="https://raw.githubusercontent.com/javexed/ProxmoxVED/feat/nanoclaw" \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/javexed/ProxmoxVED/feat/nanoclaw/ct/nanoclaw.sh)"
```

The container runs Docker, so it's created with `nesting=1,keyctl=1`. First boot
builds the agent image — allow several minutes.

## 3. Add webchat to an existing NanoClaw fork

Already running NanoClaw (Node + pnpm) and just want the chat UI? Point the
installer at the checkout you already have — it composes the webchat app tree
onto it in place rather than creating a second install:

```bash
bash install.sh --dir /path/to/your/nanoclaw
```

Add `--seam preinstalled` if that checkout already carries the hook seam. Full
walkthrough:
**[guide.md](guide.md)**.

## What it needs

- **Debian or Ubuntu** (apt + systemd). Non-apt distros use path 3 on an existing
  install, or Docker Compose.
- **x86_64 with AVX2** preferred — the Claude Code CLI is a native x86 binary that
  hangs without it (on a Proxmox VM set the CPU type to `host`). **arm64**
  (Raspberry Pi) works for the Claude/API path; local models want an x86 box.
- **Docker** — each agent session runs in its own sandbox. `deploy/install.sh`
  and the Proxmox script install it; the root `install.sh` does not.

Reach it over your LAN or [Tailscale](webchat.md#authentication-methods); the
first Tailscale login becomes owner, after which you can enable HTTPS and retire
the bearer token from the wizard.
