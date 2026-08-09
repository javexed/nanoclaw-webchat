# Upstream drift — how the two-repo model tracks nanoclaw

This repo never forks nanoclaw. It composes two pinned build inputs
(`versions.json`):

| Pin | What | Moves when |
|---|---|---|
| `upstreamRef` | `nanocoai/nanoclaw` main | upstream releases (nightly sync finds it) |
| `seamRef` / `seamBranch` | `pub/module-hooks` — the hook-seam branch (upstream + 13 additive commits) | a seam PR merges, or upstream moves and the seam rebases |

A third pin, `forkRef`, is **not a build input**. It records the final
`channels-webchat` tip (fork decommissioned 2026-07-28, preserved as
`forkArchiveTag`), and its only consumer is `scripts/migrate-from-fork.sh`,
which resolves it inside a user's own fork install to refuse migrating an
install newer than the split.

## How drift is caught

`scripts/check-manifest.sh` runs on every push (CI) and before every pin bump
(locally — non-negotiable, learned the hard way). It needs no external
reference. Full detail: [docs/coverage-guards.md](https://github.com/javexed/nanoclaw-webchat/blob/main/docs/coverage-guards.md)
(contributor doc — lives in the source repo, not in an install).

It keeps `app-manifest.txt` in step with the app tree. The manifest is not what
delivers files (`install.sh` overlays the tree wholesale), but it *is* what
selects migrations for registration: a `src/db/migrations/*.ts` file with no
exact entry ships into installs and never runs, with a green suite. It also
drives `compose-dev.sh`, so an uncovered file makes the dev tree diverge from
what ships. `check-manifest.selftest.sh` proves it still rejects each fault.

A fork-diff guard (`check-coverage.sh`) ran alongside it until 2026-07-28. It
retired with `channels-webchat`: both of its passes assumed a fork that still
moved, and its adapted-file list would have grown until it flagged everything.
The gap this leaves is stated in
[docs/coverage-guards.md](https://github.com/javexed/nanoclaw-webchat/blob/main/docs/coverage-guards.md#what-is-left-uncovered).

Unknown refs fail loudly (an unresolvable ref once read as "0 differing
files, OK"). This server refuses raw-SHA fetches once a pin is no longer a
branch tip — fetch the branch, then `git cat-file -e <pin>` to assert the
commit arrived (`install.sh` does this).

## The update cycle

Exercised end-to-end when upstream absorbed container hardening (#2748):

1. **Nightly sync** (`webchat-split-sync.sh`) finds the new upstream tip and
   opens a pin-bump PR here. It replaced the fork-era sync that merged upstream
   into `channels-webchat`, retired with the fork on 2026-07-28.
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
patch), or the feature moves wholly into the app tree. Each patch's destiny is
declared, never discovered — see [patches/INVENTORY.md](https://github.com/javexed/nanoclaw-webchat/blob/main/patches/INVENTORY.md)
for which are bound upstream, which await a seam registry, and which are local.

## Caveats

- PRs based on the seam branch always show a red environmental check
  (upstream's `ci.yml` uses `setup-node`, broken on some Actions runners; the
  seam carries no private-runner workflow by design). Verification = local
  battery; the machine gate is the pin-bump PR's compose CI.
- `forkRef` is no longer a guard reference or a build input — it survives only
  as the migration baseline for fork installs that have not moved across yet.
  The fork itself is preserved at the tag named by `forkArchiveTag`.

Fork-era history: the original drift audit that seeded `patches/` lives at
[design/history-fork-drift-audit-2026-07.md](design/history-fork-drift-audit-2026-07.md).
