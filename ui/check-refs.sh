#!/usr/bin/env bash
# Fail if any extracted module references an identifier it neither defines nor
# imports (TS2304 "Cannot find name").
#
# WHY A SEPARATE CHECK. The modules carved out of the composition root are TS now,
# and tsconfig keeps checkJs off — full type-checking untyped 19k-line-era code
# would be thousands of errors, so it buys nothing yet. But the ONE class of
# error that matters during extraction is exactly the one plain JS hides: a
# function moves to a module while the variable it reads stays behind. The
# bundler is happy, the build is happy, the e2e suite is happy — and the app
# throws ReferenceError the first time that path runs.
#
# That is not hypothetical. This check was written after `lucide` shipped
# unimported in features/voice.js (merged, green CI), and it immediately found
# four more in features/thinking.js: THINKING_DETAIL_MAX, agentName,
# forceScrollCount and userScrolledAway.
#
# So: run the compiler with checkJs ON, and fail on TS2304 only. Every other
# diagnostic is noise until the modules are converted to TypeScript proper.
#
# SUPERSEDES app/src/channels/webchat/app-integrity.test.ts, removed alongside
# this note. That test regex-scanned the BUILT BUNDLE for called-but-undeclared
# helpers, which meant it could only ever see call sites (`name(`) — a bare
# VARIABLE reference was invisible to it. Demonstrated rather than assumed: run
# against the bundle from 08f90a6, which carried a live `agentMcpServers is not
# defined` ReferenceError, it reported 2 passed. This check caught that bug.
# It also reads the SOURCE via tsc rather than pattern-matching output, so it
# sees scope, imports and shadowing instead of guessing at them.
set -uo pipefail
cd "$(dirname "$0")"
# The composition root IS included. It was excluded on the theory that untyped
# 19k-line code would be too noisy — but the filter here is TS2304 only, and it
# clean under it. Excluding it left the single largest file in the UI with NO
# undefined-identifier check at all: check:refs skipped it and the project
# typecheck has checkJs off. A 476-site state rewrite then shipped a bare
# `[...allAgents]` (a spread reads as member access, so the rename skipped it)
# straight past typecheck, this guard AND the build. It threw only when the
# agent list rendered, and cost half the e2e suite to find.
# .ts AND .js, both directories. The globs used to list only *.js under
# features/, which meant this guard silently LOST a file every time one was
# converted to TypeScript — coverage had shrunk from 20 files to 6 by the end of
# the conversion, without a single failing run to signal it. A guard whose scope
# is defined by a glob that the work itself invalidates is worse than one with a
# hard-coded list, because nothing ever goes red.
MODULES=$(ls src/core/*.ts src/core/*.js src/features/*.ts src/features/*.js src/boot.ts src/composition-root.ts 2>/dev/null || true)
[ -n "$MODULES" ] || { echo "  no modules to check"; exit 0; }

# The glob above is still a glob, so make its completeness self-checking rather
# than trusting it a third time. Every source file under src/ has to be covered
# by SOMETHING: this guard handles .ts/.js, and vue-tsc (pnpm run typecheck)
# handles .vue, where an undefined reference in a <script setup> block surfaces
# as the same TS2304. Anything else is a file no gate is looking at — which is
# how coverage was lost twice, both times silently. Fail loudly instead.
UNCOVERED=""
while IFS= read -r f; do
  case "$f" in
    src/main.ts) continue ;;                        # entry point, no exports to resolve
    *.d.ts) continue ;;                             # ambient declarations — no runtime code to reference
    *.vue) continue ;;                              # covered by vue-tsc in `typecheck`
  esac
  printf '%s\n' "$MODULES" | grep -qxF "$f" || UNCOVERED="$UNCOVERED$f"$'\n'
done < <(find src -type f \( -name '*.ts' -o -name '*.js' -o -name '*.vue' \) | sort)
if [ -n "$UNCOVERED" ]; then
  echo "✗ these source files are checked by NO guard — extend MODULES above:"
  printf '%s' "$UNCOVERED" | sed 's/^/    /'
  exit 1
fi
ALL=$(npx tsc --noEmit --allowJs --checkJs --target ES2022 --module ESNext \
        --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck \
        $MODULES 2>&1)

# Parse errors FIRST, and fatally. A file tsc cannot parse emits TS1xxx and no
# TS2304 at all — so a check that greps only for TS2304 reports a syntactically
# broken module as CLEAN. That is not hypothetical: an extraction script that
# moved only the first line of a multi-line `const X = {` produced exactly this,
# and the guard passed it. A guard that goes quiet on badly broken input is
# worse than no guard, so unparseable is its own loud failure.
SYNTAX=$(printf '%s\n' "$ALL" | grep -E "error TS1[0-9]{3}:" || true)
if [ -n "$SYNTAX" ]; then
  echo "❌ a module does not PARSE — the reference check could not run on it:"
  printf '%s\n' "$SYNTAX" | head -10 | sed 's/^/   /'
  exit 1
fi

# Three error codes, one defect: an identifier that does not exist.
#   TS2304  Cannot find name 'x'
#   TS2552  Cannot find name 'x'. Did you mean 'y'?
#   TS18004 shorthand property 'x' with nothing in scope
#
# TS2552 is TS2304 with a spelling suggestion attached — tsc emits it INSTEAD of
# TS2304 whenever a similar name happens to be in scope. Matching only 2304
# therefore missed exactly the cases most likely to occur during an extraction,
# where a near-miss neighbour is the norm: `wiredAgentsForCurrentRoom` was
# reported as 2552 (suggesting `refreshWiredAgentsForCurrentRoom`) and sailed
# through the gate while being a guaranteed runtime ReferenceError.
OUT=$(printf '%s\n' "$ALL" | grep -E "error (TS2304|TS2552|TS18004):" || true)
if [ -n "$OUT" ]; then
  echo "❌ undefined identifiers in extracted modules — something was left behind in the composition root:"
  printf '%s\n' "$OUT" | sed 's/^/   /'
  echo "   Fix by importing it, moving it into the module, or injecting it as a dep."
  exit 1
fi
echo "✅ no undefined identifiers in $(printf '%s\n' "$MODULES" | wc -l) extracted module(s)"
