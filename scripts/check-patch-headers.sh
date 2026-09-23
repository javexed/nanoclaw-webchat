#!/usr/bin/env bash
# Patch header format — every committed patch uses standard a/ b/ headers.
#
#   scripts/check-patch-headers.sh [root]
#
# A patch file is whatever `git diff` printed when it was regenerated, and git
# diff's output follows the regenerating person's config. Settings that are
# ordinary in a personal git config become committed defects:
#
#   diff.mnemonicPrefix  headers become c/… w/…. Still applies, but a regen under
#                        a different config flips them back — 12 commits of churn
#                        in this repo's history, 24 patches at the peak.
#   diff.noprefix        headers lose their prefix; git apply strips the first real
#                        path component and fails with "No such file or directory".
#   color.diff=always    ANSI escapes land inside the patch; it no longer applies.
#
# scripts/regen-patches.sh pins its diff format, so this guards what the pin
# cannot reach: a patch edited by hand, written by another tool, or regenerated
# by an older copy of the script.
#
# It also checks that each residue patch's header names the file its filename
# does. install.sh picks the file to restore after a failed apply from the patch
# NAME, so a mismatch restores the wrong file.
#
# Optional arg: a root to check instead of the repo (used by the self-test to
# run against fixture trees). Defaults to the repo root.
set -euo pipefail
HERE="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

python3 - "$HERE" <<'PYEOF'
import os, re, sys

here = sys.argv[1]
HEADER = re.compile(r'^diff --git a/(\S+) b/(\S+)$')
problems = []
checked = 0

def check(path, residue):
    global checked
    rel = os.path.relpath(path, here)
    raw = open(path, 'rb').read()
    if b'\x1b' in raw:
        problems.append(f"{rel}: contains ANSI escape codes (a colourised diff was written into it)")
        return
    lines = raw.decode('utf8', errors='replace').split('\n')
    if not any(l.startswith('diff --git ') for l in lines):
        problems.append(f"{rel}: no `diff --git` header")
        return
    checked += 1
    in_header, paths = False, []
    for i, l in enumerate(lines, 1):
        if l.startswith('diff --git '):
            m = HEADER.match(l)
            if m:
                paths.append(m.group(2))
            else:
                problems.append(f"{rel}:{i}: header is not `diff --git a/<path> b/<path>`: {l}")
            in_header = True
        elif l.startswith('@@'):
            # Hunk content can legitimately begin with --- or +++ (a removed line
            # starting "--", an added one starting "++"); only headers are checked.
            in_header = False
        elif in_header:
            if l.startswith('--- ') and not (l.startswith('--- a/') or l == '--- /dev/null'):
                problems.append(f"{rel}:{i}: `---` header is not `a/<path>` or /dev/null: {l}")
            if l.startswith('+++ ') and not (l.startswith('+++ b/') or l == '+++ /dev/null'):
                problems.append(f"{rel}:{i}: `+++` header is not `b/<path>` or /dev/null: {l}")
    if residue and paths:
        want = os.path.basename(path)[: -len('.patch')].replace('__', '/')
        wrong = sorted({p for p in paths if p != want})
        if wrong:
            problems.append(f"{rel}: header names {', '.join(wrong)} but the filename says {want}")

# Residue patches: same discovery as install.sh (any destiny folder, dotfiles included).
patches = os.path.join(here, 'patches')
if os.path.isdir(patches):
    for dest in sorted(os.listdir(patches)):
        d = os.path.join(patches, dest)
        if os.path.isdir(d):
            for n in sorted(os.listdir(d)):
                if n.endswith('.patch'):
                    check(os.path.join(d, n), True)

# Provider overlays: named for what they do, not for a file, so no name check.
overlays = os.path.join(here, 'overlays')
if os.path.isdir(overlays):
    for n in sorted(os.listdir(overlays)):
        if n.endswith('.patch'):
            check(os.path.join(overlays, n), False)

if problems:
    print("patch headers: FAIL", file=sys.stderr)
    for p in problems:
        print("  " + p, file=sys.stderr)
    print("  Regenerate with scripts/regen-patches.sh (it pins the format), or fix the header by hand.", file=sys.stderr)
    sys.exit(1)
print(f"patch headers OK: {checked} patch file(s), all a/ b/, no escape codes, names match paths")
PYEOF
