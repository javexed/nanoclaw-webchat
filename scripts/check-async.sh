#!/usr/bin/env bash
# check-async.sh — does code we own drop a Promise on the floor?
#
#   scripts/check-async.sh <composed-tree>
#
# WHY THIS EXISTS. Upstream moved the central DB behind an async driver, and
# every call that used to return a value now returns a Promise. A missed await
# does not fail loudly: a write lands after the read that depends on it, a
# rejection escapes the try around it and becomes an unhandled rejection, a
# Promise in a response body serializes as {}, and an async filter predicate is
# always truthy. The composed tree's eslint config already names the rules that
# catch this, but nothing ever ran eslint, and dozens of these shipped.
#
# RULES. no-floating-promises and no-misused-promises only. await-thenable is
# left off: awaiting a value that is already sync is harmless.
#
# SCOPE IS DELIBERATE, as in check-format.sh. app/ files are ours in full. In a
# patched upstream file only the lines our patch adds count, so an upstream
# change can never turn this gate red. Container tests are skipped: the
# agent-runner tsconfig excludes them, so they have no type information.
set -uo pipefail

TREE="${1:?usage: check-async.sh <composed-tree>}"
HERE="${CHECK_ASYNC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
[ -d "$TREE" ] || { echo "not a directory: $TREE" >&2; exit 2; }
TREE="$(cd "$TREE" && pwd)"

# owned.tsv: <path>\t<added line numbers, comma-separated | * for the whole file>
OWNED="$(mktemp)"
trap 'rm -f "$OWNED" "$TREE/.eslint-async.config.js" "$TREE/.eslint-async.out"' EXIT
while IFS= read -r f; do printf '%s\t*\n' "${f#"$HERE/app/"}"; done \
  < <(find "$HERE/app/src" "$HERE/app/container" -name '*.ts' -type f 2>/dev/null) >> "$OWNED"
for p in "$HERE"/patches/*/*.patch; do
  [ -e "$p" ] || continue
  n="${p##*/}"; n="${n%.patch}"; f="${n//__//}"
  case "$f" in *.ts) ;; *) continue;; esac
  # New-file line numbers of every '+' line in the patch's hunks.
  lines="$(awk '
    /^@@ / { split($3, a, ","); ln = substr(a[1], 2) + 0; next }
    ln == 0 { next }
    /^\+/ { printf "%s%d", sep, ln; sep = ","; ln++; next }
    /^ / { ln++ }
  ' "$p")"
  [ -n "$lines" ] && printf '%s\t%s\n' "$f" "$lines" >> "$OWNED"
done

mapfile -t FILES < <(cut -f1 "$OWNED" | sort -u | while IFS= read -r f; do
  case "$f" in src/*.ts) ;; container/agent-runner/src/*.test.ts) continue;; container/agent-runner/src/*.ts) ;; *) continue;; esac
  [ -f "$TREE/$f" ] && echo "$f"
done)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "check-async: nothing owned to check" >&2
  exit 0
fi

# The config has to live in the tree: that is where typescript-eslint resolves.
cat > "$TREE/.eslint-async.config.js" <<'EOF'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'
export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // Registered only so the tree's existing disable comments resolve.
    plugins: { '@typescript-eslint': tseslint.plugin, 'no-catch-all': noCatchAll },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]
EOF

cd "$TREE" || exit 2
pnpm exec eslint --no-config-lookup -c .eslint-async.config.js -f json "${FILES[@]}" > .eslint-async.out 2> /dev/null
node - "$OWNED" "$TREE" .eslint-async.out <<'EOF'
const fs = require('fs');
const [owned, tree, out] = process.argv.slice(2);
const scope = new Map();
for (const row of fs.readFileSync(owned, 'utf8').split('\n').filter(Boolean)) {
  const [f, lines] = row.split('\t');
  const prev = scope.get(f);
  if (prev === '*' || lines === '*') scope.set(f, '*');
  else scope.set(f, new Set([...(prev ?? []), ...lines.split(',').map(Number)]));
}
let results;
try {
  results = JSON.parse(fs.readFileSync(`${tree}/${out}`, 'utf8'));
} catch {
  console.error('❌ async: eslint produced no report — run it by hand in the composed tree');
  process.exit(2);
}
const hits = [];
for (const r of results) {
  const f = r.filePath.slice(tree.length + 1);
  const lines = scope.get(f);
  for (const m of r.messages) {
    if (!m.ruleId) hits.push(`${f}: ${m.message.split('\n')[0]}`); // parse failure: can't vouch for the file
    else if (lines === '*' || lines?.has(m.line)) hits.push(`${f}:${m.line}  ${m.ruleId.replace('@typescript-eslint/', '')}`);
  }
}
if (hits.length === 0) {
  console.log(`async OK: ${results.length} owned file(s), no dropped Promises`);
  process.exit(0);
}
console.error('❌ async: a Promise is dropped (missing await, or async where a sync callback is expected):');
for (const h of hits) console.error(`     ${h}`);
console.error('\n   await it; or, if fire-and-forget is intended, `.catch(...)` it so a');
console.error('   rejection is logged. For a patched file, fix it in a composed tree and');
console.error('   regenerate: scripts/regen-patches.sh <composed-tree> <path>');
process.exit(1);
EOF
