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


## UPSTREAMABLE — candidate upstream PRs (53)

CLAUDE.md
    operator docs for the above
container/Dockerfile
    rtk (bash-output compression) baked in, arch-aware
container/agent-runner/src/db/messages-out.ts
    getMaxOutboundSeq — empty-turn detection primitive
container/agent-runner/src/formatter.test.ts
    tests for redaction
container/agent-runner/src/formatter.ts
    redact credential-shaped substrings before text reaches users
container/agent-runner/src/integration.test.ts
    origin-guard + lenient-output integration coverage
container/agent-runner/src/mcp-tools/index.ts
    per-module tool isolation
container/agent-runner/src/mcp-tools/server.ts
    shape guard for malformed tool definitions
container/agent-runner/src/providers/mock.ts
    richer mock descriptor for provider tests
container/agent-runner/src/upload-trace.test.ts
    abort signal so the test loop is stoppable
container/cli-tools.json
    claude-code pin bump (2.1.219: first CLI with claude-opus-5)
pnpm-workspace.yaml
    dependency policy tweaks
scripts/skill-apply.test.ts
    tests for masking + gitless fallback
scripts/skill-apply.ts
    secret masking in logged commands + gitless (tarball) deploy fallback
setup/auto.ts
    headless no-TTY setup (cloud-init/CI) instead of aborting on stdin EOF
setup/index.ts
    provider-install step registration
setup/lib/skill-driver.ts
    logCmd seam: prompted secrets never land in the raw setup log
setup/onecli.test.ts
    tests for the bind-host persistence
setup/onecli.ts
    persist ONECLI_BIND_HOST so `docker compose up` cannot drop the gateway to loopback
setup/service.test.ts
    tests for the PATH fix
setup/service.ts
    /snap/bin on the service PATH so snap CLIs (tailscale) resolve
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
    tests for the runtime helpers
src/container-runtime.ts
    egress lockdown force mode + runtime helpers
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
src/index.ts
    prime the agent-image page cache so the first cold spawn is fast
src/modules/agent-to-agent/agent-route.test.ts
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
src/modules/self-mod/apply.test.ts
    tests for the multi-session self-mod fix
src/modules/self-mod/apply.ts
    respawn ALL of a group's sessions after install/mcp change, not just one
src/router.ts
    agent lifecycle gate (active/paused/archived) + prime negative-lookahead
src/session-manager.ts
    chown session dirs AFTER DB creation (root-host EACCES)
src/templates/create-agent.test.ts
    test timeout for slow CI runners
src/types.ts
    agent-group lifecycle status type

## PRODUCT — shrink via seam registries (17)

container/agent-runner/src/config.ts
    lenientOutput + learning config surface read by the runner
container/agent-runner/src/index.ts
    module imports (status feed, learning, send-file hint)
container/agent-runner/src/mcp-tools/cli.instructions.md
    agent-facing CLI instructions
container/agent-runner/src/mcp-tools/core.instructions.md
    agent-facing core instructions
container/agent-runner/src/poll-loop.test.ts
    coverage for the poll-loop product behaviour
container/agent-runner/src/poll-loop.ts
    interrupt handling, lenient output, origin guard, terminal-error surfacing, empty-turn net
container/agent-runner/src/providers/claude.ts
    thinking/reasoning stream taps, restricted-review support, rate-limit classification
container/agent-runner/src/providers/types.ts
    provider capability flags (supportsRestrictedReview, memory scaffold, settings scopes)
eslint.config.js
    lint rules for the webchat PWA frontend
src/channels/adapter.ts
    senderAgentGroupId for a2a loop-back attribution
src/channels/channel-registry.ts
    thread the producing session/agent through the adapter
src/container-config.ts
    egress/learning/lenient config plumbing + MCP remote-transport union
src/db/container-configs.ts
    egress + learning columns
src/modules/approvals/index.ts
    approval-TTL expiry on the sweep seam
src/modules/index.ts
    module barrel registrations
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
    ignore entries for composed-install artifacts
