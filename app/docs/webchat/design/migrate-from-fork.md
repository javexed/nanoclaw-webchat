# Migrating a live fork-era install to the split app — design note

Status: ACCEPTED 2026-07-27 (all four open decisions per recommendation); implemented as `scripts/migrate-from-fork.sh`. Nothing here is built yet except the manual
procedure, which has been executed twice in production (2026-07-26 cutover,
2026-07-27 refresh) on the reference install.

## The shape of the problem

A fork-era install is a checkout of `channels-webchat` (or a tarball made
from it) with webchat woven through it. The split app produces the same
*working tree* from different inputs: pinned upstream + the hook seam +
this repo's payload/patches. Crucially, **everything that makes an install
THAT install lives in untracked paths**:

| State | Where | Touched by migration? |
|---|---|---|
| Central DB (rooms, users, wirings, webchat tables) | `data/v2.db` | no |
| Session DBs + transcripts | `data/v2-sessions/` | no |
| Agent workspaces, memory, skills | `groups/` | no |
| Config, VAPID keys, tokens | `.env` | no |
| Credentials | OneCLI vault (external) | no |
| Upgrade marker | `data/upgrade-state.json` | **restamped** (see below) |

So migration is a **code swap around stationary state** — not a data
migration. The webchat DB schema is identical on both sides (same
migrations ride the payload), and migrations only ever run forward.

## The proven procedure (git-checkout installs)

1. **Snapshot**: `git branch wip/pre-split-<date> HEAD` in the install.
2. **Compose** on any machine: `install.sh --dir /tmp/composed` (or download
   the CI tarball artifact), then `git add -A && git commit` inside it.
3. **Flip in place**: `git -C <install> fetch /tmp/composed HEAD`,
   `git -C <install> branch composed-live FETCH_HEAD`, checkout. Tracked
   files swap atomically; untracked state is untouched by construction.
4. `pnpm install --frozen-lockfile && pnpm run build`.
5. **Restamp the upgrade marker**: fork installs self-report their own
   version (e.g. 2.2.0); the composed tree reports upstream's. Without
   `scripts/upgrade-state.ts set "" migrate-to-split` the tripwire
   crash-loops the host. Args are POSITIONAL (version, via).
6. If `WEBCHAT_PUBLIC_DIR` is set, rsync `public/webchat/` over it
   (`--delete`; the served dir is otherwise a stale copy).
7. Restart the service; smoke: front door 200, one room round-trip, a fresh
   `status_events` start/done pair.

Rollback at any point: `git checkout wip/pre-split-<date>`, rebuild,
restamp back, restart. The state never moved, so rollback is total.

## Hard constraints (learned, not theorized)

- **Migrate in place, never to a fresh directory.** The install slug —
  service name, image name, OneCLI agent scoping — derives from the
  checkout path. A fresh dir mints a second identity and orphans the vault
  agents, containers, and service unit.
- **The container image does NOT need a rebuild** when the Dockerfile is
  content-identical across the flip (it usually is — the runner source is
  bind-mounted). The migrator should diff the Dockerfile and only rebuild
  on change.
- **Running agent containers survive the flip** and keep their old runner
  code until respawn. Fine: they respawn on natural lifecycle. The migrator
  should not force-kill them.

## Tarball installs (deploy/ path) — the open half

No `.git`, so the atomic-checkout trick is unavailable. Options, in
preference order:

1. **Adopt-a-repo**: `git init` + commit the current tree as a baseline,
   then proceed exactly as above. Gains the rollback story permanently.
   Downside: none obvious — this is the recommended path.
2. rsync the composed tree over the install with `--delete` scoped to
   tracked paths only (data/groups/.env excluded). Fragile: the
   exclude list IS the correctness surface, and rsync-without-delete has
   already produced phantom-file bugs in this project's history.

Decision needed: is option 1 acceptable as the ONLY tarball path?

## What the script would be

`scripts/migrate-from-fork.sh <install-dir>` in this repo:

    detect type (git checkout / tarball) → snapshot (branch or init+commit)
    → compose fresh (or --tarball <artifact>) → flip → deps + build
    → Dockerfile diff → rebuild image only if changed
    → restamp marker (via=migrate-from-fork)
    → WEBCHAT_PUBLIC_DIR sync if set
    → restart service → automated smoke → print rollback one-liner

Failure at any step before "restart" leaves the old code running; failure
after restart prints the rollback recipe. The smoke gate is the same one
the manual runs used.

## Open questions for review

1. Tarball path: adopt-a-repo only, or carry the rsync variant too?
2. Should the script refuse to run if the install's fork tip is NEWER than
   this repo's `forkRef` pin (fork features the split hasn't absorbed yet)?
   Proposed: yes, hard refusal with the file list — a migration must never
   silently drop a fork-side feature the user has been running.
3. Service restart: systemd/launchd detection, or leave the restart to the
   operator (script prints the command)? Proposed: detect and do it, since
   the smoke gate needs the host up anyway.
4. Where does this live long-term — this repo's `scripts/`, or a skill
   (`/migrate-to-split`) so fork installs can drive it from Claude Code?
   Proposed: script first (it's the substrate either way), skill later.
