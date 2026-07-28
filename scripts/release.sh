#!/usr/bin/env bash
# release.sh — cut a nanoclaw-webchat release: compose, gate, pack, publish.
#
#   scripts/release.sh v2.3.0 [--dry-run] [--notes <file>]
#
# Produces ONE artifact — `nanoclaw-webchat-composed-<version>.tar.gz`, a
# ready-to-run composed install (upstream nanoclaw + hook seam + this app tree
# + residue patches, sources only) — and attaches it to a GitHub release on the
# public mirror. That asset is what downstream installers consume:
#
#   ProxmoxVED: fetch_and_deploy_gh_release "nanoclaw" "javexed/nanoclaw-webchat" \
#                 "prebuild" "latest" "/opt/nanoclaw" "nanoclaw-webchat-composed-*.tar.gz"
#   then:       bash deploy/webchat-deploy.sh --dir /opt/nanoclaw --port 3100
#
# Why a composed tarball and not the repo tarball: the repo alone would make
# every install clone nanoclaw and re-compose on the target. The composed
# artifact is the same thing the fork's releases used to be, so downstream
# flows keep working unchanged when channels-webchat retires.
#
# Runs on the HOST (not CI): publishing needs the javexed gh credential, which
# deliberately does not live in the runner. Same rule as the mirror publish.
#
# NOTE — the coverage guard's forkRef is transitional scaffolding. It asks
# "does the split still deliver everything the fork had?", which only has an
# answer while the fork exists. When channels-webchat is decommissioned, keep
# its archive tag fetchable (so releases stay gated on the last known-good
# comparison) or retire the fork half of the guard deliberately — do not let
# it degrade into a check that silently compares nothing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?usage: release.sh vX.Y.Z [--dry-run] [--notes <file>]}"; shift || true
DRY=0; NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift;;
    --notes) NOTES="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "version must look like v2.3.0" >&2; exit 2; }
PUBLIC=https://github.com/javexed/nanoclaw-webchat.git
ASSET="nanoclaw-webchat-composed-${VERSION}.tar.gz"

