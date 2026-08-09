#!/usr/bin/env bash
# Manifest integrity — the fork-free guard.
#
#   scripts/check-manifest.sh
#
# app-manifest.txt is NOT the delivery mechanism for installs: install.sh
# overlays the app tree wholesale (`cp -a app/. ./`). But three other things
# do read it, and each fails SILENTLY when it disagrees with the tree:
#
#   1. MIGRATIONS  install.sh registers file-based migrations by walking the
#      manifest for `src/db/migrations/*.ts` entries. A migration file with no
#      exact manifest entry is copied into the install and never registered —
#      it ships and never runs. No test catches this; the schema is simply
#      missing at runtime. This is the highest-severity check here.
#
#   2. DEV TREE    compose-dev.sh symlinks manifest paths only. A file with no
#      covering entry is present in a real install but ABSENT from the dev
#      compose tree — so the tree you run tests in diverges from the tree you
#      ship.
#
#   3. LEDGER      the manifest is the record of what the app tree owns, which
#      is what a reviewer reads to answer "is this file ours?". A dangling
#      entry makes that record lie.
#
# This needs no external reference, which is why it outlived the fork-diff
# coverage guard it replaced (retired with channels-webchat, 2026-07-28).
# See docs/coverage-guards.md.
# Optional arg: a root to check instead of the repo (used by the self-test to
# run against fixture trees). Defaults to the repo root.
set -euo pipefail
HERE="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

python3 - "$HERE" <<'PYEOF'
import os, sys
here = sys.argv[1]
app = os.path.join(here, 'app')

entries = [l.split('#')[0].strip() for l in open(os.path.join(here, 'app-manifest.txt'))]
entries = [e for e in entries if e]
entry_set = set(entries)

def covered(rel):
    for m in entries:
        if rel == m or rel.startswith(m.rstrip('/') + '/'):
            return True
    return False

uncovered, migrations, total = [], [], 0
for root, dirs, files in os.walk(app):
    dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]
    for f in files:
        rel = os.path.relpath(os.path.join(root, f), app)
        total += 1
        if rel.startswith('src/db/migrations/') and rel.endswith('.ts'):
            migrations.append(rel)
        if not covered(rel):
            uncovered.append(rel)

# A migration needs an EXACT entry — install.sh matches `src/db/migrations/*.ts`
# against manifest lines, so a covering directory entry does not register it.
unregistered = [m for m in migrations
                if m not in entry_set and not m.endswith('index.ts')]
dangling = [m for m in entries if not os.path.exists(os.path.join(app, m))]

bad = False
if unregistered:
    bad = True
    print(f"NEVER REGISTERED ({len(unregistered)}) — migration files with no exact")
    print("manifest entry. These ship into installs and never run:")
    for u in sorted(unregistered):
        print("   ", u)
if uncovered:
    bad = True
    print(f"MISSING FROM DEV TREE ({len(uncovered)}) — no covering manifest entry, so")
    print("compose-dev.sh omits them while installs carry them:")
    for u in sorted(uncovered)[:40]:
        print("   ", u)
    if len(uncovered) > 40:
        print(f"    … and {len(uncovered)-40} more")
if dangling:
    bad = True
    print(f"DANGLING ({len(dangling)}) — manifest entries with no file:")
    for d in sorted(dangling):
        print("   ", d)
if bad:
    sys.exit(1)
print(f"manifest OK: {total} files under app/, {len(entries)} entries, "
      f"{len(migrations)} migrations all registered, none dangling")
PYEOF
