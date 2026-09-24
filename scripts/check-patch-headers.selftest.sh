#!/usr/bin/env bash
# Self-test for check-patch-headers.sh.
#
#   scripts/check-patch-headers.selftest.sh
#
# A guard that has only ever been seen to pass is not evidence of anything.
# This writes throwaway fixture patches — a clean one, one per real fault shape,
# and the legitimate shapes that must NOT trip it — and asserts the guard's
# verdict on each. It never touches the repo's own patches/ or overlays/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$HERE/scripts/check-patch-headers.sh"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0

# mk <fixture> <dir-under-root> <patch-filename>   (patch body on stdin)
mk() {
  local root="$WORK/$1"; mkdir -p "$root/$2"
  cat > "$root/$2/$3"
  echo "$root"
}

expect() { # expect <want-rc> <name> <root> <want-substring>
  local want=$1 name=$2 root=$3 needle=$4 out rc
  out=$(bash "$GUARD" "$root" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$want" ] && grep -qF -- "$needle" <<<"$out"; then
    echo "  ok   $name"; PASS=$((PASS+1))
  else
    echo "  FAIL $name (rc=$rc want=$want)"; echo "$out" | sed 's/^/       /'
    FAIL=$((FAIL+1))
  fi
}

root=$(mk clean patches/product src__x.ts.patch <<'P'
diff --git a/src/x.ts b/src/x.ts
index 1111111..2222222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 0 "clean a/ b/ patch passes" "$root" "patch headers OK: 1 patch file(s)"

root=$(mk mnemonic patches/product src__x.ts.patch <<'P'
diff --git c/src/x.ts w/src/x.ts
index 1111111..2222222 100644
--- c/src/x.ts
+++ w/src/x.ts
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 1 "diff.mnemonicPrefix c/ w/ headers are caught" "$root" 'header is not `diff --git a/<path> b/<path>`'

root=$(mk noprefix patches/product src__x.ts.patch <<'P'
diff --git src/x.ts src/x.ts
index 1111111..2222222 100644
--- src/x.ts
+++ src/x.ts
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 1 "diff.noprefix headers are caught" "$root" 'header is not `diff --git a/<path> b/<path>`'

root="$WORK/ansi"; mkdir -p "$root/patches/product"
printf '\033[1mdiff --git a/src/x.ts b/src/x.ts\033[m\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,2 @@\n x\n+y\n' > "$root/patches/product/src__x.ts.patch"
expect 1 "ANSI escape codes from color.diff=always are caught" "$root" "contains ANSI escape codes"

root=$(mk badplus patches/product src__x.ts.patch <<'P'
diff --git a/src/x.ts b/src/x.ts
index 1111111..2222222 100644
--- a/src/x.ts
+++ w/src/x.ts
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 1 "a bad +++ header under a good diff --git line is caught" "$root" '`+++` header is not `b/<path>`'

root=$(mk mismatch patches/product src__x.ts.patch <<'P'
diff --git a/src/y.ts b/src/y.ts
index 1111111..2222222 100644
--- a/src/y.ts
+++ b/src/y.ts
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 1 "a header naming a different file than the patch name is caught" "$root" "but the filename says src/x.ts"

root=$(mk noheader patches/product src__x.ts.patch <<'P'
this is not a patch
P
)
expect 1 "a patch with no diff --git header is caught" "$root" 'no `diff --git` header'

# ---- legitimate shapes that must NOT trip it -------------------------------
root=$(mk hunklines patches/product src__x.ts.patch <<'P'
diff --git a/src/x.ts b/src/x.ts
index 1111111..2222222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,2 +1,2 @@
--- a removed line whose content starts with two dashes
+++ an added line whose content starts with two pluses
P
)
expect 0 "hunk lines that start with --- or +++ are not mistaken for headers" "$root" "patch headers OK"

root=$(mk newfile patches/product src__new.ts.patch <<'P'
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+y
P
)
expect 0 "a new-file patch with --- /dev/null passes" "$root" "patch headers OK"

root=$(mk dotfile patches/local .gitignore.patch <<'P'
diff --git a/.gitignore b/.gitignore
index 1111111..2222222 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 0 "a dotfile patch maps its name to its path" "$root" "patch headers OK"

root=$(mk overlay overlays codex-activity.patch <<'P'
diff --git a/container/agent-runner/src/providers/codex.ts b/container/agent-runner/src/providers/codex.ts
index 1111111..2222222 100644
--- a/container/agent-runner/src/providers/codex.ts
+++ b/container/agent-runner/src/providers/codex.ts
@@ -1,1 +1,2 @@
 x
+y
P
)
expect 0 "an overlay is not held to the residue naming rule" "$root" "patch headers OK"

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
