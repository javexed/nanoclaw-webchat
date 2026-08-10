#!/usr/bin/env bash
# Fail if any extracted module references an identifier it neither defines nor
# imports (TS2304 "Cannot find name").
#
# WHY A SEPARATE CHECK. The modules carved out of legacy.js are still plain JS,
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
set -uo pipefail
cd "$(dirname "$0")"
MODULES=$(ls src/core/*.ts src/core/*.js src/features/*.js 2>/dev/null | grep -v legacy || true)
[ -n "$MODULES" ] || { echo "  no modules to check"; exit 0; }
OUT=$(npx tsc --noEmit --allowJs --checkJs --target ES2022 --module ESNext \
        --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck \
        $MODULES 2>&1 | grep -E "error TS2304" || true)
if [ -n "$OUT" ]; then
  echo "❌ undefined identifiers in extracted modules — something was left behind in legacy.js:"
  printf '%s\n' "$OUT" | sed 's/^/   /'
  echo "   Fix by importing it, moving it into the module, or injecting it as a dep."
  exit 1
fi
echo "✅ no undefined identifiers in $(printf '%s\n' "$MODULES" | wc -l) extracted module(s)"
