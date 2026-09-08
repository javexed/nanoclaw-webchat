# Patch inventory — what each residue patch is, and where it should end up.
#
# patches/ holds webchat's edits to files NANOCLAW owns (files we own live in
# app/). Three sub-folders by DESTINY, so the ledger doubles as a work queue:
#
#   upstreamable/ — generic fixes and improvements with no webchat concept in
#                   them. Each is a candidate upstream PR; landing one DELETES
#                   its patch. This is where the residue shrinks fastest.
#   product/      — webchat features that still need a core touchpoint. These
#                   shrink when a seam registry absorbs them (H12 deleted three;
#                   R3 halved poll-loop), not by upstreaming.
#   local/        — install-local reality: fork-specific skill payloads, the
#                   OpenCode-removal reference sweep, ignore entries. Neither
#                   upstreamable nor a product feature; expected to persist.
#
# Regenerate a patch after editing a composed tree:
#   scripts/regen-patches.sh <composed-tree> <file> ...


## UPSTREAMABLE — candidate upstream PRs (68)

CLAUDE.md
    operator docs for the above
container/Dockerfile
    rtk (bash-output compression) baked in, arch-aware
container/agent-runner/package.json
    pin @anthropic-ai/claude-agent-sdk exactly instead of ^. This tree has no
    minimumReleaseAge policy (that is a pnpm-workspace setting and the
    agent-runner is a bun tree), so the caret was held only by bun.lock — one
    non-frozen install floats the SDK the runner is built against. Upstream's
    own CLAUDE.md already says to bump it deliberately and never `bun update`
    blindly; this makes the manifest say what the docs say. No lockfile change:
    bun.lock already resolved 0.3.197, so the caret was latitude nothing used.
src/providers/provider-container-registry.ts
    lacksMcpTools capability. NEGATIVE polarity on purpose: this registry is
    sparse (a provider with no host-side container needs never registers, and
    `claude` is exactly that), so absence must keep today's behaviour.
src/project-doc-compose.ts
    do not compose MCP tool documentation into the project doc of a group whose
    provider has no MCP client. Covers both the built-in module fragments and
    user-added external MCP servers; `cli` and `scheduling` survive the cut
    because they teach `ncl`, which rides the session DB rather than MCP.
src/project-doc-compose.test.ts
    coverage for the above, including the polarity (an unregistered or
    undeclared provider is unaffected)
container/agent-runner/src/destinations.ts
    do not describe the MCP messaging tools to a provider that has none. The
    prompt asserted `send_message` unconditionally; on a provider whose model
    cannot call it (pi, and any harness with its own fixed toolset) that is a
    promise the model spends the turn trying to keep — observed looping four
    times and answering nothing. Gated on the new AgentProvider.supportsMcpTools,
    so upstreaming this wants the types.ts hunk of the same name alongside it.
container/agent-runner/src/destinations.test.ts
    coverage for the above, both chat and task mode
container/agent-runner/src/formatter.test.ts
    tests for redaction
container/agent-runner/src/formatter.ts
    redact credential-shaped substrings before text reaches users
container/agent-runner/src/integration.test.ts
    origin-guard + lenient-output integration coverage
container/agent-runner/src/scheduling/task-script.test.ts
    concurrency regression coverage for the taskId path-collision fix
container/agent-runner/src/scheduling/task-script.ts
    fixed taskId script-path collision (2 concurrent callers sharing an id
    could clobber each other's script content or unlink each other's temp
    file); path now carries a random UUID
container/agent-runner/src/mcp-tools/index.ts
    per-module tool isolation
container/agent-runner/src/mcp-tools/server.ts
    shape guard for malformed tool definitions
container/agent-runner/src/providers/mock.ts
    richer mock descriptor for provider tests; declares supportsMcpTools
container/agent-runner/src/upload-trace.test.ts
    abort signal so the test loop is stoppable
pnpm-workspace.yaml
    dependency policy tweaks
scripts/skill-apply.test.ts
    tests for masking + gitless fallback; scratch dirs removed in afterAll
    (leaked ~200 tmpdirs per run)
scripts/skill-apply.ts
    secret masking in logged commands + gitless (tarball) deploy fallback
src/guard/guard.ts
    guard decisions emitted to the audit log (pairs with the overlay's
    src/audit.ts — an upstream PR carries both)
