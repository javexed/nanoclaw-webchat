#!/usr/bin/env bash
# nanoclaw-webchat installer — composes this repo's app tree onto a nanoclaw
# checkout. NanoClaw is a DEPENDENCY: this script fetches it, applies the hook
# seam, overlays the webchat app tree, applies residue patches, registers the
# barrels/migrations, installs pinned deps, and builds.
#
#   ./install.sh [--dir <path>] [--local] [--seam preinstalled] [--dry-run]
#
# Default --dir: /opt/nanoclaw when run as root (Proxmox LXC / server),
# $HOME/nanoclaw otherwise. --dir or NANOCLAW_DIR overrides.
#
# --local: don't stop at a built-but-unconfigured tree — after composing, hand
# off to the shared turnkey (deploy/webchat-deploy.sh --localhost), which builds,
# installs the OneCLI vault, writes a loopback-only .env, and starts a --user
# service. One command → a running, OneCLI-included install on 127.0.0.1.
#
# Seam modes (step 2):
#   default             — fetch + merge the seam ref pinned in versions.json.
#   --seam preinstalled — the checkout already carries the hook seam (the
#                         post-upstream-merge world): verify and skip.
#
# Dev/test env overrides:
#   NANOCLAW_WEBCHAT_BASE_REPO  clone source for nanoclaw (default: versions.json)
#   NANOCLAW_WEBCHAT_SEAM_REPO  fetch source for the seam  (default: versions.json)
#   SKIP_CONTAINER_BUILD=1      skip the agent-image rebuild (CI / tests)
#   SKIP_SQLITE_VERIFY=1        skip the native-binding boot check
#
# The compose mechanics (guarded 3-way patches, idempotent barrel appends,
# auto-derived migration registration, provider overlays) are ported from
# nanoclaw's install-webchat.sh, where they are production-proven.
set -euo pipefail

# Default target dir — explicit --dir (below) or NANOCLAW_DIR always wins.
# Otherwise: system-wide /opt for root (Proxmox LXC / server installs run as
# root and are unaffected), user-local $HOME/nanoclaw for a non-root desktop
# where /opt isn't writable.
if [ -n "${NANOCLAW_DIR:-}" ]; then
  DIR="$NANOCLAW_DIR"
elif [ "$(id -u)" -eq 0 ]; then
  DIR="/opt/nanoclaw"
else
  DIR="$HOME/nanoclaw"
