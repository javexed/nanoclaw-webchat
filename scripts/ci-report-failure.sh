#!/usr/bin/env bash
# ci-report-failure.sh <job> — name the step a CI job failed at in a PR comment.
#
# Artifacts and the per-job log API are unavailable on some runners, so a red
# job is otherwise a status and a duration and nothing else. Each run step
# writes its own name to $RUNNER_TEMP/ci-step as its first line; this reports
# the last one to START (the one that died), plus failing test names and their
# assertions from the host-test log when there is one. Never changes the
# verdict: the caller runs it with continue-on-error.
#
# Env: FORGE_TOKEN (the job's token), RUNNER_TEMP, and the standard GITHUB_*.
JOB="${1:-compose}"
STEP="$(cat "$RUNNER_TEMP/ci-step" 2>/dev/null || echo '<none recorded — failed before the first run step>')"
echo "::error::$JOB failed at or after: $STEP"
CIENV="$(cat "$RUNNER_TEMP/ci-env" 2>/dev/null || echo 'not recorded')"
# Failing test names only — never the whole log. Enough to tell a real
# break from the boot-order/timeout flake without pasting a novel.
# STRIP ANSI FIRST, then match. vitest colours its output, so an
# anchored ^FAIL never matches a raw line — the first cut of this
# reported totals only and no test names, which is half a diagnosis.
CLEAN="$(mktemp)"
sed 's/\x1b\[[0-9;]*m//g' "$RUNNER_TEMP/host-tests.log" > "$CLEAN" 2>/dev/null || true
NAMES="$(grep -aE "^ *(FAIL|×|✕)|Test Files|^ *Tests " "$CLEAN" | sort -u | head -20)"
# Names say WHICH broke; the assertion says WHY. Without it, a red that
# does not reproduce locally costs a day of permutations — which is what
# setup/verify-slack.test.ts cost before this line existed.
# -A12 so the object diff that follows an AssertionError comes too:
# vitest elides the payload in the headline ("…(13)"), so the headline
# alone says two objects differ without saying in which field.
WHY="$(grep -a -A12 -E "AssertionError" "$CLEAN" | cut -c1-200 | head -60)"
EVIDENCE="$(printf '%s\n' "$NAMES"; [ -n "$WHY" ] && printf '%s\n%s\n' "--- why ---" "$WHY")"

if [ -z "${FORGE_TOKEN:-}" ]; then
  echo "::warning::No token available, so the failing step could not be posted to the PR."
  exit 0
fi
RUN_URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_NUMBER"
python3 - "$JOB" "$STEP" "$RUN_URL" "$CIENV" "$EVIDENCE" <<'PY' || echo "::warning::could not post the failure comment"
import json, os, sys, urllib.request, urllib.error
job, step, run_url, cienv, evidence = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
detail = ""
if evidence.strip():
    detail = "\n```\n%s\n```\n" % evidence.strip()
body = (
    "**%s failed at or after:** `%s`\n\n"
    "ran on: `%s`\n" % (job, step, cienv.replace("\n", " · ")) +
    detail +
    "\n[run %s](%s)\n\n"
    "<sub>Posted by the %s job because artifacts and the log API are "
    "unavailable on this runner. `uses:` steps are not instrumented, so a "
    "failure inside a setup or cache action reports the run step before it."
    "</sub>" % (os.environ["GITHUB_RUN_NUMBER"], run_url, job)
)
url = "%s/api/v1/repos/%s/issues/%s/comments" % (
    os.environ["GITHUB_SERVER_URL"], os.environ["GITHUB_REPOSITORY"],
    json.load(open(os.environ["GITHUB_EVENT_PATH"]))["pull_request"]["number"])
req = urllib.request.Request(
    url, data=json.dumps({"body": body}).encode(),
    headers={"Authorization": "token " + os.environ["FORGE_TOKEN"],
             "Content-Type": "application/json"}, method="POST")
try:
    urllib.request.urlopen(req, timeout=30)
    print("posted the failing step to the PR")
except urllib.error.HTTPError as e:
    print("HTTP %s: %s" % (e.code, e.read()[:200].decode()))
    sys.exit(1)
PY
