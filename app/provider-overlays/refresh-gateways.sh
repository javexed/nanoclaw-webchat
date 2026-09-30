#!/usr/bin/env bash
# Gateway refresh: bring an installed gateway skill's own files up to date with
# its payload. Run from the install root — by install.sh at compose time.
#
# A gateway skill (.claude/skills/*/gateway.json, e.g. add-onecli) installs its
# files with `nc:copy`, which never overwrites a file that exists. That is right
# for a first install and wrong for an upgrade: a composed tree carries the new
# payload, but the installed copies stay at whatever version was installed first.
# The files listed in the skill's `nc:copy` block belong to the skill, so an
# installed one that differs from the payload is replaced. Skills not installed
# (their first copy target absent) are left alone; appends, deps and setup steps
# are not re-run. Idempotent. Exits 1 if a copy fails.
set -uo pipefail

failed=0
for manifest in .claude/skills/*/gateway.json; do
  [ -f "$manifest" ] || continue
  skill="$(dirname "$manifest")"
  name="${skill##*/}"
  # The nc:copy block: "payload/… -> dest" lines between ```nc:copy and ```.
  pairs="$(awk '/^```nc:copy/{on=1; next} /^```/{on=0} on && / -> /' "$skill/SKILL.md" 2>/dev/null)"
  if [ -z "$pairs" ]; then
    echo "  = ${name}: no nc:copy block (skip)"
    continue
  fi
  first_dest="$(printf '%s\n' "$pairs" | head -1 | sed 's/.* -> //')"
  if [ ! -f "$first_dest" ]; then
    echo "  = ${name}: not installed (skip)"
    continue
  fi
  refreshed=0
  while IFS= read -r line; do
    src="$skill/${line%% -> *}"
    dest="${line##* -> }"
    case "$dest" in /* | *..*) echo "  !! ${name}: refusing destination ${dest}" >&2; failed=1; continue ;; esac
    [ -f "$src" ] || continue
    if [ -f "$dest" ] && cmp -s "$src" "$dest"; then continue; fi
    mkdir -p "$(dirname "$dest")" && cp "$src" "$dest" && refreshed=$((refreshed + 1)) || failed=1
  done <<< "$pairs"
  if [ "$refreshed" -gt 0 ]; then
    echo "  → ${name}: refreshed ${refreshed} file(s) from its payload"
  else
    echo "  = ${name}: up to date (skip)"
  fi
done
exit "$failed"