fi
SEAM_MODE="pinned"
DRY_RUN=0
NO_BUILD=0
LOCAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --seam) SEAM_MODE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-build) NO_BUILD=1; shift ;;   # compose only (dev loop: adapt → regen → build by hand)
    --local|--deploy) LOCAL=1; shift ;;  # after compose, run the localhost turnkey (build + OneCLI + config + service)
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\033[1;36m[nanoclaw-webchat]\033[0m %s\n' "$*"; }
jsonval() { python3 -c "import json,sys;d=json.load(open('$HERE/versions.json'));print(d$1)"; }

BASE_REPO="${NANOCLAW_WEBCHAT_BASE_REPO:-$(jsonval "['nanoclaw']['upstreamRepo']")}"
BASE_REF=$(jsonval "['nanoclaw']['upstreamRef']")
SEAM_REPO="${NANOCLAW_WEBCHAT_SEAM_REPO:-$(jsonval "['nanoclaw']['seamRepo']")}"
# Patches are generated against the FULL seam (incl. the routing seams
# commit), so that is the compose base. If upstream ever carries the seam,
# --seam preinstalled skips the fetch entirely.
SEAM_REF=$(jsonval "['nanoclaw']['seamH5Ref']")
SEAM_BRANCH="${NANOCLAW_WEBCHAT_SEAM_BRANCH:-$(jsonval "['nanoclaw']['seamBranch']")}"

say "Target: $DIR ($([ "$(id -u)" -eq 0 ] && echo root || echo "user $(id -un)"))"

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run: would compose onto $DIR (base $BASE_REF, seam $SEAM_MODE/$SEAM_REF)"
  exit 0
fi

# ── 1. The dependency: a nanoclaw checkout at the pinned ref ────────────────
if [ ! -d "$DIR/.git" ]; then
  say "Cloning nanoclaw @ ${BASE_REF:0:12} from $BASE_REPO"
  git clone --no-checkout "$BASE_REPO" "$DIR"
  git -C "$DIR" checkout -q "$BASE_REF"
else
  say "Using existing checkout at $DIR"
fi
cd "$DIR"

# ── 1b. Node runtime guard ───────────────────────────────────────────────────
# better-sqlite3 (pinned) ships PREBUILT binaries for the Node line nanoclaw
# targets (.nvmrc). On a newer Node, no prebuilt exists, the source build runs
# against incompatible V8 headers, and the whole install dies at deps with a
# cryptic compiler error. Enforce the .nvmrc major before any node/pnpm runs;
# auto-select it via mise when present, otherwise fail fast with the real cause.
REQUIRED_NODE_MAJOR="$(sed -E 's/^v//; s/\..*//' "$DIR/.nvmrc" 2>/dev/null | tr -dc '0-9')"
if [ -n "$REQUIRED_NODE_MAJOR" ]; then
  CURRENT_NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v//; s/\..*//')"
  if [ "$CURRENT_NODE_MAJOR" != "$REQUIRED_NODE_MAJOR" ] && command -v mise >/dev/null 2>&1; then
    say "Node ${CURRENT_NODE_MAJOR:-none} active, but nanoclaw needs Node $REQUIRED_NODE_MAJOR (.nvmrc) — selecting via mise"
    mise use "node@$REQUIRED_NODE_MAJOR" >/dev/null 2>&1 || true
    export PATH="$HOME/.local/share/mise/shims:$PATH"
    CURRENT_NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v//; s/\..*//')"
  fi
  if [ "$CURRENT_NODE_MAJOR" != "$REQUIRED_NODE_MAJOR" ]; then
    # Escape hatch for environments PROVEN to work on a different major. The
    # mismatch is a proxy for "better-sqlite3 has no usable binary here", and
    # the proxy is not exact: compose CI runs on the runner image's Node 24
    # against .nvmrc 22 and installs, verifies the native binding, and passes
    # both suites. Without an opt-out this guard fails a configuration that
    # demonstrably works, so CI sets NANOCLAW_ALLOW_NODE_MISMATCH=1.
    #
    # Deliberately opt-in, never automatic: on an unproven machine the cryptic
    # node-gyp death this guard exists to prevent is the likely outcome, so the
    # default stays a hard stop. The native-binding verification later in this
    # script is the real gate for anyone who sets it.
    if [ "${NANOCLAW_ALLOW_NODE_MISMATCH:-}" = 1 ]; then
      say "Node ${CURRENT_NODE_MAJOR:-none} != .nvmrc $REQUIRED_NODE_MAJOR — continuing (NANOCLAW_ALLOW_NODE_MISMATCH=1); the native-binding check still gates"
    else
      echo "ERROR: nanoclaw needs Node $REQUIRED_NODE_MAJOR (see $DIR/.nvmrc), but Node ${CURRENT_NODE_MAJOR:-none} is active." >&2
      echo "       Newer Node has no better-sqlite3 prebuilt and won't compile against its V8 headers." >&2
      echo "       Switch to Node $REQUIRED_NODE_MAJOR and re-run — e.g.  mise use node@$REQUIRED_NODE_MAJOR" >&2
      echo "       or  nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR" >&2
      echo "       If this Node is known to work here, set NANOCLAW_ALLOW_NODE_MISMATCH=1." >&2
      exit 1
    fi
  else
    say "Node $CURRENT_NODE_MAJOR OK (matches .nvmrc)"
  fi
fi

# ── 2. The hook seam ─────────────────────────────────────────────────────────
if [ "$SEAM_MODE" = "preinstalled" ]; then
  say "Seam: preinstalled — verifying the hook registries are present"
  grep -q "SEAM_API_VERSION" container/agent-runner/src/providers/hooks.ts 2>/dev/null || {
    echo "ERROR: --seam preinstalled but the checkout has no hook seam" >&2; exit 1;
  }
else
  say "Seam: fetching ${SEAM_REF:0:12} from $SEAM_REPO"
  git remote get-url nanoclaw-webchat-seam >/dev/null 2>&1 \
    || git remote add nanoclaw-webchat-seam "$SEAM_REPO"
  # Fetch the branch (this server refuses raw-SHA wants once the pin is no
  # longer the tip), then assert the pinned commit actually arrived.
  git fetch -q nanoclaw-webchat-seam "$SEAM_BRANCH"
  git cat-file -e "$SEAM_REF" 2>/dev/null || {
    echo "ERROR: pinned seamRef $SEAM_REF is not reachable from branch $SEAM_BRANCH" >&2; exit 1;
  }
  # The seam branch is upstream + additive commits, so from the pinned base
  # this is a fast-forward; from a diverged base, a merge (conflicts abort).
  git merge --no-edit "$SEAM_REF"
fi

# ── 3. Overlay the app tree (pure adds; webchat-owned files) ──────────────────
say "Overlaying app tree ($(grep -c . "$HERE/app-manifest.txt") paths)"
# cp -a, not rsync: the CI runner image ships without rsync, and a plain
# recursive copy is all the overlay needs (pure adds over a pristine tree).
cp -a "$HERE/app/." ./

# ── 4. Residue patches: guarded, reversible 3-way ───────────────────────────
CONFLICTS=()
# Patches live in destiny sub-folders (upstreamable/ product/ local/ — see
# patches/INVENTORY.md); the folder is documentation, application is uniform.
say "Applying $(ls "$HERE/patches"/*/*.patch | wc -l) residue patches"
for p in "$HERE/patches/"*/*.patch; do
  name="${p##*/}"
  if git apply --reverse --check "$p" 2>/dev/null; then
    echo "  = $name: already applied (skip)"
  elif git apply --3way "$p" 2>/dev/null; then
    echo "  → $name: applied"
  else
    git checkout HEAD -- "$(echo "$name" | sed 's/\.patch$//; s|__|/|g')" 2>/dev/null || true
    CONFLICTS+=("$name")
    echo "  !! $name: does not apply — left unchanged" >&2
  fi
done

# ── 4b. Pre-adaptation removals ──────────────────────────────────────────────
# See pre-adaptation-removals.txt — goes away with the adaptation pass.
if [ -f "$HERE/pre-adaptation-removals.txt" ]; then
  while IFS= read -r rel; do
    case "$rel" in ''|'#'*) continue ;; esac
    if [ -f "$rel" ]; then
      rm -f "$rel"
      echo "  → removed stranded seam file: $rel (pre-adaptation)"
    fi
  done < "$HERE/pre-adaptation-removals.txt"
