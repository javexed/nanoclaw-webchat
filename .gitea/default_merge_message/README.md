# Merge-message templates

These shape the SUBJECT of a merge commit. They were introduced to omit one
line the forge adds by default, which they do NOT do (see below):

    Reviewed-on: http://<internal-forge-host>:3000/...

This repository is GitHub-primary and its history is published. That trailer
names the private forge — an internal hostname and LAN address — inside a commit
*message*, which no tree-level scrub can reach once written. The leak gate
(`scripts/leak-scan.sh --range`) flags it, so every publish stalls until the
history is rewritten. Eleven such trailers accumulated before anyone noticed;
none reached the public mirror, because the gate caught them first.

Forgejo substitutes these templates for the SUBJECT line. Keep the <!-- leak-scan-allow -->
`${PullRequestTitle}` / `${PullRequestIndex}` / `${HeadBranch}` / `${BaseBranch}`
placeholders — dropping the index breaks the "which PR was this" trail that the
subject line is doing double duty for.

Do not add `Reviewed-on`, `Reviewed-by`, or any URL pointing at the forge.

## These templates do NOT suppress the trailer

Measured 2026-08-19, and the earlier claim on this page was wrong. The forge
appends the trailer AFTER rendering the template, so no template can remove it.
The proof is that the subject matches the template exactly while the body still
carries the line:

    template: Merge pull request '${PullRequestTitle}' (#${PullRequestIndex}) from ${HeadBranch} into ${BaseBranch}
    actual:   Merge pull request 'feat(agents): offer Grok in the harness picker' (#343) from feat/grok-harness-picker into main
    body:     Reviewed-on: http://<internal-forge-host>:3000/...

The templates still earn their place — they fix the subject, and without them the
built-in default is noisier — but they are not the trailer fix.

The count is now **35**, not the eleven this page reported. They kept accruing
because nothing was watching (see below).

## How to merge without adding one

**Use the rebase (or squash) merge style.** The trailer is attached only by the
MERGE-COMMIT style. Measured on this forge, same version, same day: six PRs
merged into `ProxmoxVED` `feat/nanoclaw` produced zero trailers, while every
merge-commit merge here produced one. The committer field is the tell —

    merge-commit style   author=<forge-bot>  committer=<forge-bot>@noreply.localhost  TRAILER
    rebase/squash style  author=<you>        committer=<you>@users.noreply...          clean

because merge-commit is the only style where the forge composes a new commit
message of its own. Rebase replays your commits unchanged, so there is nothing
for it to append to.

`default_merge_style` is now `rebase` for this repository, so the button
defaults to the safe style. Merge-commit is still ALLOWED — a merge that
genuinely needs a merge commit is a real thing — which is why the guard below
exists rather than relying on the default alone.

Rebase over squash, deliberately: squash would replace the commit message with
`SQUASH_TEMPLATE.md`, a single subject line with no body. The bodies in this
repository carry the reasoning, and losing them is a worse outcome than a
tidier graph. Rebase preserves each message verbatim. It also costs little in
graph shape here: 82 of 108 merged PRs were a single commit already.

Two consequences of rebase worth knowing:

  - Merged branches stop being ancestors of `main` (the commits are replayed
    with new SHAs), so `git branch --merged` will not list them.
    Auto-delete-on-merge is on, so they clean themselves up.
  - It is a genuine rebase, so a PR that conflicts with `main` must be updated
    before it can merge — the forge will not manufacture a merge commit to
    paper over it.

Merging locally and pushing also avoids the trailer, for the same reason (the
forge never composes the message). That is the fallback when a merge commit is
unavoidable:

```bash
git fetch <forge> main '<pr-branch>'
git checkout -B main <forge>/main
git merge --no-ff -m "Merge pull request '<title>' (#<n>) from <branch> into main" FETCH_HEAD
bash scripts/leak-scan.sh --range <forge>/main..HEAD   # must pass BEFORE the push
git push <forge> HEAD:main
```

A server-side change on the forge host is the third route. It was not available
here (no shell access to it), so it stays untried rather than recommended — and
with the merge style fixed it is no longer needed.

## Why 35 accumulated under a gate that checks for exactly this

`scripts/leak-scan.sh` has a `TRAILER_RE` and `mode_range` does check it — but
the workflow computes its range as `merge-base(origin/main, HEAD)..HEAD`. On a
push to `main`, HEAD *is* main, so that range is EMPTY and the merge commit is
never scanned. At PR time the merge commit does not exist yet. The one commit
that can carry a trailer is the one commit no run ever looked at.

`scripts/check-merge-trailers.sh` now closes that: it scans the actually-pushed
range on a push to main, which is the only moment the trailer is visible.
