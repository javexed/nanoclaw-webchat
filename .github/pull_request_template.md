## What and why

<!-- What changes, and the reasoning — including what you considered and ruled
     out. The diff already shows the "what". -->

## How it was verified

<!-- What YOU checked, beyond CI. Commands run, cases exercised, anything you
     could not test and why. -->

## Effect on existing installs

<!-- None / needs re-install / migration runs / config change. Say explicitly. -->

---

- [ ] Hooks installed (`scripts/install-hooks.sh`) — leak gate ran locally
- [ ] New files under `app/` have an `app-manifest.txt` entry
- [ ] Owned `src/*.ts` are prettier-clean