fi

# ── 5. Channels barrel: idempotent append ────────────────────────────────────
if ! grep -qF "'./webchat/index.js'" src/channels/index.ts; then
  say "Registering channel adapter in src/channels/index.ts"
  echo "import './webchat/index.js';" >> src/channels/index.ts
else
  echo "  = channel adapter already registered (skip)"
fi

# ── 6. Migrations barrel: auto-derived registration ─────────────────────────
# Order comes from migrations-order.txt (owned by THIS repo — webchat owns its
# migrations); each symbol is checked independently so upgrades add only
# what's missing.
WEBCHAT_SYMBOLS=$(grep . "$HERE/migrations-order.txt")
TMPFILE=$(mktemp --suffix=.mjs)
cat > "$TMPFILE" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const SYMBOLS = process.env.WEBCHAT_SYMBOLS.trim().split(/\s+/);
const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');
let changed = false;
const IMPORT_BLOCK =
  `import {\n${SYMBOLS.map((s) => '  ' + s).join(',\n')},\n} from '../../channels/webchat/migration.js';`;
if (src.includes("from '../../channels/webchat/migration.js'")) {
  const before = src;
  src = src.replace(
    /import \{[^}]*\} from ['"]\.\.\/\.\.\/channels\/webchat\/migration\.js['"];/,
    IMPORT_BLOCK,
  );
  if (before !== src) changed = true;
} else {
  src = src.replace(/^(export )/m, IMPORT_BLOCK + '\n\n$1');
  changed = true;
}
const arrayMatch = src.match(/(const migrations: Migration\[\] = \[[\s\S]*?)\];/);
if (!arrayMatch) {
  console.error('migrations array not found — nanoclaw migrations/index.ts schema changed?');
  process.exit(1);
}
const missing = SYMBOLS.filter((s) => !arrayMatch[1].includes(s + ','));
if (missing.length > 0) {
  src = src.replace(
    /(const migrations: Migration\[\] = \[[\s\S]*?)\];/,
    '$1' + missing.map((s) => '  ' + s + ',\n').join('') + '];',
  );
  changed = true;
}
if (changed) {
  writeFileSync(target, src);
  console.log(`  → registered ${SYMBOLS.length} webchat migrations`);
} else {
  console.log('  = migrations already registered (skip)');
}
NODE_EOF
WEBCHAT_SYMBOLS="$WEBCHAT_SYMBOLS" node "$TMPFILE"
rm -f "$TMPFILE"