say() { printf '\033[1;36m[release]\033[0m %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "  DRY: $*"; else "$@"; fi; }

cd "$HERE"
# ── 1. preflight: clean tree on main, pins resolvable ───────────────────────
[ -z "$(git status --porcelain | grep -v '^??')" ] || { echo "working tree is dirty" >&2; exit 1; }
BR=$(git rev-parse --abbrev-ref HEAD)
# Releases come from main. --dry-run may run anywhere: its whole purpose is
# rehearsing the gates on a branch before the release is real.
if [ "$BR" != main ] && [ "$DRY" = 0 ]; then
  echo "release from main (on '$BR'); use --dry-run to rehearse elsewhere" >&2; exit 1
fi
git rev-parse "$VERSION" >/dev/null 2>&1 && { echo "tag $VERSION already exists" >&2; exit 1; }
UPSTREAM_REF=$(python3 -c "import json;print(json.load(open('versions.json'))['nanoclaw']['upstreamRef'])")
SEAM_REF=$(python3 -c "import json;print(json.load(open('versions.json'))['nanoclaw']['seamH5Ref'])")
FORK_REF=$(python3 -c "import json;print(json.load(open('versions.json'))['nanoclaw']['forkRef'])")
say "releasing $VERSION — upstream ${UPSTREAM_REF:0:9} · seam ${SEAM_REF:0:9}"

# ── 2. compose fresh ────────────────────────────────────────────────────────
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# Free space check BEFORE the gates. A compose + node_modules + both suites
# needs a few GB; under pressure the suites fail in scattered, misleading ways
# (measured: 4 unrelated test files "failed" at 92% full, all green after
# reclaiming). Fail with the real reason instead of a phantom red suite.
FREE_MB=$(df -Pm "$WORK" | awk 'NR==2 {print $4}')
[ "${FREE_MB:-0}" -ge 4096 ] || {
  echo "only ${FREE_MB}MB free on $(df -Ph "$WORK" | awk 'NR==2 {print $6}') — need >=4096MB." >&2
  echo "Low disk makes the suites fail in scattered, misleading ways. Reclaim space and retry." >&2
  exit 1; }
say "composing (this is the artifact — it must build from pins alone)"
SKIP_CONTAINER_BUILD=1 bash "$HERE/install.sh" --dir "$WORK/composed" >"$WORK/compose.log" 2>&1 || {
  tail -20 "$WORK/compose.log"; echo "compose FAILED — not releasing" >&2; exit 1; }
grep -q "did not apply" "$WORK/compose.log" && { grep "did not apply" "$WORK/compose.log" >&2; echo "patch conflicts — not releasing" >&2; exit 1; }

# ── 3. gates: coverage + both suites, in the artifact itself ────────────────
say "coverage guard"
# The guard diffs against forkRef. That ref lives on the fork branch today and
# on its ARCHIVE TAG once channels-webchat is decommissioned — either way it
# must be fetchable, so a failure here is loud, never skipped (a guard that
# silently checks nothing is worse than no guard).
say "manifest integrity"
bash "$HERE/scripts/check-manifest.sh" \
  || { echo "manifest integrity FAILED — not releasing" >&2; exit 1; }

# forkRef is an INTERNAL reference: it pins a staging SHA, and the public
# mirror carries different SHAs because it is snapshot-published. The staging
# URL is deliberately NOT hardcoded here — this file ships publicly, and the
# mirror's leak gate rightly rejects an internal host in it. Maintainers set
# NANOCLAW_WEBCHAT_FORK_REPO (see nanoclaw-ops); everyone else never needs it,
# because the fork comparison is a transitional maintainer check.
FORK_SRC="${NANOCLAW_WEBCHAT_FORK_REPO:-}"
if ! git -C "$WORK/composed" cat-file -e "$FORK_REF" 2>/dev/null; then
  git -C "$WORK/composed" fetch -q "$FORK_SRC" 'refs/heads/channels-webchat:refs/remotes/relfork/channels-webchat' 2>/dev/null     || git -C "$WORK/composed" fetch -q "$FORK_SRC" 'refs/tags/*:refs/tags/*' 2>/dev/null || true
fi
git -C "$WORK/composed" cat-file -e "$FORK_REF" 2>/dev/null || {
  echo "forkRef ${FORK_REF:0:12} is not reachable — the coverage guard cannot run." >&2
  [ -n "$FORK_SRC" ] || echo "Set NANOCLAW_WEBCHAT_FORK_REPO to the staging remote that carries it." >&2
  echo "If channels-webchat has been archived, keep its archive tag reachable, or repin forkRef." >&2
  exit 1; }
bash "$HERE/scripts/check-coverage.sh" "$WORK/composed" "$SEAM_REF" "$FORK_REF" "$UPSTREAM_REF" \
  || { echo "coverage guard FAILED — not releasing" >&2; exit 1; }
say "host suite"
(cd "$WORK/composed" && pnpm exec tsc --noEmit && pnpm exec vitest run >"$WORK/vitest.log" 2>&1) \
  || { tail -15 "$WORK/vitest.log"; echo "host suite FAILED — not releasing" >&2; exit 1; }
say "container suite"
(cd "$WORK/composed/container/agent-runner" && bun install --silent && bun run typecheck && bun test >"$WORK/bun.log" 2>&1) \
  || { tail -15 "$WORK/bun.log"; echo "container suite FAILED — not releasing" >&2; exit 1; }

# ── 4. pack (sources only — node_modules re-materialize on the target) ──────
say "packing $ASSET"
tar --exclude='./composed/node_modules' \
    --exclude='./composed/container/agent-runner/node_modules' \
    --exclude='./composed/.git' \
    -czf "$WORK/$ASSET" -C "$WORK" ./composed
SIZE=$(du -h "$WORK/$ASSET" | cut -f1)
# The artifact must carry the downstream entrypoint, or Proxmox installs break.
# NB: `grep -q` would exit early, SIGPIPE the tar, and — under `set -o pipefail`
# — turn a successful match into a failed pipeline. Count instead of short-circuit.
ENTRY_HITS=$(tar tzf "$WORK/$ASSET" | grep -c 'composed/deploy/webchat-deploy\.sh' || true)
[ "${ENTRY_HITS:-0}" -gt 0 ] \
  || { echo "artifact lacks deploy/webchat-deploy.sh — downstream installers would break" >&2; exit 1; }
say "artifact $SIZE, deploy entrypoint present"

# ── 5. tag + publish to the public mirror ──────────────────────────────────
BODY="${NOTES:+$(cat "$NOTES")}"
BODY="${BODY:-Composed install of nanoclaw-webchat.

Pins: upstream \`${UPSTREAM_REF:0:9}\` · seam \`${SEAM_REF:0:9}\`.

**Install:** download \`$ASSET\`, extract, then run
\`bash deploy/webchat-deploy.sh --dir /opt/nanoclaw --port 3100\`.
Gated on release: composed from pins, coverage guard, and both test suites.}"
# Tag staging on the real commit — internal history belongs there.
run git tag -a "$VERSION" -m "release $VERSION"
run git push -q forgejo "$VERSION"

# The PUBLIC mirror is snapshot-published (one commit, no history). Tagging it
# with staging's commit would push that commit AND ALL ITS ANCESTORS — leaking
# the full internal history into the public repo. Tag the mirror's OWN snapshot
# tip instead, after refreshing it so the tag names this exact tree.
say "refreshing the public snapshot before tagging it"
run bash "$HOME/nanoclaw-ops/webchat-mirror-sync.sh"
if [ "$DRY" = 0 ]; then
  git -c credential.helper= -c credential.helper='!gh auth git-credential' fetch -q "$PUBLIC" main
  SNAP=$(git rev-parse FETCH_HEAD)
  # Parity: the snapshot must be the tree we just gated, or the release would
  # advertise an artifact built from something else.
  [ "$(git rev-parse "$SNAP^{tree}")" = "$(git rev-parse main^{tree})" ] \
    || { echo "public snapshot tree != main tree — run the mirror sync and retry" >&2; exit 1; }
  git -c credential.helper= -c credential.helper='!gh auth git-credential' \
    push -q "$PUBLIC" "$SNAP:refs/tags/$VERSION"
  say "tagged the public snapshot ${SNAP:0:9} as $VERSION (no history pushed)"
else
  echo "  DRY: tag the PUBLIC snapshot tip as $VERSION (not staging's commit — that would push 90 commits of history)"
fi
if [ "$DRY" = 1 ]; then
  echo "  DRY: gh release create $VERSION --repo javexed/nanoclaw-webchat (asset: $ASSET)"
else
  gh release create "$VERSION" "$WORK/$ASSET#Composed install ($SIZE)" \
    --repo javexed/nanoclaw-webchat --title "nanoclaw-webchat $VERSION" --notes "$BODY" \
    || { echo "gh release create FAILED (tag is pushed; re-run just the release step)" >&2; exit 1; }
  say "verifying the asset is downloadable"
  gh release view "$VERSION" --repo javexed/nanoclaw-webchat --json assets \
    --jq '.assets[].name' | grep -q "$ASSET" || { echo "asset missing from the release" >&2; exit 1; }
fi
say "DONE — $VERSION published with $ASSET"
