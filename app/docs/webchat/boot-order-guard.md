# Boot-order guard

Verifying a UI refactor that moves wiring or bootstrap code needs two different checks, because they
catch different faults and neither subsumes the other.

## Why the listener-set diff is not enough

Every phase-4.1 slice is verified by recording each `addEventListener` call and
comparing the **set** of `(element id, event type)` pairs before and after. That
catches a moved listener that silently fails to attach — which happened for real
in 4.1g, where routing a wire-time call through `deps` lost 47 listeners while
`tsc`, `check:refs`, `check:deps` and the build were all green.

It is blind to **ordering**. Swap two `wireXPanel()` calls and the same
listeners still attach, so the set is identical and the diff reports nothing.
That matters because bootstrap code is precisely where order *is* the
correctness property: `state.settings = loadSettings()` running after something
that reads `state.settings` produces a correctly-wired, subtly wrong app.

Demonstrated, not assumed — swapping `wireApprovalsPanel()` and
`wireTranscriptPanel()`:

```
order guard : ✗ diverges at event 66
set diff    : none / none        ← completely blind
```

## What the trace records

`boot-trace.mjs` records a **sequence**, not a set, from a real browser load:

- every `addEventListener` call, in registration order
- every `fetch`, by path
- every `localStorage` / `sessionStorage` read, by key

Two bundles producing the same trace booted the same way. The trace is
deterministic: the same bundle traced twice yields 283 identical events.

## Running it

It is a CI gate. `scripts/check-boot-order.sh` serves `app/public/webchat` with
no backend (plus a stubbed first-run API) and compares against
`ui/boot-order.baseline.json` and `ui/boot-order.stubbed.json`; `--record`
accepts a deliberate change. `playwright` is pinned in `ui/package.json`.

For an ad-hoc trace against a running install (default `127.0.0.1:3100`):

```bash
# baseline: deploy main's bundle, then
pnpm --dir ui run trace:boot > /tmp/boot-main.json

# candidate: deploy the branch bundle, then
pnpm --dir ui run trace:boot > /tmp/boot-branch.json

pnpm --dir ui run trace:diff /tmp/boot-main.json /tmp/boot-branch.json
```

It reports the **first divergence** rather than a set difference, so the output
points at the event where the two boots parted company.

## When to use which

| change | listener-set diff | boot-order trace |
|---|---|---|
| moving a panel's wiring | required | recommended |
| moving bootstrap code | required | **required** |
| reordering anything at module scope | useless | **required** |
