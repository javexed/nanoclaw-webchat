# Coverage guards

One guard protects the property that nothing we own silently fails to ship:
[`check-manifest.sh`](../scripts/check-manifest.sh). It needs no external
reference, so it cannot decay.

A second guard, `check-coverage.sh`, compared the composed tree against the
pre-split fork. **It was retired on 2026-07-28 when `channels-webchat` was
decommissioned** — see [below](#why-the-fork-guard-was-retired) for why, and
what that leaves uncovered.

## What the manifest actually governs

Worth stating because it is easy to assume otherwise: **`app-manifest.txt` is
not the delivery mechanism.** `install.sh` overlays the app tree wholesale
(`cp -a app/. ./`), so a file with no manifest entry still ships.

Three other things read it, and each fails *silently* when it disagrees with
the tree:

1. **Migration registration.** `install.sh` finds file-based migrations by
   walking the manifest for `src/db/migrations/*.ts` entries, then registers
   them into `src/db/migrations/index.ts`. A migration file with no **exact**
   entry is copied into the install and never registered — it ships and never
   runs. Nothing else catches this: the suite is green and the schema is simply
   missing at runtime. A covering *directory* entry does not help; the match is
   line-by-line. This is the highest-severity check in the script, and it is
   live: the `byok-*` → `module-user-credentials-*` rename touched five of these
   files, and a missed entry would have silently disabled them.
2. **The dev tree.** `compose-dev.sh` symlinks manifest paths only. A file with
   no covering entry is present in a real install but absent from the dev
   compose tree — so the tree you run tests in diverges from the tree you ship.
3. **The ownership record.** The manifest is what a reviewer reads to answer
   "is this file ours or upstream's?". A dangling entry makes that record lie.

## Proving the guard still works

[`check-manifest.selftest.sh`](../scripts/check-manifest.selftest.sh) builds
throwaway fixture trees (never the repo's own) and asserts the guard **rejects**
each fault. It runs in CI ahead of the guard itself, because a guard only ever
observed to pass is not evidence that it works.

| Fixture | Expected |
|---|---|
| clean tree | passes |
| migration file with no exact entry | `NEVER REGISTERED` |
| migration covered only by a *directory* entry | `NEVER REGISTERED` — `install.sh` matches lines, not prefixes |
| file with no covering entry | `MISSING FROM DEV TREE` |
| entry with no file | `DANGLING` |

## Why the fork guard was retired

`check-coverage.sh` diffed the composed tree against `forkRef`
(`channels-webchat`) and required every differing file to be accounted for by
the manifest, a patch, an exclusion, or a recorded removal. It earned its keep
during extraction — it caught two real silent drops on day one (seam-consumer
files, `persistOnecliBindHost`) and two later content drifts.

Both of its passes assumed a **live** fork:

- **Name pass** — "does the split still carry everything the fork carries?"
  With the fork frozen, this asks about a product that stopped changing.
- **Content parity** — "did a fix land fork-side and miss the app tree?" That
  hazard exists only while two copies are maintained in parallel. With one
  copy it cannot happen.

Content parity would also have *decayed*, measurably. Every legitimate change
to the app tree diverges from a frozen reference, so `app-adapted.txt` grew
monotonically — 31 entries at freeze time, and it would have grown with every
normal week. A check that eventually flags everything flags nothing. Freezing
the reference was considered and rejected for exactly this reason.

Removed with it: `scripts/check-coverage.sh`, `app-adapted.txt`,
`coverage-exclusions.txt`. All recoverable from git history if ever needed.

### `forkRef` was kept

`forkRef` stays in `versions.json` despite the guard going away, because the
guard was not its only consumer: `scripts/migrate-from-fork.sh` resolves that
SHA **inside a user's own fork install** to refuse migrating an install that is
newer than the split (which would silently drop their changes). It needs no
remote — the commit is already in their history. Keep it pinned as long as fork
installs may still migrate.

The fork's final tip is preserved as the tag
`archive/channels-webchat-2026-07-28`, recorded in `versions.json` as
`forkArchiveTag`.

## What is left uncovered

Stated plainly rather than papered over.

**Nothing automatically detects a deleted or renamed app file that no longer
belongs to any manifest entry** — a doc or asset removed by hand, say. Source
deletions surface as build or test failures; docs and assets do not. This is
the one thing the fork guard did that has no direct successor. The residual
risk is small — one copy, one tree, reviewed PRs — but it is not zero.

What does still hold:

- **Compose** proves every patch in `patches/` applies to the pinned upstream
  and seam. A stale patch fails the build, not the release.
- **Manifest integrity** proves the manifest and the tree agree, so migrations
  register and the dev tree matches installs.
- **Both suites** (1,900+ tests) run inside the composed artifact rather than
  this repo's tree, so they exercise what actually ships.

One consequence worth knowing: with the ledger role gone, the manifest's only
*functional* job is migration registration — 12 of its 69 entries. The other 57
document ownership. Keeping them is fine; just don't mistake their presence for
an enforced guarantee.
