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


## UPSTREAMABLE — candidate upstream PRs (69)

setup/verify.ts
    exports CHANNEL_ENV_KEYS so a test can neutralise exactly the credential
    env vars that mark a channel configured. `has()` reads process.env before
    the install's .env, so an ambient GITHUB_TOKEN — every Actions runner sets
    one, as does any shell with `gh` — invents a github channel and fails five
    tests in setup/verify-slack.test.ts. Carried from upstream PR #3757 (open,
    all checks green, awaiting review). DELETE both this and the test patch
    when it merges.
setup/verify-slack.test.ts
    the other half of #3757: stubs those keys empty in beforeEach and calls
    vi.unstubAllEnvs() in afterEach, so the suite stops inheriting ambient env.
    Replaced the GITHUB_TOKEN="" workaround the compose workflow used to set.
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
    headless setup (NANOCLAW_HEADLESS=1: cloud-init/CI) instead of aborting on stdin EOF
setup/index.ts
    provider-install step registration
setup/providers/install.ts
    resolve the remote that actually carries the provider branch being copied,
    not whichever remote carries `channels`; falls back to the channels resolver
setup/lib/skill-driver.test.ts
    scratch dirs removed in afterAll (leaked ~20 tmpdirs per run, cleaned none)
setup/channels/run-channel-skill.test.ts
    scratch dirs removed in afterAll
setup/channels/whatsapp.test.ts
    engage-config scratch dir removed in afterAll
setup/service.test.ts
    tests for the PATH fix
setup/service.ts
    two hunks. (1) /snap/bin on the service PATH so snap CLIs (tailscale)
    resolve. (2) the stale-docker-group path: a minimal image (the Debian 13
    LXC template) ships no `acl`, so the setfacl workaround silently did not
    happen and the unit started straight into a crash loop — install the
    package and retry; if the group is still stale, say what it is and what
    fixes it BEFORE the unit starts, instead of leaving it to the journal;
    and report linger from `loginctl show-user` rather than assuming an
    unprivileged `enable-linger` took (it exits 1 without a polkit agent —
    every headless SSH install — so sudo is tried too). Carried from the
    web branch, where a Debian 13 CT install hit all three.
src/drivers/docker-driver.ts
    the other half of that: when the socket exists but is forbidden, the boot
    banner names the docker group and the fix (`loginctl terminate-user`),
    not "ensure Docker is installed and running" — which sends the operator
    to check the one thing that already works in their shell. Conservative
    match; anything unrecognised keeps the generic advice.
src/drivers/docker-driver.test.ts
    coverage for the above: permission-denied on an existing socket names the
    group and not the daemon.
.claude/skills/add-opencode/payload/container/agent-runner/src/providers/opencode-config.ts
    default OPENCODE_SMALL_MODEL to the main model. OpenCode runs side tasks
    (session titles, summaries) on a small model and, with none configured,
    asks its own catalogue for gpt-5.4-nano — which a local endpoint never
    serves, so every auxiliary call failed ("model 'gpt-5.4-nano' not found"
    in the session log, main reply unaffected). The main model is the one
    model the endpoint is known to have. Webchat sets the env var itself since
    the model-from-the-pick fix, so this is for a hand-applied skill; it is
    upstream's payload, hence a patch on the skill directory.
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
src/db/agent-groups.ts
    lifecycle status setter with validation
src/db/db-v2.test.ts
    test-row shape for the extended container config
src/db/sessions.ts
    non-destructive pending-approval claim + TTL sweep feed
src/egress-lockdown.test.ts
    upstream's attach tests inverted: the gateway is kept off the locked network, re-detached on heal
src/egress-lockdown.ts
    per-group lockdown (`force`) alongside the install-wide flag; the selected gateway kept OFF the network and its endpoint pointed at central's egress filter on the bridge
src/group-init.ts
    rtk bash-output compression hook; upstream memory-reconcile coexistence
src/host-sweep.test.ts
    tests for the sweep fixes
src/host-sweep.ts
    bloated-continuation self-heal + sweep hygiene
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
src/modules/approvals/primitive.test.ts
    tests: an unnamed fan-out leaves approver_user_id null; a policy-named approver is recorded
src/modules/approvals/primitive.ts
    approver fan-out: every eligible admin gets the card, first response wins — approver_user_id records only a policy-named approver (it used to default to the first target, which made a fan-out an exclusive assignment); exports APPROVAL_OPTIONS for the session-less sibling
src/modules/approvals/response-handler.test.ts
    tests for the double-fire guard
src/modules/approvals/response-handler.ts
    double-fire guard on the approve path (slow handler tempts a second click); session-less rows (runner pairing) routed to sessionless.ts
    checkApprovalClick: a refusal carries a reason the channel can show; an owner may decide a card named for someone else (audited as approval.owner_override)
src/modules/self-mod/apply.ts
    respawn ALL of a group's sessions after install/mcp change, not just one
src/reconcile-session.ts
    UTC-safe claim-timestamp parsing (SQLite stamps carry no zone, so Date.parse
    read them as local and the claim-stuck check killed fresh claims on a
    non-UTC host), plus the bloated-continuation self-heal: after two ceiling
    kills that produced no output, clear the stored continuation so the next
    turn starts fresh. Was in host-sweep.ts until upstream moved the sweep
    decision logic here.
