#!/usr/bin/env bash
# Coverage check: every file differing between the composed base (seam) and a
# reference fork tip must be accounted for by exactly one of:
#   app-manifest.txt  (delivered by overlay)
#   patches/              (delivered by 3-way patch)
#   coverage-exclusions.txt (deliberately not delivered, with a reason)
# Anything unaccounted is a silent drop — the class of bug this caught twice
# on day one (seam-consumer files, persistOnecliBindHost).
#
#   scripts/check-coverage.sh <git-dir-with-both-refs> <seam-ref> <fork-ref>
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
GITDIR="${1:?git dir}"; SEAM="${2:?seam ref}"; FORK="${3:?fork ref}"; UPSTREAM="${4:-}"

python3 - "$HERE" "$GITDIR" "$SEAM" "$FORK" "$UPSTREAM" <<'PYEOF'
import subprocess, sys
here, gitdir, seam, fork = sys.argv[1:5]
upstream = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

r = subprocess.run(['git', '-C', gitdir, 'diff', '--name-only', seam, fork],
                   capture_output=True, text=True)
if r.returncode != 0:
    # An unknown ref must be a loud failure — an empty diff here once read
    # as "coverage OK: 0 differing files" while checking nothing at all.
    print(f"ERROR: git diff {seam[:12]}..{fork[:12]} failed: {r.stderr.strip()}")
    sys.exit(2)
diff = r.stdout.split()

def load(path, strip_comments=True):
    out = []
    for line in open(path):
        t = line.split('#')[0].strip() if strip_comments else line.strip()
        if t: out.append(t)
    return out

app_paths = load(f'{here}/app-manifest.txt', strip_comments=False)
exclusions = load(f'{here}/coverage-exclusions.txt')
import os
patched = set()
for root, _dirs, files in os.walk(f'{here}/patches'):
    for n in files:
        if n.endswith('.patch'):
            patched.add(n[:-len('.patch')].replace('__', '/'))
removals = load(f'{here}/pre-adaptation-removals.txt')

upstream_blob_cache = {}
def matches_upstream(f):
    """True if the composed tree's f is byte-identical to the pinned upstreamRef —
    i.e. plain upstream advancement past the frozen forkRef, not webchat drift."""
    if not upstream:
        return False
    key = (upstream, f)
    if key not in upstream_blob_cache:
        a = subprocess.run(['git','-C',gitdir,'cat-file','-p',f'{upstream}:{f}'], capture_output=True)
        b = subprocess.run(['git','-C',gitdir,'cat-file','-p',f'HEAD:{f}'], capture_output=True)
        upstream_blob_cache[key] = (a.returncode==0 and b.returncode==0 and a.stdout==b.stdout)
    return upstream_blob_cache[key]

def accounted(f):
    if matches_upstream(f):
        return True
    if f in patched or f in exclusions or f in removals: return True
    for p in app_paths:
        if f == p or f.startswith(p.rstrip('/') + '/'): return True
    return False

missing = [f for f in diff if not accounted(f)]
if missing:
    print(f"UNACCOUNTED ({len(missing)}):")
    for f in missing: print("  ", f)
    sys.exit(1)

# Content parity: an app file the fork also carries must be byte-equal to
# the fork's copy unless listed in app-adapted.txt (where the composed
# side is canonical). Name-level accounting alone let the #369 frontend fix
# drift silently — app/ predated it and nothing noticed.
adapted = set(load(f'{here}/app-adapted.txt'))
drifted = []
for p in app_paths:
    import pathlib
    base = pathlib.Path(f'{here}/app') / p
    files = [p] if base.is_file() else [f'{p}/{q.relative_to(base)}' for q in base.rglob('*') if q.is_file()]
    for rel in files:
        if rel in adapted: continue
        show = subprocess.run(['git', '-C', gitdir, 'show', f'{fork}:{rel}'], capture_output=True)
        if show.returncode != 0: continue  # app-only file — fork never had it
        if show.stdout != open(f'{here}/app/{rel}', 'rb').read():
            drifted.append(rel)
if drifted:
    print(f"PAYLOAD CONTENT DRIFT ({len(drifted)}) — fork copy differs and the file is not in app-adapted.txt:")
    for f in drifted: print("  ", f)
    sys.exit(1)

print(f"coverage OK: {len(diff)} differing files all accounted "
      f"(app/patches/exclusions/removals); app content parity OK")
PYEOF
