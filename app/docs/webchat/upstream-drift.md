# Upstream drift — how the two-repo model tracks nanoclaw

This repo never forks nanoclaw. It composes two pinned build inputs
(`versions.json`):

| Pin | What | Moves when |
|---|---|---|
| `upstreamRef` | `nanocoai/nanoclaw` main | upstream releases |
| `seamRef` / `seamBranch` | `pub/module-hooks` — the hook-seam branch (upstream + 3 additive commits) | a seam PR merges, or upstream moves and the seam rebases |

## How drift is caught

`scripts/check-manifest.sh` runs on every push (CI) and must pass before every
pin bump. It keeps `app-manifest.txt` in step with the app tree — which is what
selects migrations for registration and what the dev compose tree is built
from. Full detail, including what is left uncovered since the fork-diff guard
retired: [docs/coverage-guards.md](https://github.com/javexed/nanoclaw-webchat/blob/main/docs/coverage-guards.md)
(a contributor doc in the source repo, not in an install).

Unknown refs fail loudly rather than reading as "no differences". The seam
server refuses raw-SHA fetches once a pin is no longer a branch tip, so fetch
the branch and then `git cat-file -e <pin>` to assert the commit arrived
(`install.sh` does this).

## The update cycle

1. **Upstream moves** and a pin-bump PR opens here.
2. **Seam rebase** onto the new upstream tip. Registries attach at stable
   points, so the seam commits rebase cleanly; only patch residue collides.
3. **This repo**: re-merge conflicting patches onto the new upstream shape,
   retire anything upstream absorbed, bump pins (guard first), PR, compose
   CI green.
4. **Refresh an install** when convenient: commit the composed tree, fetch it
   into the install's repo as a branch, flip, build, restart, smoke.

## The residue-shrink path

`patches/` only shrinks. A patch dies when upstream absorbs the fix, a seam
registry makes it expressible as a module, or the feature moves wholly into the
app tree. Each patch's destiny is
declared, never discovered — see [patches/INVENTORY.md](https://github.com/javexed/nanoclaw-webchat/blob/main/patches/INVENTORY.md)
for which are bound upstream, which await a seam registry, and which are local.

## Caveats

- The seam carries its own CI workflow in a separate workflows directory, so
  upstream's `.github/` stays untouched. The final gate is still the pin-bump
  PR's compose CI here.
