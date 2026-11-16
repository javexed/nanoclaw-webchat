#!/usr/bin/env bash
# Proves check-deps-audit.sh still detects what it exists to detect. Fixture
# audit output only; never touches the network or a real tree.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/tree"
fail=0

clean_pnpm='{"advisories":{},"metadata":{"vulnerabilities":{"high":0,"critical":0}}}'
high_pnpm='{"advisories":{"1":{"module_name":"undici","severity":"high","title":"TLS bypass","patched_versions":">=7.30.1","findings":[{"version":"7.29.0"}]}}}'
low_pnpm='{"advisories":{"2":{"module_name":"left-pad","severity":"low","title":"meh","patched_versions":">=2","findings":[{"version":"1.0.0"}]}}}'
err_pnpm='{"error":{"code":"ENOTFOUND","summary":"registry unreachable"}}'
crit_bun='bun audit v1.3.12
{"@modelcontextprotocol/sdk":[{"severity":"critical","title":"DNS rebinding","vulnerable_versions":"<1.32.0","url":"x"}]}'

case_() { # name, pnpm json, bun json, extra arg, expected exit
  printf '%s' "$2" >"$T/p.json"
  printf '%s' "$3" >"$T/b.json"
  AUDIT_PNPM_JSON="$T/p.json" AUDIT_BUN_JSON="$T/b.json" bash "$HERE/check-deps-audit.sh" "$T/tree" $4 >"$T/out" 2>&1
  got=$?
  if [ "$got" = "$5" ]; then echo "ok   $1"; else echo "FAIL $1 (exit $got, want $5)"; cat "$T/out"; fail=1; fi
}

case_ "clean trees pass"                    "$clean_pnpm" '{}'        ""            0
case_ "host high advisory fails"            "$high_pnpm"  '{}'        ""            1
case_ "container critical advisory fails"   "$clean_pnpm" "$crit_bun" ""            1
case_ "low severity does not fail"          "$low_pnpm"   '{}'        ""            0
case_ "warn-only reports but passes"        "$high_pnpm"  "$crit_bun" "--warn-only" 0
case_ "unreachable registry does not fail"  "$err_pnpm"   '{}'        ""            0
case_ "garbage output does not fail"        "not json"    "nope"      ""            0

printf '%s' "$high_pnpm" >"$T/p.json"; printf '{}' >"$T/b.json"
AUDIT_PNPM_JSON="$T/p.json" AUDIT_BUN_JSON="$T/b.json" bash "$HERE/check-deps-audit.sh" "$T/tree" >"$T/out" 2>&1
if grep -q '::error::host: undici@7.29.0 — high: TLS bypass (fixed in >=7.30.1)' "$T/out"; then
  echo "ok   finding names package, version, severity and fix"
else
  echo "FAIL finding line missing detail"; cat "$T/out"; fail=1
fi

exit $fail
