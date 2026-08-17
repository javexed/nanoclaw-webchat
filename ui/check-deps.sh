#!/usr/bin/env bash
# Every deps.X a module uses must actually be supplied by its provide*Deps call.
#
# WHY THIS IS SEPARATE FROM check:refs. An injected dependency is a property
# lookup on a plain object. If the composition root never supplies it, `deps.foo` is
# `undefined` and the call throws only when that code path runs — typecheck is
# silent, check:refs is silent (the NAME `deps` is defined), the bundle builds,
# and e2e passes unless a test happens to walk that path.
#
# Not hypothetical: a cleanup pass that pruned "dead" wiring dropped a spread
# (`...roomStateDeps`) because a spread has no key to match on. That silently
# removed eight dependencies from features/threads and left provideThreadsDeps
# completely empty. Every static check still passed.
set -uo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
import re, glob, sys
root = open('src/composition-root.ts').read()
bad = 0
# .ts as well as .js: globbing only *.js meant this guard stopped seeing each
# module the moment it was converted, with no failing run to signal the loss.
for f in sorted(glob.glob('src/features/*.js') + glob.glob('src/features/*.ts')
                + glob.glob('src/core/*.js') + glob.glob('src/core/*.ts')):
    mod = f.split('/')[-1][:-3]
    src = open(f).read()
    # Strip comments first. A docblock that MENTIONS `deps.x` while explaining
    # the pattern is not a use of it — scanning raw text made ws.ts fail on its
    # own explanatory comment the moment this guard started covering .ts files.
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'(?m)^\s*//.*$', '', src)
    src = re.sub(r'(?m)\s//[^\n]*$', '', src)
    need = sorted(set(re.findall(r'deps\.([A-Za-z_$][\w$]*)', src)))
    if not need:
        continue
    # A kebab-case filename becomes PascalCase in the provider's NAME, so
    # select-toggle.ts is paired with provideSelectToggleDeps. Without this the
    # guard reports "no provide*Deps call found" for every hyphenated module —
    # which is what it did the first time one of them acquired a dep. It failed
    # loudly rather than passing, but the message pointed at the wrong thing.
    pascal = ''.join(w[:1].upper() + w[1:] for w in mod.split('-'))
    cand = ['provide' + mod.upper() + 'Deps',
            'provide' + mod[0].upper() + mod[1:] + 'Deps',
            'provide' + mod[0].upper() + mod[1:].rstrip('s') + 'Deps',
            'provide' + pascal + 'Deps',
            'provide' + pascal.rstrip('s') + 'Deps']
    m = None
    for fn in cand:
        m = re.search(re.escape(fn) + r'\(\{(.*?)\n\}\);', root, re.S)
        if m: break
    if not m:
        print(f"  ❌ {mod}: uses deps.* but no provide*Deps call found in the composition root"); bad += 1; continue
    block = m.group(1)
    sup = set(re.findall(r'(?:^|\s)([A-Za-z_$][\w$]*)\s*[:,]', block)) | set(re.findall(r'\.\.\.(\w+)', block))
    miss = [n for n in need if n not in sup]
    if miss:
        print(f"  ❌ {mod}: used but never supplied → {', '.join(miss)}"); bad += 1

    # THE OTHER DIRECTION: supplied but never DECLARED. Partial<XDeps> accepts
    # extra keys and TypeScript says nothing, so a value can be plumbed through
    # startup on every boot and dropped on the floor forever with every gate
    # green. The module cannot even read it — `deps.foo` is a type error the
    # moment anyone tries, which is how it stays invisible: nobody tries twice.
    #
    # Found getUserCredsState in features/members exactly this way: the root had
    # been supplying it since the module was extracted and the interface entry
    # was simply missing, so the panel wiring could not use it.
    im = re.search(r'(?ms)^(?:export )?interface \w*Deps \{(.*?)^\}', src)
    if im:
        declared = set(re.findall(r'(?m)^\s*([A-Za-z_$][\w$]*)\??\s*:', im.group(1)))
        explicit = set(re.findall(r'(?m)^\s*([A-Za-z_$][\w$]*)\s*:', block))
        extra = sorted(explicit - declared)
        if extra:
            print(f"  ❌ {mod}: supplied but never declared → {', '.join(extra)}")
            bad += 1
if bad:
    print("  These are undefined at runtime and throw only when the path executes.")
    sys.exit(1)
print("  ✅ every injected dependency is supplied")
PY
