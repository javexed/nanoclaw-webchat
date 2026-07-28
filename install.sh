#!/usr/bin/env bash
# nanoclaw-webchat installer — composes this repo's app tree onto a nanoclaw
# checkout. NanoClaw is a DEPENDENCY: this script fetches it, applies the hook
# seam, overlays the webchat app tree, applies residue patches, registers the
# barrels/migrations, installs pinned deps, and builds.
#
#   ./install.sh [--dir /opt/nanoclaw] [--seam preinstalled] [--dry-run]
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

DIR="${NANOCLAW_DIR:-/opt/nanoclaw}"
SEAM_MODE="pinned"
DRY_RUN=0
NO_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --seam) SEAM_MODE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-build) NO_BUILD=1; shift ;;   # compose only (dev loop: adapt → regen → build by hand)
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
say "Installing webchat dependencies"
pnpm add ws@8.20.0 busboy@1.6.0 web-push@3.6.7 undici@7.16.0 @modelcontextprotocol/sdk@1.29.0
pnpm add -D @types/ws@8.18.1 @types/busboy@1.5.4 @types/web-push@3.6.4

if [ "${SKIP_SQLITE_VERIFY:-0}" != "1" ]; then
  say "Verifying better-sqlite3 native binding"
  node -e "new (require('better-sqlite3'))(':memory:').prepare('SELECT 1').get()" \
    || { echo "ERROR: better-sqlite3 native binding failed — rebuild with 'pnpm rebuild better-sqlite3'" >&2; exit 1; }
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

say "Done. Enable with WEBCHAT_ENABLED=true (see docs/webchat/install.md in the composed tree)."
