# Merge-message templates

These exist to omit ONE line forgejo adds by default: <!-- leak-scan-allow -->

    Reviewed-on: http://<internal-forge-host>:3000/...

This repository is GitHub-primary and its history is published. That trailer
names the private forge — an internal hostname and LAN address — inside a commit
*message*, which no tree-level scrub can reach once written. The leak gate
(`scripts/leak-scan.sh --range`) flags it, so every publish stalls until the
history is rewritten. Eleven such trailers accumulated before anyone noticed;
none reached the public mirror, because the gate caught them first.

Forgejo substitutes these templates instead of its built-in default. Keep the <!-- leak-scan-allow -->
`${PullRequestTitle}` / `${PullRequestIndex}` / `${HeadBranch}` / `${BaseBranch}`
placeholders — dropping the index breaks the "which PR was this" trail that the
subject line is doing double duty for.

Do not add `Reviewed-on`, `Reviewed-by`, or any URL pointing at the forge.
