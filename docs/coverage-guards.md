# Coverage guards

Two guards keep the split honest. They overlap today, deliberately — but only
one of them survives the fork's decommission.

| Guard | Asks | Reference it needs | Lifetime |
|---|---|---|---|
| [`check-manifest.sh`](../scripts/check-manifest.sh) | Does `app-manifest.txt` agree with the app tree? | none | permanent |
| [`check-coverage.sh`](../scripts/check-coverage.sh) | Did the split drop anything the fork had? | a live `forkRef` | transitional |

Both run in compose CI and in `release.sh`.

## What the manifest actually governs

Worth stating plainly, because it is easy to assume otherwise: **the manifest
is not the delivery mechanism.** `install.sh` overlays the app tree wholesale
(`cp -a app/. ./`), so a file with no manifest entry still ships.

Three other things read it, and each fails *silently* when it disagrees with
the tree:

1. **Migration registration.** `install.sh` finds file-based migrations by
   walking the manifest for `src/db/migrations/*.ts` entries, then registers
   them into `src/db/migrations/index.ts`. A migration file with no **exact**
   entry is copied into the install and never registered — it ships and never
   runs. Nothing catches this: the suite is green and the schema is simply
   missing at runtime. A covering *directory* entry does not help; the match is
   line-by-line. This is the highest-severity check in the script, and it is
   live: the recent `byok-*` → `module-user-credentials-*` rename touched five
   of these files, and a missed entry would have silently disabled them.
2. **The dev tree.** `compose-dev.sh` symlinks manifest paths only. A file with
   no covering entry is present in a real install but absent from the dev
   compose tree — so the tree you run tests in diverges from the tree you ship.
3. **The coverage ledger.** `check-coverage.sh` treats the manifest as the
   record of what the app tree owns. A dangling entry quietly widens what that
   guard considers accounted for.

The script is verified to **fail** on each shape, not merely to pass.
[`check-manifest.selftest.sh`](../scripts/check-manifest.selftest.sh) builds
throwaway fixture trees (never the repo's own) and asserts the guard rejects
each fault; it runs in CI ahead of the guard itself, because a guard only ever
observed to pass is not evidence that it works.

| Fixture | Expected |
|---|---|
| clean tree | passes |
| migration file with no exact entry | `NEVER REGISTERED` |
| migration covered only by a *directory* entry | `NEVER REGISTERED` — `install.sh` matches lines, not prefixes |
| file with no covering entry | `MISSING FROM DEV TREE` |
| entry with no file | `DANGLING` |

## Why the fork guard is transitional

`check-coverage.sh` compares the composed tree against `forkRef`
(`channels-webchat`) and requires every differing file to be accounted for by
the manifest, a patch, an exclusion, or a recorded removal. It earned its keep
during extraction — it caught two real silent drops on day one (seam-consumer
files, `persistOnecliBindHost`) and two later content drifts.

Both of its passes assume a **live** fork:

- **Name pass** — "does the split still carry everything the fork carries?"
  Once the fork is frozen this asks about a product that stopped changing.
- **Content parity** — "did a fix land fork-side and miss the app tree?" That
  hazard exists only while two copies are maintained in parallel. With one
  copy it cannot happen.

Content parity also *decays*, measurably. Every legitimate change to the app
tree diverges from a frozen reference, so `app-adapted.txt` grows
monotonically — 31 entries at freeze time, growing with every normal week. A
check that eventually flags everything flags nothing.

## Retiring the fork half

Sequencing matters: **do not remove the fork guard while the fork is live.**
While two copies exist, content parity is doing real work.

1. `channels-webchat` is decommissioned and archive-tagged.
2. Confirm `check-manifest.sh` is green in CI and in a release run.
3. Remove the `check-coverage.sh` steps from `.github/workflows/compose.yml`
   and `scripts/release.sh`; drop `forkRef` / `forkRefNote` from
   `versions.json`; retire `app-adapted.txt` and `coverage-exclusions.txt`.
4. The archive tag becomes optional history rather than a release dependency.

Until step 1 lands, `release.sh` correctly hard-fails when `forkRef` is
unreachable — an unrunnable guard must never look like a passing one.

## What is left uncovered after the swap

Be honest about the gap rather than assuming the manifest closes it.

After the fork guard retires, **nothing automatically detects a deleted or
renamed app file that no longer belongs to any manifest entry** — for example
a doc or asset removed by hand. Source deletions surface as build or test
failures; docs and assets do not. The residual risk is small (one copy, one
tree, reviewed PRs) but it is not zero, and it is the one thing the fork guard
did that has no direct successor.

What does still hold:

- **Compose** proves every patch in `patches/` applies to the pinned upstream
  and seam. A stale patch fails the build, not the release.
- **Manifest integrity** proves the manifest and the tree agree, so migrations
  register and the dev tree matches installs.
- **Both suites** (1,900+ tests) run inside the composed artifact rather than
  this repo's tree, so they exercise what actually ships.

One consequence worth noting for step 3: once the coverage ledger role is gone,
the manifest's only *functional* remaining job is migration registration —
12 of its 69 entries. The other 57 become documentation of ownership. Keeping
them is fine; just don't mistake their presence for an enforced guarantee.
