# Upstream drift — how the two-repo model tracks nanoclaw

This repo never forks nanoclaw. It composes three pinned inputs
(`versions.json`):

| Pin | What | Moves when |
|---|---|---|
| `upstreamRef` | `nanocoai/nanoclaw` main | upstream releases (nightly sync finds it) |
| `seamRef` / `seamBranch` | `pub/module-hooks` — the hook-seam branch (upstream + 13 additive commits) | a seam PR merges, or upstream moves and the seam rebases |
| `forkRef` | `channels-webchat` tip (transitional) | the coverage guard's reference until the fork retires |

## How drift is caught

`scripts/check-coverage.sh` runs on every push (CI) and before every pin
bump (locally — non-negotiable, learned the hard way):

1. **Name pass** — every file differing between the composed base and
   `forkRef` must be in payload ∪ patches ∪ exclusions ∪ removals. Silent
   drops are structurally impossible.
2. **Content-parity pass** — payload files the fork also carries must be
   byte-equal to the fork's copy unless listed in `payload-adapted.txt`
   (where this repo is canonical). Catches fixes that land fork-side but
   miss the payload — it found two real drifts on day one.

Unknown refs fail loudly (an unresolvable ref once read as "0 differing
files, OK"). This server refuses raw-SHA fetches once a pin is no longer a
branch tip — fetch the branch, then `git cat-file -e <pin>` to assert the
commit arrived (`install.sh` and the CI both do this).

## The update cycle

Exercised end-to-end when upstream absorbed container hardening (#2748):

1. **Nightly sync** merges upstream into `channels-webchat` via PR
   (auto-merged when green; staged `[tests failing]` for a human when not).
2. **Seam rebase** onto the new upstream tip. Evidence so far: all seam
   commits rebase with zero conflicts — registries attach at stable points;
   only patch residue collides.
3. **Repo B**: re-merge conflicting patches onto the new upstream shape,
   retire anything upstream absorbed, bump pins (guard first), PR, compose
   CI green.
4. **Live refresh** when convenient: commit the composed tree, fetch it
   into the install's repo as a branch, flip, build, restart, smoke.

## The residue-shrink path

`patches/` only shrinks. A patch dies when: upstream absorbs the fix (the
fork's container-hardening test was the first retirement), a seam registry
makes it expressible as a module (the R3 adaptation halved the poll-loop
patch), or the feature moves wholly into payload. Deliberate divergences
are declared, never discovered: `payload-adapted.txt` for content,
`coverage-exclusions.txt` for undelivered files — both with reasons inline.

## Caveats

- PRs based on the seam branch always show a red environmental check
  (upstream's `ci.yml` uses `setup-node`, broken on Forgejo Actions; the
  seam carries no Forgejo workflow by design). Verification = local
  battery; the machine gate is the pin-bump PR's compose CI.
- `forkRef` is transitional: when `channels-webchat` retires, the guard's
  reference becomes the last fork tip, frozen.

Fork-era history: the original drift audit that seeded `patches/` lives at
[design/history-fork-drift-audit-2026-07.md](design/history-fork-drift-audit-2026-07.md).