src/router.ts
    agent lifecycle gate (active/paused/archived) + prime negative-lookahead
src/session-manager.attachments.test.ts
    coverage: hostPath attachments (large uploads staged by the adapter) reach
    the container inbox instead of being skipped silently
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

## PRODUCT — shrink via seam registries (37)

src/mailbox/model.ts
    add the 'interrupt' inbound kind — the webchat stop button writes a control
    row of that kind (trigger=false, never wakes a container) and the runner's
    poll loop consumes it to abort a live turn. Without the kind in the union the
    feature's own comparisons were dead code that failed the container typecheck.
container/agent-runner/src/mailbox/model.generated.ts
    the same change, byte-identical: `pnpm mailbox-model:check` cmp's the two
    copies, so this patch must always mirror src/mailbox/model.ts exactly.
container/agent-runner/src/provider-contracts/claude.ts
    keep Claude's textDelivery at the result door (upstream: mid-turn-complete)
    so the single-reply misfire guard can see the turn's block count
container/agent-runner/src/provider-contracts/registry.test.ts
    asserts the result-door contract above
container/agent-runner/src/providers/claude-config.ts
    per-server MCP tool allowlist (`enabledTools`) → SDK `allowedTools`
container/agent-runner/src/providers/claude.errors.test.ts
    error-path assertion follows the active textDelivery contract
container/agent-runner/src/providers/claude.midturn-text.test.ts
    asserts the result-door contract
src/db/migrations/portability.test.ts
    grandfathers the webchat module's pre-async-driver migrations
src/modules/cross-session-context/backfill.ts
    skip per-member (`::`-keyed) sessions — they get context from their own
    transcript sync
src/provider-contracts/realize.ts
    skill symlinks point at whichever mount holds the skill (shipped or
    imported); dangling links for deleted skills are removed
src/provider-surfaces.test.ts
    expects the imported-user-skills mount
.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts
    map a derived agent identity (per-member credentials) to its agent group
    before the ownership check and the core approval request
.claude/skills/add-onecli/payload/container/skills/onecli-gateway/SKILL.md
    secret intake points at the webchat Agents → Secrets UI, not the OneCLI dashboard
container/agent-runner/src/config.ts
    lenientOutput + learning config surface read by the runner
container/agent-runner/src/index.ts
    module imports (status feed, learning, send-file hint); the prompt addendum
    is built after the provider so it can consult supportsMcpTools
container/agent-runner/src/mailbox/sqlite/operations.ts
    relay-sync support for agents placed on runners
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
    provider capability flags (supportsRestrictedReview, memory scaffold, settings
    scopes, supportsMcpTools)
docs/SECURITY.md
    egress section points at the per-group filter (docs/webchat/security.md)
eslint.config.js
    lint rules for the webchat PWA frontend
scripts/skill-conformance.test.ts
    seeds container/Dockerfile with the nanoclaw:image-layers region, so a skill
    that adds an image layer with `nc:append at:` applies in the fixture root
    instead of bouncing to an agent
src/channels/adapter.ts
    senderAgentGroupId for a2a loop-back attribution
src/channels/channel-registry.ts
    thread the producing session/agent through the adapter
src/config.ts
    egress network named per install (installs sharing a daemon must not share a lockdown network); NANOCLAW_EGRESS_EXTRA_DEFAULTS for the allowlist
src/container-config.ts
    egress/learning/lenient config plumbing + MCP tool allowlist and private-LAN http
src/container-config.test.ts
    regression test: egress reaches container.json (it silently did not)
src/db/container-configs.ts
    egress + learning columns
src/drivers/installed.ts
    append-only barrel import registering the `fleet` session driver (a seam registry for out-of-tree drivers would retire this)
src/drivers/types.ts
    slot mounts carry `exclude` globs and `propose` (runner placements)
src/modules/approvals/index.ts
    approval-TTL expiry on the sweep seam
    re-exports checkApprovalClick for channels that answer their caller
src/modules/index.ts
    module barrel registrations
src/modules/typing/index.test.ts
    tests for the typing attribution
src/modules/typing/index.ts
    agentName on the typing indicator (multi-agent rooms)

## LOCAL — install-local, expected to persist (6)

setup/lib/restart-readiness.test.ts
    skips TWO tests behind NANOCLAW_WEBCHAT_SKIP_RESTART_FALLBACK, which only
    this repo's CI sets. Both exercise restart.sh's nohup fallback and hang the
    full 30s on that one runner; they pass in 4.4s in the runner's OWN image
    (catthehacker/ubuntu:act-22.04), as root, on Node 24, and down to 0.5 CPU,
    and take an identical 63.7s alone as in the full suite — so not contention,
    not the image, not root, Node or CPU. Unlike the rest of this folder it is
    NOT expected to persist: delete it when the runner is fixed or replaced and
    let a run prove it. If the fallback proves genuinely broken in some
    environments, report it upstream instead of skipping.
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