vitest.config.ts
    setupFiles: audit-log redirection for tests (pairs with vitest.setup.ts)
setup/auto.ts
    headless no-TTY setup (cloud-init/CI) instead of aborting on stdin EOF
setup/index.ts
    provider-install step registration
setup/lib/skill-driver.test.ts
    scratch dirs removed in afterAll (leaked ~20 tmpdirs per run, cleaned none)
setup/lib/skill-driver.ts
    logCmd seam: prompted secrets never land in the raw setup log
setup/channels/run-channel-skill.test.ts
    scratch dirs removed in afterAll
setup/channels/whatsapp.test.ts
    engage-config scratch dir removed in afterAll
setup/onecli.test.ts
    tests for the bind-host persistence; its scratch dir removed in afterAll
setup/onecli.ts
    persist ONECLI_BIND_HOST so `docker compose up` cannot drop the gateway to loopback
setup/service.test.ts
    tests for the PATH fix
setup/service.ts
    /snap/bin on the service PATH so snap CLIs (tailscale) resolve
container/agent-runner/src/mailbox/registry.test.ts
    make the unreadable-context test uid-independent. It wrote the file with
    mode 0o000 so the read would fail; root (CI containers) bypasses that, read
    it fine, and the test asserted the opposite of its intent. Spies Bun.file for
    that one path so json() rejects with EACCES regardless of uid.
scripts/update/transaction.e2e.test.ts
    make the partial-snapshot test uid-independent. It planted an unreadable
    file with chmod 0o000 to force copyEntry to throw; CI containers run as
    root, which bypasses permission bits, so the copy succeeded and the test
    asserted the opposite of what it meant. Spies fs.copyFileSync for that one
    path instead — same technique as remove.test.ts below.
setup/uninstall/remove.test.ts
    failure injection via spy — root in CI bypasses chmod bits
src/backfill-container-configs.ts
    backfill for the extended config columns
src/cli/resources/destinations.ts
    destination-change refresh: force active sessions to see the new map (silent-bug path)
src/cli/resources/groups.test.ts
    tests for FK-aware deletion
src/cli/resources/groups.ts
    FK-aware group deletion for module-installed tables
src/container-runner.test.ts
    tests for the container hardening policy
src/container-runner.ts
    root-host chown, user-skills mount, memory cap default, bun cache, output-token ceiling, per-group egress
src/container-runtime.test.ts
    tests for the runtime helpers (which live in app/src/container-runtime-extras.ts — they were
    a patch into upstream's container-runtime.ts until 2026-09-06; the seam no longer touches that
    file and neither do we)
src/db/agent-groups.ts
    lifecycle status setter with validation
src/db/db-v2.test.ts
    test-row shape for the extended container config
src/db/sessions.ts
    non-destructive pending-approval claim + TTL sweep feed
src/egress-lockdown.ts
    per-group host-only egress alongside the install-wide flag
src/group-init.ts
    rtk bash-output compression hook; upstream memory-reconcile coexistence
src/host-sweep.test.ts
    tests for the sweep fixes
src/host-sweep.ts
    bloated-continuation self-heal + sweep hygiene
    reproduction test for the a2a self-loop
src/modules/agent-to-agent/agent-route.ts
    a2a self-loop guard (the production message-flood fix)
src/modules/agent-to-agent/message-gate.test.ts
    self-loop guard coverage
src/modules/agent-to-agent/write-destinations.test.ts
    tests for the destination projection
src/modules/agent-to-agent/write-destinations.ts
    project destinations into running sessions (no restart needed)
src/modules/approvals/onecli-approvals.ts
    recover agent group from a non-group OneCLI external identifier
src/modules/approvals/primitive.ts
    approver fan-out: every eligible admin gets the card, first response wins
src/modules/approvals/response-handler.test.ts
    tests for the double-fire guard
src/modules/approvals/response-handler.ts
    double-fire guard on the approve path (slow handler tempts a second click)
    respawn ALL of a group's sessions after install/mcp change, not just one
src/mailbox/model.ts
    add the 'interrupt' inbound kind — the webchat stop button writes a control
    row of that kind (trigger=false, never wakes a container) and the runner's
    poll loop consumes it to abort a live turn. Without the kind in the union the
    feature's own comparisons were dead code that failed the container typecheck.