# ── 6a. File-based migrations from the app tree ───────────────────────────────
FILE_MIGRATIONS=()
while IFS= read -r p; do
  case "$p" in
    src/db/migrations/*.ts) [ -f "$p" ] && FILE_MIGRATIONS+=("$p") ;;
  esac
done < "$HERE/app-manifest.txt"
if [ "${#FILE_MIGRATIONS[@]}" -gt 0 ]; then
  TMPFILE2=$(mktemp --suffix=.mjs)
  cat > "$TMPFILE2" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const files = process.env.FILE_MIGRATIONS.trim().split(/\s+/);
const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');
let changed = false;
const arrayRe = /(const migrations: Migration\[\] = \[[\s\S]*?)\];/;
for (const file of files) {
  const body = readFileSync(file, 'utf8');
  const m = body.match(/export (?:const|function) ((?:migration|module)[0-9A-Za-z]+)\b/);
  if (!m) {
    console.error(`  ! ${file}: no exported migration symbol — skipping`);
    continue;
  }
  const sym = m[1];
  const rel = './' + file.replace(/^src\/db\/migrations\//, '').replace(/\.ts$/, '.js');
  const importLine = `import { ${sym} } from '${rel}';`;
  if (!src.includes(importLine)) {
    src = src.replace(/^(import .*\n)/m, `$1${importLine}\n`);
    changed = true;
  }
  const arr = src.match(arrayRe);
  if (arr && !new RegExp(`\\b${sym}\\b`).test(arr[1])) {
    src = src.replace(arrayRe, `$1  ${sym},\n];`);
    changed = true;
  }
}
if (changed) {
  writeFileSync(target, src);
  console.log(`  → registered ${files.length} file-based migration(s)`);
} else {
  console.log('  = file-based migrations already registered (skip)');
}
NODE_EOF
  FILE_MIGRATIONS="${FILE_MIGRATIONS[*]}" node "$TMPFILE2"
  rm -f "$TMPFILE2"
fi

# ── 7. Provider activity overlays (only when that provider is installed) ─────
PROVIDER_OVERLAYS=(
  "container/agent-runner/src/providers/codex.ts|codex-activity.patch|codex-activity.test.ts:container/agent-runner/src/providers/codex-activity.test.ts"
)
for entry in "${PROVIDER_OVERLAYS[@]}"; do
  IFS='|' read -r marker patch extra <<< "$entry"
  if [ ! -f "$marker" ]; then
    echo "  = ${patch}: provider not installed — skip"
    continue
  fi
  if git apply --reverse --check "$HERE/overlays/$patch" 2>/dev/null; then
    echo "  = ${patch}: already applied (skip)"
  elif git apply "$HERE/overlays/$patch" 2>/dev/null; then
    echo "  → ${patch}: applied"
  else
    CONFLICTS+=("$patch")
    echo "  !! ${patch}: does not apply — left unchanged" >&2
  fi
  if [ -n "${extra:-}" ]; then
    IFS=':' read -r esrc edst <<< "$extra"
    cp "$HERE/overlays/$esrc" "$edst" && echo "  → ${edst##*/}: installed"
  fi
