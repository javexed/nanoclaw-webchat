# Contributor documentation

This folder documents **this repo** — how the split is built and maintained.
User- and operator-facing documentation ships with the app and lives in
[`app/docs/webchat/`](../app/docs/webchat/) (it is read inside a running
install, so it cannot move here).

Start at the [root README](../README.md) for what webchat is and how to
install it.

| Doc | What |
|---|---|
| [upstream-submission.md](upstream-submission.md) | The hook-seam proposal for upstream nanoclaw: registry inventory, contract + security notes, the 21/21 review record |
| [../patches/INVENTORY.md](../patches/INVENTORY.md) | Every residue patch, what it does, and where it's headed (upstreamable / product / local) |
| [../app/docs/webchat/upstream-drift.md](../app/docs/webchat/upstream-drift.md) | How the pins track upstream: the coverage guard, the sync cycle, residue shrink |
| [../app/docs/webchat/design/](../app/docs/webchat/design/) | Design notes — learning loop, migration, routing, and the archived fork-era drift audit |
| [../app/public/webchat/DESIGN.md](../app/public/webchat/DESIGN.md) | The frontend design-language contract (read before touching `app.js` / `style.css`) |
| [../app/docs/webchat/e2e.md](../app/docs/webchat/e2e.md) | Playwright smoke suite |

## Repo conventions

- **`app/**` ships into installs; everything else documents this repo.** That
  split is why product docs live under `app/docs/`.
- Changes ride a topic branch → PR → review. Compose CI is the gate of record.
- Patches only shrink: a patch dies when upstream absorbs the fix or a seam
  registry makes it a module concern.
