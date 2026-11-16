#!/usr/bin/env bash
# Audit the composed tree's runtime dependencies for published advisories.
#
# GitHub's dependency scanning only sees this repo's own manifests (ui/). The
# host and agent-container dependencies arrive at compose time, from the
# pinned base and from install.sh, so nothing else ever audits them. This
# does, in the composed tree:
#
#   host       pnpm audit --prod   (the composed root)
#   container  bun audit           (container/agent-runner)
#
# Usage: check-deps-audit.sh <composed-dir> [--warn-only]
#
# Exit 1 when either tree has a high or critical advisory, unless --warn-only,
# which reports the same findings as warnings and exits 0. An audit that cannot
# run (registry unreachable, unexpected output) is reported and does not fail:
# this guard is about advisories, not about the registry's uptime.
#
# Self-test hooks: AUDIT_PNPM_JSON / AUDIT_BUN_JSON name files whose contents
# stand in for the two audits' JSON output (see check-deps-audit.selftest.sh).
set -uo pipefail

DIR="${1:-}"
WARN_ONLY=0
[ "${2:-}" = "--warn-only" ] && WARN_ONLY=1
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "usage: $0 <composed-dir> [--warn-only]" >&2; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "${AUDIT_PNPM_JSON:-}" ]; then
  cp "$AUDIT_PNPM_JSON" "$TMP/pnpm.json"
else
  (cd "$DIR" && pnpm audit --prod --json >"$TMP/pnpm.json" 2>"$TMP/pnpm.err")
fi
if [ -n "${AUDIT_BUN_JSON:-}" ]; then
  cp "$AUDIT_BUN_JSON" "$TMP/bun.json"
elif [ -d "$DIR/container/agent-runner" ]; then
  (cd "$DIR/container/agent-runner" && bun audit --json >"$TMP/bun.json" 2>"$TMP/bun.err")
else
  echo '{}' >"$TMP/bun.json"
fi

# pnpm: { advisories: { id: { module_name, severity, title, patched_versions, findings: [{ version }] } } }
# bun:  { "<package>": [ { severity, title, vulnerable_versions, url } ] }
node - "$TMP/pnpm.json" "$TMP/bun.json" "$WARN_ONLY" <<'JS'
const fs = require('fs');
const [pnpmFile, bunFile, warnOnly] = process.argv.slice(2);
const BAD = new Set(['high', 'critical']);
const level = warnOnly === '1' ? 'warning' : 'error';
let bad = 0;
let unreadable = 0;

function read(file, label) {
  const text = fs.readFileSync(file, 'utf8').trim();
  // bun prints a banner line before the JSON on some versions; take from the first brace.
  const start = text.indexOf('{');
  try {
    return JSON.parse(start >= 0 ? text.slice(start) : text);
  } catch {
    console.log(`::warning::${label} audit did not produce readable output; skipped`);
    unreadable++;
    return null;
  }
}

const pnpm = read(pnpmFile, 'host (pnpm)');
if (pnpm && pnpm.error) {
  console.log(`::warning::host (pnpm) audit could not run: ${pnpm.error.summary || pnpm.error.code || 'unknown error'}`);
  unreadable++;
} else if (pnpm) {
  for (const a of Object.values(pnpm.advisories || {})) {
    if (!BAD.has(a.severity)) continue;
    const versions = [...new Set((a.findings || []).map((f) => f.version))].join(', ');
    console.log(`::${level}::host: ${a.module_name}@${versions} — ${a.severity}: ${a.title} (fixed in ${a.patched_versions})`);
    bad++;
  }
}

const bun = read(bunFile, 'container (bun)');
if (bun) {
  for (const [pkg, list] of Object.entries(bun)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!BAD.has(a.severity)) continue;
      console.log(`::${level}::container: ${pkg} ${a.vulnerable_versions || ''} — ${a.severity}: ${a.title}`);
      bad++;
    }
  }
}

if (bad === 0) {
  console.log(`dependency audit: no high or critical advisories${unreadable ? ` (${unreadable} audit(s) skipped)` : ''}`);
  process.exit(0);
}
console.log(`dependency audit: ${bad} high/critical advisory finding(s)${warnOnly === '1' ? ' (warning only)' : ''}`);
process.exit(warnOnly === '1' ? 0 : 1);
JS
