# Patch inventory — what each residue patch is, and where it should end up.
#
# patches/ holds webchat's edits to files NANOCLAW owns (files we own live in
# app/). Three sub-folders by DESTINY, so the ledger doubles as a work queue:
#
#   upstreamable/ — generic fixes and improvements with no webchat concept in
#                   them. Each is a candidate upstream PR; landing one DELETES
#                   its patch. This is where the residue shrinks fastest.
#   product/      — webchat features that still need a core touchpoint. These
#                   shrink when a seam registry absorbs them, not by upstreaming.
#   local/        — install-local reality: fork-specific skill payloads, the
#                   OpenCode-removal reference sweep, ignore entries. Neither
#                   upstreamable nor a product feature; expected to persist.
#
# Regenerate a patch after editing a composed tree:
#   scripts/regen-patches.sh <composed-tree> <file> ...


## UPSTREAMABLE — candidate upstream PRs (72)

.claude/skills/add-onecli/scripts/setup.ts
    keep OneCLI's management API and Postgres off the docker bridge on Linux.
    OneCLI's compose file binds every port to ONECLI_BIND_HOST, which setup
    sets to the bridge so containers reach the gateway; that also exposed the
    API (no auth in a local install) and Postgres (compose default password)
    to every container on the host. Fresh installs now bind the API to
    loopback, add a loopback gateway port beside the bridge one, publish no
    Postgres port, and write ONECLI_URL / api-host / APP_URL on loopback;
    `--private-ports` migrates an existing install; updates run it
    (deploy/onecli-private-ports.sh). DELETE when upstream ships an
    equivalent, or OneCLI's compose file binds the API and database privately
    itself.
.claude/skills/add-onecli/scripts/setup.private-ports.test.ts
    tests for the above (the compose rewrite, idempotence, loopback URL).
setup/verify.ts
    exports CHANNEL_ENV_KEYS so a test can neutralise exactly the credential
    env vars that mark a channel configured: an ambient GITHUB_TOKEN (every
    Actions runner sets one) otherwise invents a github channel and fails
    setup/verify-slack.test.ts. Submitted upstream; DELETE both this and the
    test patch when it merges.
setup/verify-slack.test.ts
    the other half: stubs those keys empty in beforeEach and calls
    vi.unstubAllEnvs() in afterEach, so the suite stops inheriting ambient env.
CLAUDE.md
    operator docs for the above
container/Dockerfile
    rtk (bash-output compression) baked in, arch-aware
container/agent-runner/package.json
    pin @anthropic-ai/claude-agent-sdk exactly instead of ^. The bun tree has
    no minimumReleaseAge policy, so a caret held only by bun.lock lets one
    non-frozen install float the SDK; upstream's CLAUDE.md already says to bump
    it deliberately. No lockfile change.
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
    do not describe the MCP messaging tools to a provider that has none (pi, and
    any harness with its own fixed toolset); a model promised `send_message` it
    cannot call loops trying to keep the promise. Gated on
    AgentProvider.supportsMcpTools, so upstreaming this wants the types.ts hunk
    of the same name alongside it.
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
    scratch dirs removed in afterAll
setup/channels/run-channel-skill.test.ts
    scratch dirs removed in afterAll
setup/channels/whatsapp.test.ts
    engage-config scratch dir removed in afterAll
setup/service.test.ts
    tests for the PATH fix
setup/service.ts
    (1) /snap/bin on the service PATH so snap CLIs (tailscale) resolve.
    (2) stale docker group on minimal images with no `acl` (e.g. Debian 13 LXC):
    install it and retry, and if the group is still stale explain the fix
    before the unit starts rather than crash-looping. (3) report linger from
    `loginctl show-user` instead of assuming an unprivileged `enable-linger`
    took (it fails without a polkit agent, so sudo is tried too).
src/drivers/docker-driver.ts
    the other half of that: when the socket exists but is forbidden, the boot
    banner names the docker group and the fix (`loginctl terminate-user`),
    not "ensure Docker is installed and running" — which sends the operator
    to check the one thing that already works in their shell. Conservative
    match; anything unrecognised keeps the generic advice.
    Also: a stop whose `rm --force` loses the race with the daemon's own `--rm`
    removal ("removal ... already in progress", or `ps -a` still listing the
    container while it is removed) is a completed teardown, not a failure; a
    container still listed gets a 3s window to disappear before the probe
    reports it. Coverage in app/src/drivers/docker-driver.removal.test.ts.
src/drivers/docker-driver.test.ts
    coverage for the above: permission-denied on an existing socket names the
    group and not the daemon.
.claude/skills/add-opencode/payload/container/agent-runner/src/providers/opencode-config.ts
    default OPENCODE_SMALL_MODEL to the main model. With none configured
    OpenCode asks its catalogue for a small cloud model that a local endpoint
    never serves, so every auxiliary call (titles, summaries) fails. Webchat
    sets the env var itself; this covers a hand-applied skill. Upstream's
    payload, hence a patch on the skill directory.
container/agent-runner/src/mailbox/registry.test.ts
    make the unreadable-context test uid-independent: root (CI containers)
    bypasses mode 0o000, so it spies Bun.file for that one path and json()
    rejects with EACCES regardless of uid.
scripts/update/transaction.e2e.test.ts
    make the partial-snapshot test uid-independent: root bypasses chmod 0o000,
    so it spies fs.copyFileSync for that one path to force copyEntry to throw
    (same technique as remove.test.ts below).
