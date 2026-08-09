#!/usr/bin/env bash
# release.sh — cut a nanoclaw-webchat release: compose, gate, pack, STAGE.
#
# Does NOT publish. Publishing to the public mirror is scripts/publish-release.sh,
# a separate command, because it force-pushes a snapshot to a public `main` and
# creates a GitHub release — an outward-facing step that needs its own yes.
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
# The release gate is: composed from pins, manifest integrity, both suites run
# inside the artifact. The old fork-diff coverage guard retired with
# channels-webchat (archived 2026-07-28) — it asked "does the split still
# deliver everything the fork had?", which stops having an answer once the fork
# stops moving. See docs/coverage-guards.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Where the internal tag goes. Defaults to the first remote that is not the
# public mirror, so this published file names no particular instance. Override
# with STAGING_REMOTE if a checkout has several private remotes.
STAGING_REMOTE="${STAGING_REMOTE:-$(git -C "$HERE" remote | grep -vx github | head -1)}"
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

# ── 3. gates: manifest + both suites, in the artifact itself ────────────────
say "manifest integrity"
bash "$HERE/scripts/check-manifest.sh" \
  || { echo "manifest integrity FAILED — not releasing" >&2; exit 1; }

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
run git push -q "$STAGING_REMOTE" "$VERSION"

# ── 6. STOP. Publishing to the public mirror is a SEPARATE command ──────────
# A javexed publish needs its own explicit yes — that is the standing rule, and
# it was being quietly carried inside "cut the release": the mirror step is a
# FORCE PUSH to a public `main`, with no PR and no review gate, and folding it
# into this script meant one instruction authorised it. Splitting restores the
# thing the rule is actually for — seeing the public step before it happens.
#
# The artifact is kept (not left in the auto-deleted temp dir) so publishing
# ships exactly the bytes these gates just passed, rather than a rebuild.
mkdir -p "$HERE/dist/releases"
KEEP="$HERE/dist/releases/$ASSET"
cp "$WORK/$ASSET" "$KEEP"
printf '%s' "$BODY" > "$HERE/dist/releases/$VERSION.notes.md"

say "STAGED — $VERSION is tagged on $STAGING_REMOTE and gated. NOTHING has been published."
echo ""
echo "  artifact : $KEEP ($SIZE)"
echo "  notes    : $HERE/dist/releases/$VERSION.notes.md"
echo ""
echo "  To publish to the PUBLIC mirror (snapshot push + tag + GitHub release):"
echo "      bash scripts/publish-release.sh $VERSION"
echo ""