done

if [ "$NO_BUILD" = 1 ]; then
  say "Compose complete (--skip-build) — deps/build/verify skipped."
  if [ "${#CONFLICTS[@]}" -gt 0 ]; then
    printf '!! %s did not apply\n' "${CONFLICTS[@]}" >&2; exit 1
  fi
  exit 0
fi

# ── 8. Pinned dependencies ────────────────────────────────────────────────────
# Native-build preflight: with the correct Node (guarded above) better-sqlite3
# installs a prebuilt binary and needs no compiler. If a prebuilt is ever
# missing (unusual arch/Node), npm falls back to `node-gyp rebuild`, which needs
# node-gyp + a C toolchain. Surface that dependency now so the fallback fails
# with a clear cause instead of "node-gyp: command not found".
if ! command -v node-gyp >/dev/null 2>&1; then
  _missing=""
  for _t in cc make python3; do command -v "$_t" >/dev/null 2>&1 || _missing="$_missing $_t"; done
  say "node-gyp not found — OK if prebuilt binaries are available; a source-build fallback would fail.${_missing:+ Also missing:$_missing}"
fi

# The MCP SDK ships client and server in one package and declares the server's
# HTTP stack as hard dependencies, so client-only consumers install it anyway.
# We import client/* exclusively (see mcp-probe.ts), which leaves ~4MB of
# unloadable Hono server code carrying its own advisories (GHSA-frvp-7c67-39w9,
# a Windows serve-static path traversal we cannot reach).
#
# pnpm overrides can only re-point a package, not drop one, so this uses a
# readPackage hook. Deliberately narrow: `express`/`cors` stay (no advisory,
# and express-rate-limit needs express regardless) and `jose` stays because
# client/auth-extensions.js loads it dynamically for OAuth private_key_jwt.
#
# The assumption this rests on -- that nothing imports an MCP *server* entry
# point -- is enforced by mcp-probe.test.ts, so a future server import fails in
# CI rather than at runtime.
if [ -e .pnpmfile.cjs ] && ! grep -q "nanoclaw-webchat: strip MCP server deps" .pnpmfile.cjs 2>/dev/null; then
  say "WARNING: .pnpmfile.cjs already exists and is not ours - leaving it alone."
  say "         The unused Hono server stack will remain installed."
else
  cat > .pnpmfile.cjs <<'PNPMFILE'
// nanoclaw-webchat: strip MCP server deps (managed by install.sh - see notes there)
const STRIP = ['hono', '@hono/node-server'];
function readPackage(pkg) {
  if (pkg.name === '@modelcontextprotocol/sdk' && pkg.dependencies) {
    for (const dep of STRIP) delete pkg.dependencies[dep];
  }
  return pkg;
}
module.exports = { hooks: { readPackage } };
PNPMFILE
fi