setup/uninstall/remove.test.ts
    failure injection via spy — root in CI bypasses chmod bits
src/backfill-container-configs.ts
    backfill for the extended config columns
src/cli/resources/destinations.ts
    destination-change refresh: force active sessions to see the new map (silent-bug path)
src/cli/resources/groups.test.ts
    tests for FK-aware deletion; an agent's --model update restarts its session
src/cli/resources/groups.ts
    FK-aware group deletion for module-installed tables; an agent's approved
    `config update --model` restarts its session, so no second restart card
src/container-runner.test.ts
    test for the memory-cap default
src/container-runner.ts
    root-host chown, user-skills mount, memory cap default, bun cache, per-group egress;
    killContainer issues one stop per runtime (a repeat call only adds its exit
    callback) and isContainerStopping() lets the reconcile leave a stop in
    flight, or a teardown awaiting retry, alone. Coverage in
    app/src/container-runner.stop-once.test.ts.
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
src/host-sweep-grace.test.ts
    adds isContainerStopping to the container-runner mock: the reconcile now
    asks it before enforcing the SLA (see src/reconcile-session.ts).
src/host-sweep.ts
    bloated-continuation self-heal + sweep hygiene
src/modules/agent-to-agent/agent-route.test.ts
    reproduction test for the a2a self-loop
src/modules/agent-to-agent/agent-route.ts
    a2a self-loop guard (an error reply routed back to its own session floods the room)
src/modules/agent-to-agent/message-gate.test.ts
    self-loop guard coverage
src/modules/agent-to-agent/write-destinations.test.ts
    tests for the destination projection
src/modules/agent-to-agent/write-destinations.ts
    project destinations into running sessions (no restart needed)
src/modules/approvals/primitive.test.ts
    tests: an unnamed fan-out leaves approver_user_id null; a policy-named approver is recorded
src/modules/approvals/primitive.ts
    approver fan-out: every eligible admin gets the card, first response wins — approver_user_id records only a policy-named approver, so a fan-out is never an exclusive assignment; exports APPROVAL_OPTIONS for the session-less sibling
src/modules/approvals/response-handler.test.ts
    tests for the double-fire guard
src/modules/approvals/response-handler.ts
    double-fire guard on the approve path (slow handler tempts a second click); session-less rows (runner pairing) routed to sessionless.ts
    checkApprovalClick: a refusal carries a reason the channel can show; an owner may decide a card named for someone else (audited as approval.owner_override)
src/modules/self-mod/apply.ts
    respawn ALL of a group's sessions after install/mcp change, not just one
src/reconcile-session.ts
    UTC-safe claim-timestamp parsing (zone-less SQLite stamps read as local
    made the claim-stuck check kill fresh claims on a non-UTC host), plus the
    bloated-continuation self-heal: after two ceiling kills with no output,
    clear the stored continuation so the next turn starts fresh. Only a kill
    with processing claims open (a stuck turn) counts, once per container
    incarnation (every kill when the incarnation is unknown); an idle container
    reaped at the ceiling never does. The reconcile skips a container already
    being stopped. Coverage in
    app/src/reconcile-session.ceiling.test.ts.
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

## PRODUCT — shrink via seam registries (40)

src/mailbox/model.ts
    add the 'interrupt' inbound kind — the webchat stop button writes a control
    row of that kind (trigger=false, never wakes a container) and the runner's
    poll loop consumes it to abort a live turn.
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
container/agent-runner/src/cross-session-echo.test.ts
    a mirrored context row (trigger 0, not an echo) is never a command.
.claude/skills/add-opencode/SKILL.md
    the agent-runner provider barrel imports OpenCode guarded: a group's own
    image built on an older base lacks @opencode-ai/sdk, and the plain import
    made every such agent die at start.
.claude/skills/add-opencode/payload/container/agent-runner/src/providers/opencode.ts
    the event pump hands each event to opencode-feed.ts, which forwards tool
    calls and reasoning to the thinking bubble (the provider-message seam).
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
container/agent-runner/src/mcp-tools/cli.instructions.md
    agent-facing CLI instructions; --model needs no `groups restart`
container/agent-runner/src/mcp-tools/core.instructions.md
    agent-facing core instructions
container/agent-runner/src/poll-loop.test.ts
    coverage for the poll-loop product behaviour
container/agent-runner/src/poll-loop.ts
    interrupt handling, lenient output, origin guard, terminal-error surfacing, empty-turn net
container/agent-runner/src/providers/claude.ts
    thinking/reasoning stream taps, restricted-review support, rate-limit classification
container/agent-runner/src/providers/types.ts
    provider capability flags (supportsRestrictedReview, settings scopes,
    supportsMcpTools)
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
    regression test: egress reaches container.json
src/db/container-configs.ts
    egress + learning columns
src/drivers/index.ts
    a session-container gateway consults the network-policy seam before its
    early return: an agent a module filters is refused rather than started on
    the sidecar's unfiltered network (moving the seam call above upstream's
    return would retire this)
src/modules/approvals/index.ts
    approval-TTL expiry on the sweep seam
    re-exports checkApprovalClick for channels that answer their caller
src/modules/index.ts
    module barrel registrations
src/modules/typing/index.test.ts
    tests for the typing attribution
src/modules/typing/index.ts
    agentName on the typing indicator (multi-agent rooms)

## LOCAL — install-local, expected to persist (5)

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
