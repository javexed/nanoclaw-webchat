#!/usr/bin/env bash
# Every required prop a component declares must actually be passed at its mount site.
#
# WHY THIS IS SEPARATE FROM check:deps. Same failure shape, different seam.
# check:deps guards the DI object (`deps.X` vs provide*Deps). This guards the Vue
# props object: `createApp(Component, { ... })`.
#
# Vue types the second argument as `Data | null` — a plain index signature — so
# vue-tsc compares it against NOTHING. A required prop that is never passed is
# `undefined` on `props`, and `props.foo(...)` throws only when that code path
# runs. Typecheck is silent, check:refs is silent (the NAME `props` is defined),
# the bundle builds, and e2e passes unless a test walks that exact path.
#
# Not hypothetical: RoomList declared `activityOf: (r) => number` and used it as
# the room sort comparator, but mountRoomList never passed it. Sorting threw on
# the first render that had rooms to sort, so the entire sidebar came up empty.
# It needed an AUTHENTICATED session with at least one room to reproduce, which
# is why every static gate and the unauthenticated boot-order trace stayed green
# all the way to production.
set -uo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
import re, glob, sys, os

def balanced(src, start):
    """Return the substring of the {...} or (...) group opening at `start`.
    Brace-COUNTING, not a regex: prop values are routinely arrow functions whose
    bodies contain their own braces and nested object literals, and a lazy regex
    stops at the first `}` inside one of those."""
    open_c = src[start]
    close_c = {'{': '}', '(': ')'}[open_c]
    depth, i, n = 0, start, len(src)
    in_s = None
    while i < n:
        c = src[i]
        if in_s:
            if c == '\\':
                i += 2; continue
            if c == in_s:
                in_s = None
        elif c in '"\'`':
            in_s = c
        elif c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return src[start + 1:i]
        i += 1
    return None

def top_level_keys(block):
    """Keys at depth 0 only. A nested handler like `onX: () => ({ y: 1 })`
    must not contribute `y` as though the mount site had passed it."""
    keys, depth, i, n, in_s = set(), 0, 0, len(block), None
    while i < n:
        c = block[i]
        if in_s:
            if c == '\\':
                i += 2; continue
            if c == in_s:
                in_s = None
            i += 1; continue
        if c in '"\'`':
            in_s = c; i += 1; continue
        if c in '{([':
            depth += 1; i += 1; continue
        if c in '})]':
            depth -= 1; i += 1; continue
        if depth == 0:
            m = re.match(r'(?:^|[\s,])([A-Za-z_$][\w$]*)\s*[:,\n]', block[i:])
            if m and (i == 0 or block[i - 1] in ' \t\n,'):
                keys.add(m.group(1))
                i += m.end() - 1; continue
            m = re.match(r'\.\.\.([A-Za-z_$][\w$]*)', block[i:])
            if m:
                keys.add('...'); i += m.end(); continue
        i += 1
    return keys

# ---- component prop requirements, keyed by component NAME -------------------
required, optional, has_defineprops = {}, {}, set()
for vf in sorted(glob.glob('src/**/*.vue', recursive=True)):
    name = os.path.basename(vf)[:-4]
    src = open(vf).read()
    m = re.search(r'defineProps<', src)
    if not m:
        continue
    br = src.find('{', m.end() - 1)
    if br < 0:
        continue
    block = balanced(src, br)
    if block is None:
        continue
    has_defineprops.add(name)
    # Strip comments and nested type-literal bodies so only top-level members count.
    block_nc = re.sub(r'/\*.*?\*/', '', block, flags=re.S)
    block_nc = re.sub(r'(?m)//[^\n]*$', '', block_nc)
    req, opt = set(), set()
    depth = 0
    for line in block_nc.split('\n'):
        stripped = line.strip()
        if depth == 0:
            mm = re.match(r'([A-Za-z_$][\w$]*)(\??)\s*:', stripped)
            if mm:
                (opt if mm.group(2) else req).add(mm.group(1))
        depth += line.count('{') + line.count('(') - line.count('}') - line.count(')')
    required[name], optional[name] = req, opt

bad = checked = skipped = 0
for f in sorted(glob.glob('src/**/*.ts', recursive=True)):
    src = open(f).read()
    # Blank the comment BODY but keep its newlines, so reported line numbers
    # still point at the real mount site. Collapsing a docblock silently slid
    # every subsequent report several lines up.
    src = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), src, flags=re.S)
    src = re.sub(r'(?m)^\s*//.*$', '', src)
    for m in re.finditer(r'createApp\(\s*([A-Za-z_$][\w$]*)\s*(,|\))', src):
        comp = m.group(1)
        if comp not in has_defineprops:
            continue
        req = required.get(comp, set())
        if not req:
            continue
        line = src[:m.start()].count('\n') + 1
        if m.group(2) == ')':
            passed = set()
        else:
            br = src.find('{', m.end() - 1)
            # `createApp(Comp, someVarOfProps)` — not an inline literal; skip
            # rather than guess, but only when no literal opens before the call ends.
            if br < 0 or src[m.end():br].strip() not in ('', '{'):
                skipped += 1
                continue
            block = balanced(src, br)
            if block is None:
                continue
            passed = top_level_keys(block)
        if '...' in passed:
            skipped += 1
            continue  # a spread may supply anything; cannot decide statically
        checked += 1
        miss = sorted(r for r in req if r not in passed)
        if miss:
            print(f"  ❌ {f}:{line}: <{comp}> requires but is never passed → {', '.join(miss)}")
            bad += 1

if bad:
    print(f"\n  {bad} mount site(s) missing required props")
    sys.exit(1)
# Report the denominator. A guard whose matcher quietly stops matching reports
# the same cheerful green as one that verified everything; the count is the
# difference between "checked 24 sites" and "checked 0 and said nothing".
print(f"  ✓ {checked} mount site(s) pass all required props ({skipped} not statically decidable)")
if checked == 0:
    print("  ❌ guard matched no mount sites at all — the matcher has drifted")
    sys.exit(1)
PY