say "Installing webchat dependencies"
pnpm add ws@8.21.1 busboy@1.6.0 web-push@3.6.7 undici@7.29.0 @modelcontextprotocol/sdk@1.30.0
pnpm add -D @types/ws@8.18.1 @types/busboy@1.5.4 @types/web-push@3.6.4

if [ "${SKIP_SQLITE_VERIFY:-0}" != "1" ]; then
  say "Verifying better-sqlite3 native binding"
  node -e "new (require('better-sqlite3'))(':memory:').prepare('SELECT 1').get()" \
    || { echo "ERROR: better-sqlite3 native binding failed. On Node ${REQUIRED_NODE_MAJOR:-the target line} a prebuilt should install; a source-build fallback needs node-gyp + a C toolchain (make/cc/python3). Install those, or 'pnpm rebuild better-sqlite3'." >&2; exit 1; }
fi

# ── 8b. Local turnkey hand-off ───────────────────────────────────────────────
# --local: the compose is done and deps are in the lockfile; hand off to the
# shared turnkey deploy (deploy/webchat-deploy.sh, overlaid in step 3). It runs
# the build, setup:auto (agent image + OneCLI vault), a loopback-only .env
# (127.0.0.1, no token — the localhost auto-owner signs you in), the tripwire
# stamp, and a systemd --user service. `exec` replaces this process, so the
# normal build/tripwire below (steps 9–11) is skipped — the deploy owns them,
# and the agent image is built once (by setup:auto), not twice.
if [ "$LOCAL" = 1 ]; then
  if [ "${#CONFLICTS[@]}" -gt 0 ]; then
    echo "" >&2
    echo "!! ${#CONFLICTS[@]} patch(es) did not apply — aborting before the turnkey deploy:" >&2
    printf '   - %s\n' "${CONFLICTS[@]}" >&2
    exit 1
  fi
  [ -f "$DIR/deploy/webchat-deploy.sh" ] || {
    echo "ERROR: $DIR/deploy/webchat-deploy.sh missing — the app overlay is incomplete" >&2; exit 1;
  }
  say "Local turnkey → deploy/webchat-deploy.sh --localhost (build + OneCLI + loopback .env + --user service)"
  exec bash "$DIR/deploy/webchat-deploy.sh" --dir "$DIR" --localhost
fi

# ── 9. Build ──────────────────────────────────────────────────────────────────
say "Building host (tsc)"
pnpm run build
if [ "${SKIP_CONTAINER_BUILD:-0}" != "1" ]; then
  say "Rebuilding agent container image"
  ./container/build.sh
else
  echo "  = skipping container image rebuild (SKIP_CONTAINER_BUILD=1)"
fi

# ── 10. Surface conflicts ─────────────────────────────────────────────────────
if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  echo "" >&2
  echo "!! ${#CONFLICTS[@]} patch(es) did not apply cleanly:" >&2
  printf '   - %s\n' "${CONFLICTS[@]}" >&2
  echo "   The checkout has drifted from the pinned base — see versions.json." >&2
  exit 1
fi

# ── 11. Clear the fresh-install upgrade tripwire ─────────────────────────────
# A clean compose is a sanctioned install path, but nanoclaw's boot tripwire
# refuses to start until an upgrade marker records the current code version
# (a fresh install has none, so it reads "recorded: none" and halts). Stamp it
# here so first boot just works instead of demanding a manual
# `pnpm exec tsx scripts/upgrade-state.ts set`.
if [ -f scripts/upgrade-state.ts ]; then
  say "Stamping upgrade marker (sanctioned fresh install)"
  pnpm exec tsx scripts/upgrade-state.ts set >/dev/null 2>&1 \
    || echo "  !! could not stamp upgrade marker — if first boot halts on the tripwire, run: pnpm exec tsx scripts/upgrade-state.ts set" >&2
fi

say "Done. Enable with WEBCHAT_ENABLED=true (see docs/webchat/install.md in the composed tree)."
