# Contributing

Thanks for looking. This repo is small and opinionated; a few things about how
it is built will save you time before you open a PR.

## The shape of the repo

Webchat installs **NanoClaw as an unmodified dependency**, then composes an
install from three pinned inputs (see [README](README.md#how-its-built)). So
**where** a change goes matters more than usual:

| You want to change… | Edit | Not |
|---|---|---|
| Webchat's own code | `app/…` (pure additions, laid out in nanoclaw's tree shape) | a composed install |
| The browser UI (`app.js`) | **`ui/src/…`** — `app/public/webchat/app.js` is a BUILT artifact | editing the generated `app.js` |
| A nanoclaw-owned file | a patch under `patches/` (`scripts/regen-patches.sh`) | `app/` |
| Docs operators read in a running install | `app/docs/webchat/` — these ship | `docs/` |
| Docs about this repo | `docs/` — these do not ship | `app/docs/` |

`~/nanoclaw` (or wherever you installed) is a **build output**. Never edit it and
expect the change to persist — re-run `install.sh` after changing sources.

## The browser UI is built

`app/public/webchat/app.js` is **generated** from `ui/src/` by Vite and committed
to the repo (same filename, no content hash — `index.html` and `sw.js` reference
it by name). Editing the generated file directly will be reverted by the next
build, and CI's bundle-drift guard fails the PR either way.

```bash
pnpm --dir ui install
pnpm --dir ui run build                      # regenerate the committed bundle
pnpm --dir ui run dev                        # rebuild on save while working
pnpm --dir ui run typecheck                  # ui/ is TypeScript
```

Commit the regenerated bundle together with your source change. The migration
out of the single-file era is in progress: `ui/src/legacy.js` is the original
monolith, and modules are being carved out of it into `ui/src/core/…` — prefer
adding new code as a module rather than growing `legacy.js`.

## Before you push: install the hooks

```bash
scripts/install-hooks.sh      # git config core.hooksPath .githooks
```

That wires two gates:

1. **Leak gate** (`pre-commit` + `pre-push`) — `scripts/leak-scan.sh` refuses
   commits/pushes containing secret-shaped strings or unlisted private
   addresses. It **fails closed**: a scanner error blocks too. If you are
   deliberately adding an example token or fixture address, mark that line with
   a `leak-scan-allow` comment — it is visible in review, which is the point.
2. **Freshness preflight** — refuses a push from a branch that is behind
   `main`, so your PR is a clean delta. Override for a WIP backup with
   `SKIP_PR_PREFLIGHT=1 git push …`.

Verify the gate is really installed rather than assuming:

```bash
bash scripts/leak-scan.sh --selftest    # 10/10
```

## What CI requires

`main` is protected: PRs only, and both checks must pass.

- **`leak-gate`** — the same scan as the hooks, plus a self-test. Unbypassable;
  `--no-verify` skips the hooks, not this.
- **`compose`** — the real gate. It composes a full nanoclaw+webchat tree from
  your branch against the pinned base + seam, then runs **both** suites in that
  composed tree (1,900+ tests), the manifest integrity guard, and a
  prettier-clean check on owned files.

Two failures that surprise people:

- **Manifest** — a new file under `app/` needs an entry in `app-manifest.txt`,
  or `compose-dev.sh` omits it while installs carry it. `scripts/check-manifest.sh`
  catches this; tests cannot.
- **Format** — `scripts/check-format.sh` gates owned `src/*.ts`. Run prettier
  before pushing.

## Pull requests

- Branch off current `main`; keep the PR a single coherent change.
- **Explain the why in the commit message.** This codebase leans on commit
  messages carrying the reasoning — a diff shows what changed, not what you
  ruled out.
- Include how you verified it. "Tests pass" is CI's job; say what *you* checked.
- A PR that changes behavior should say what happens to existing installs.

## Reporting things

Issues are open. For a bug, the useful minimum is: what you ran, what happened,
what you expected, and whether the install is fresh or upgraded. Redact tokens —
and note that `.env` in an install holds `WEBCHAT_TOKEN`.

## Security

Do not open a public issue for a vulnerability — use GitHub's
[private vulnerability reporting](https://github.com/javexed/nanoclaw-webchat/security/advisories/new)
so a fix can land before the details are public.
