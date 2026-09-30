# Cold-spawn time-to-first-token

The cold path is: user message → router → session resolve → `spawnContainer` →
container boot (bun) → first poll → provider init (Claude Code SDK subprocess)
→ first token. On a warm Linux/Docker host the code-controlled part is roughly
1.6–2.9 s; the largest single step is the SDK's own startup (about 1–2 s warm,
several seconds on a cold page cache). Group init is already incremental, there
is no image pull on the spawn path, and the gateway round-trips are
~100–200 ms combined. The two real levers were the cold page cache and bun
re-transpiling the SDK on every spawn.

## Implemented

- **Startup image warmer** (`src/container-warm.ts`, called from
  `src/index.ts`). The first spawn after a host restart or image rebuild used to
  pay the whole cold-disk bill. At service start one fire-and-forget throwaway
  container (`--network none`, `--memory 1g`, `--rm`, install-labelled so
  orphan cleanup reaps a straggler) imports the agent-runner module graph and
  runs `claude --version`, faulting in the pages the first turn needs. Cost:
  under a second, off the critical path; typical saving on the first message:
  2–7 s. Per-group images are built `FROM` the base, so warming the base warms
  their shared layers.
- **Persistent bun transpiler cache.** `BUN_RUNTIME_TRANSPILER_CACHE_PATH`
  points at `/home/node/.claude/.bun-transpiler-cache` on the per-group
  `.claude-shared` mount, so the SDK bundles are parsed once per group instead
  of on every spawn (~130 ms saved per spawn). When that mount is absent the path
  is an in-container dir and behaviour is unchanged.

## Dead ends (don't retry without new evidence)

- **`NODE_COMPILE_CACHE`** for the CLI — `claude` is a native binary; there is
  no JS compile to cache.
- **Overlapping provider init with the first inbound read** — the first poll is
  immediate, so there is nothing to overlap.
- **Lazy-loading the NanoClaw MCP server** — ~100–150 ms, and it is the agent's
  core tool surface.
- **Making group init incremental** — it already is.

## Deferred

- **Caching `ensureAgent`** saves under 150 ms but, if the gateway agent is
  deleted externally, would turn every spawn into a refusal loop until the cache
  expires. Revisit only if the gateway becomes remote.
- **A pre-created container pool** would cut `docker run` (~0.5–0.75 s) but
  conflicts with per-spawn mount arguments and orphan cleanup.
- **Warming after per-group image rebuilds** — the base warm already covers the
  shared layers.

Container security flags, session-DB pragmas and `on_wake` semantics are out of
scope.