container/agent-runner/src/mailbox/model.generated.ts
    the same change, byte-identical: `pnpm mailbox-model:check` cmp's the two
    copies, so this patch must always mirror src/mailbox/model.ts exactly.
src/reconcile-session.ts
    UTC-safe claim-timestamp parsing (SQLite stamps carry no zone, so Date.parse
    read them as local and the claim-stuck check killed fresh claims on a
    non-UTC host), plus the bloated-continuation self-heal: after two ceiling
    kills that produced no output, clear the stored continuation so the next
    turn starts fresh. Was in host-sweep.ts until upstream moved the sweep
    decision logic here.
src/router.ts
    agent lifecycle gate (active/paused/archived) + prime negative-lookahead
src/session-manager.ts
    chown session dirs AFTER DB creation (root-host EACCES)
src/templates/create-agent.test.ts
    test timeout for slow CI runners
src/templates/local-dir.ts
    listLocalTemplates() — enumerate a local template library (plugin.json is
    the discovery marker, manifest read best-effort). Upstream has this logic
    in setup/templates.ts, which is OUTSIDE the compiled tree, so no shipped
    consumer can list templates; anything offering a template picker needs it.
src/types.ts
    agent-group lifecycle status type

## PRODUCT — shrink via seam registries (26)

container/agent-runner/src/config.ts
    lenientOutput + learning config surface read by the runner
container/agent-runner/src/index.ts
    module imports (status feed, learning, send-file hint); the prompt addendum
    is built after the provider so it can consult supportsMcpTools
container/agent-runner/src/mcp-tools/cli.instructions.md
    agent-facing CLI instructions
container/agent-runner/src/mcp-tools/core.instructions.md
    agent-facing core instructions
container/agent-runner/src/poll-loop.test.ts
    coverage for the poll-loop product behaviour
container/agent-runner/src/poll-loop.ts
    interrupt handling, lenient output, origin guard, terminal-error surfacing, empty-turn net
container/agent-runner/src/plugin-mcp.ts
    structural narrowing so the sse remote variant fits upstream's plugin resolve
container/agent-runner/src/providers/cwd-shim.ts
    structural narrowing for the sse remote variant
container/agent-runner/src/providers/claude.ts
    thinking/reasoning stream taps, restricted-review support, rate-limit classification
container/agent-runner/src/providers/types.ts
    provider capability flags (supportsRestrictedReview, memory scaffold, settings
    scopes, supportsMcpTools)
container/skills/onecli-gateway/SKILL.md
    secret intake points at the webchat Agents → Secrets UI, not the OneCLI dashboard
eslint.config.js
    lint rules for the webchat PWA frontend
src/channels/adapter.ts
    senderAgentGroupId for a2a loop-back attribution
src/channels/channel-registry.ts
    thread the producing session/agent through the adapter
src/container-config.ts
    egress/learning/lenient config plumbing + MCP remote-transport union
src/container-config.test.ts
    regression test: egress reaches container.json (it silently did not)
src/db/container-configs.ts
    egress + learning columns
src/modules/approvals/index.ts
    approval-TTL expiry on the sweep seam
src/modules/index.ts
    module barrel registrations
src/modules/self-mod/request.ts
    structural narrowing for the sse remote variant in the approval card path
src/templates/mcp.ts
    structural narrowing for the sse remote variant in plugin lint
src/modules/typing/index.test.ts
    tests for the typing attribution
src/modules/typing/index.ts
    agentName on the typing indicator (multi-agent rooms)

## LOCAL — install-local, expected to persist (6)

.claude/skills/add-codex/SKILL.md
    points the codex payload at this fork's providers-codex branch
.claude/skills/add-karpathy-llm-wiki/llm-wiki.md
    OpenCode-removal reference sweep
.claude/skills/add-mnemon/SKILL.md
    OpenCode-removal reference sweep
.claude/skills/customize/SKILL.md
    OpenCode-removal reference sweep
.claude/skills/update-skills/SKILL.md
    OpenCode-removal reference sweep
.gitignore
    ignore entries for composed-install artifacts, PLUS an upstreamable hunk:
    `data/` anchored to `/data/`. Unanchored, it matches any directory named
    data at any depth — including templates/data/, one of four first-party
    template categories, which is therefore invisible to git in every install
    that keeps its template library in-tree. Filed here, not in upstreamable/,
    only because a file gets ONE patch and the rest of this one is local.
