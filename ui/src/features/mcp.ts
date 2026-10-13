// ── MCP servers ──────────────────────────────────────────────────────────────
// The server registry (where servers are DEFINED), the detail pane, and the
// per-agent enable/disable wiring. One module because the agent panel only
// chooses from what the registry holds; it never defines a server.
import { createApp } from 'vue';
import { manageActive, manageTab } from './views-state.js';
import AgentMcpList from './AgentMcpList.vue';
import { agentMcpRows } from './agent-mcp-state.js';
import McpList from './McpList.vue';
import { agentMcpServers, allMcpServers, lastMcpProbe, lastMcpProbeToken, mcpAddInProgress, mcpAgentForAdd, mcpServers, selectedMcpId } from './mcp-list-state.js';
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { showConfirmModal } from './modals.js';
import { showToast, toastError } from '../core/toast.js';
import { buttonBusy } from '../core/busy.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import McpSources from './McpSources.vue';
import McpProbeTools from './McpProbeTools.vue';
import McpHardening from './McpHardening.vue';
import McpCatalog from './McpCatalog.vue';
import { hardeningServer, mcpCatalog, mcpCatalogPhase, mcpCatalogQuery, mcpSources, oauthBusy, probeTools } from './mcp-panel-state.js';

/** Supplied by provideMcpDeps in composition-root.ts. `any` marks a signature not
 *  yet typed, not an opt-out of checking. */
export interface McpDeps {
  closeAgentDetail: () => any;
  closeModelDetail: () => any;
  closeRoomDetail: () => any;
  openAgentDetail: (a0?: any) => any;
  showConfirmModal: (a0?: any, a1?: any, a2?: any, a3?: any, a4?: any) => any;
}

const deps = {} as McpDeps;

/** Wire the composition-root helpers this module calls. Call once at startup. */
export function provideMcpDeps(provided: Partial<McpDeps>): void {
  Object.assign(deps, provided);
}

let agentMcpApp: ReturnType<typeof createApp> | null = null;

function mountAgentMcpList(agentId: any): void {
  agentMcpApp ??= mountIsland('#agent-mcp-list', () =>
    createApp(AgentMcpList, {
      // agentId is read from the closure at DETACH time, not captured per row:
      // the island outlives any single agent, so the row must not remember which
      // agent it was rendered for.
      onDetach: (s: any) => detachAgentMcp(currentAgentMcpId, s),
    }),
  );
}

let currentAgentMcpId: any = null;

export async function renderAgentMcp(agentId?: any): Promise<void> {
  currentAgentMcpId = agentId;
  agentMcpServers.value = [];
  try {
    agentMcpServers.value = (await apiJson(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`)).servers || [];
  } catch (err: any) {
    console.error('Failed to load MCP servers:', err);
  }
  const rows = agentMcpServers.value ?? [];
  const mcpCount = $('#agent-mcp-count');
  if (mcpCount) mcpCount.textContent = rows.length ? String(rows.length) : '';
  // No empty-state prose — the "+ Attach server" button below is self-explanatory.
  agentMcpRows.value = rows;
  mountAgentMcpList(agentId);
}

export async function setAgentMcp(agentId?: any, body?: any, okMsg?: any) {
  await apiJson(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`, { method: 'PUT', body });
  showToast(okMsg, { kind: 'success' });
  await renderAgentMcp(agentId);
}

async function detachAgentMcp(agentId?: any, server?: any) {
  const ok = await deps.showConfirmModal({
    title: `Detach ${server.name}?`,
    body: 'The agent loses these tools on its next message.',
    confirmLabel: 'Detach',
    destructive: true,
  });
  if (!ok) return;
  try {
    await setAgentMcp(agentId, { remove: [server.id] }, `Detached ${server.name}`);
  } catch (err: any) {
    showToast('Detach failed: ' + (err.message || err), { kind: 'error' });
  }
}

export async function maybeAttachAfterMcpAdd(newId?: any, name?: any) {
  if (!mcpAddInProgress.value) return;
  const agentId = mcpAgentForAdd.value;
  mcpAddInProgress.value = false;
  mcpAgentForAdd.value = null;
  if (!agentId || !newId) return;
  try {
    await setAgentMcp(agentId, { add: [newId] }, `Attached ${name}`);
  } catch (err: any) {
    showToast('Attach failed: ' + (err.message || err), { kind: 'error' });
  }
  await deps.openAgentDetail(agentId);
}

export async function fetchMcpServers() {
  try {
    const res = await authFetch('/api/mcp-servers');
    // Check res.ok AND the shape: a 403 has a JSON {error} body, and a non-array
    // (from any status) would throw "not iterable" in the spread call sites.
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(body)) {
      // Leave the list EMPTY rather than stale. A stale list here reads as "you
      // have these servers" when the answer is "we could not find out", and the
      // rows are clickable straight into a detail pane that would 403 too.
      allMcpServers.value = [];
      renderMcpServers();
      if (!res.ok) console.error('Failed to fetch MCP servers:', res.status, res.statusText);
      return;
    }
    allMcpServers.value = body;
    renderMcpServers();
  } catch (err: any) {
    console.error('Failed to fetch MCP servers:', err);
  }
}

// ── MCP catalog ─────────────────────────────────────────────────────────────
// Discovery only: choosing a row prefills the add form; the server is still
// probed and added like a hand-entered one. The remote/package split is the
// security line: a PACKAGE server is npm/pypi code that runs INSIDE the agent
// container next to its credentials, so picking one costs an explicit confirm
// naming the exact command — browsing is never one click from running it.

/**
 * The MCP registry is a switchable source, exactly like a skill collection: the
 * same webchat_disabled_sources row, surfaced in Settings the same way. Off means
 * off server-side too — the catalog block disappears and no request is made.
 */
let mcpRegistryDisabled = false;

export async function renderMcpSources() {
  const list = $('#mcp-sources-list')!;
  const section = $('#mcp-sources');
  if (!list || !section) return;
  let sources = [];
  try {
    // Not a global admin throws: don't tease a control they can't use.
    sources = (await apiJson('/api/mcp-sources')).sources || [];
  } catch {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  // Holds the LAST source's state; with one built-in source that is unambiguous.
  for (const src of sources) mcpRegistryDisabled = !!(src.removed || src.disabled);
  mcpSources.value = sources;
  mountMcpSources();
  applyMcpCatalogVisibility();
}

let mcpSourcesApp: ReturnType<typeof createApp> | null = null;

function mountMcpSources(): void {
  mcpSourcesApp ??= mountIsland('#mcp-sources-list', () =>
    createApp(McpSources, {
      onToggle: async (id: string, off: boolean) => {
        try {
          await apiJson(`/api/mcp-sources/${encodeURIComponent(id)}`, { method: off ? 'POST' : 'DELETE' });
          void renderMcpSources();
          applyMcpCatalogVisibility();
        } catch (err: any) {
          toastError(err, 'Could not update the source');
        }
      },
    }),
  );
}

/** Hide the catalog entirely when its source is switched off. */
function applyMcpCatalogVisibility() {
  const block = $('#mcp-catalog-block');
  if (block) block.hidden = mcpRegistryDisabled;
}

let mcpCatalogApp: ReturnType<typeof createApp> | null = null;

function mountMcpCatalog(): void {
  mcpCatalogApp ??= mountIsland('#mcp-catalog-list', () =>
    createApp(McpCatalog, { onUse: (raw: any) => useMcpCatalogEntry(raw) }),
  );
}

export async function loadMcpCatalog(q = '') {
  if (!$('#mcp-catalog-list')) return;
  const status = $('#mcp-catalog-status')!;
  // DESIGN.md §5: the wait lives inline as the list's first row, not as a blank
  // pane and not as a toast.
  mcpCatalogQuery.value = q;
  mcpCatalogPhase.value = 'loading';
  mountMcpCatalog();
  status.textContent = '';
  let servers = [];
  try {
    const payload = await apiJson(`/api/mcp-catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (payload.disabled) {
      mcpRegistryDisabled = true;
      applyMcpCatalogVisibility();
      return;
    }
    servers = payload.servers || [];
  } catch (err: any) {
    // The list is cleared and the message goes to the STATUS line, not an
    // inline row — so 'error' renders nothing at all.
    mcpCatalog.value = [];
    mcpCatalogPhase.value = 'error';
    status.textContent = err.message || "Couldn't reach the registry";
    return;
  }
  status.textContent = servers.length ? `${servers.length} servers` : 'No servers matched';
  mcpCatalog.value = servers.map((s: any) => ({
    raw: s,
    title: s.title || s.name,
    // The badge links to the source, so "who published this" is one tap from
    // readable code — the whole basis for deciding whether to trust it. Plain
    // (unlinked) badge when the entry gives us nowhere to go.
    origin: s.publisher ? { label: s.publisher, official: false, url: s.repoUrl || s.websiteUrl || '' } : null,
    kindClass: s.runsCode ? 'mcp-kind mcp-kind-code' : 'mcp-kind',
    kindText: s.runsCode ? `${s.command === 'uvx' ? 'pypi' : 'npm'} · runs in container` : 'remote',
    desc: s.description || '',
    // Show WHERE this actually goes. A remote server means the container talks
    // to someone else's host; a package means a command runs locally. Either
    // way the operator should see the destination before wiring it, not after.
    target: s.runsCode
      ? `${s.command} ${(s.args || []).join(' ')}`
      : s.url
        ? (() => {
            try {
              return `connects to ${new URL(s.url).host}`;
            } catch {
              return `connects to ${s.url}`;
            }
          })()
        : '',
  }));
  mcpCatalogPhase.value = 'ready';
}

/** Prefill the add form from a catalog row. Package servers gate on an explicit confirm. */
async function useMcpCatalogEntry(s?: any) {
  if (s.runsCode) {
    // DESIGN.md §5: no native confirm() — and this is the destructive-weight one,
    // so it gets the danger role like every other consequential action.
    const cmd = `${s.command} ${(s.args || []).join(' ')}`;
    const okToRun = await deps.showConfirmModal({
      title: `Run ${s.name} in your container?`,
      body:
        `This isn't a hosted server. It runs code inside your agent container, alongside the agent's credentials:\n\n${cmd}\n\n` +
        `Only continue if you trust the publisher (${s.publisher || 'unknown'}).`,
      confirmLabel: 'I trust it — fill in the form',
      destructive: true,
    });
    if (!okToRun) return;
  }
  // A valid config key. Don't just take the last segment: half the registry names
  // end in a generic "/mcp", so `ac.inference.sh/mcp` and `ai.other/mcp` would both
  // land on "mcp" and collide. Slug the whole name — unique and predictable, and
  // it's a prefill the operator can still edit.
  const shortName = String(s.name)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  $<HTMLInputElement>('#mcp-create-name')!.value = shortName;
  const transport = ($('#mcp-create-transport')!) as HTMLInputElement;
  if (s.kind === 'remote') {
    transport.value = 'http';
    transport.dispatchEvent(new Event('change'));
    $<HTMLInputElement>('#mcp-create-url')!.value = s.url || '';
    // The probe field is the one that proves it works before anything is saved.
    const probeUrl = ($('#mcp-probe-url')) as HTMLInputElement;
    if (probeUrl) probeUrl.value = s.url || '';
  } else {
    transport.value = 'stdio';
    transport.dispatchEvent(new Event('change'));
    $<HTMLInputElement>('#mcp-create-command')!.value = s.command || '';
    $<HTMLInputElement>('#mcp-create-args')!.value = (s.args || []).join(' ');
  }
  const block = ($('#mcp-catalog-block')) as HTMLDetailsElement;
  if (block) block.open = false;
  showToast(
    s.kind === 'remote' ? `Filled in ${shortName} — probe it, then add` : `Filled in ${shortName} — review the command, then add`,
  );
  $('#mcp-create-name')!.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let mcpListApp: ReturnType<typeof createApp> | null = null;

/** Mount the McpList island into <ul id="mcp-list">, once. */
function mountMcpList(): void {
  mcpListApp ??= mountIsland('#mcp-list', () =>
    createApp(McpList, {
      onPick: (id: string) => {
        const detail = $('#mcp-detail');
        if (selectedMcpId.value === id && detail && !detail.hidden) closeMcpDetail();
        else openMcpDetail(id);
      },
    }),
  );
}

export function renderMcpServers(): void {
  // Mount-once, then sync the rows and the selection into the island's refs.
  mcpServers.value = allMcpServers.value ?? [];
  mountMcpList();
}

export function openMcpDetail(id?: any) {
  const server = allMcpServers.value.find((s: any) => s.id === id);
  if (!server) return;
  // Close the sibling panels BEFORE claiming selection (a blanket
  // closeMcpDetail() in that group would null a selection made earlier).
  deps.closeAgentDetail();
  deps.closeRoomDetail();
  deps.closeModelDetail();
  closeMcpDetail();
  selectedMcpId.value = id;
  renderMcpServers();

  $('#mcp-edit-view')!.hidden = false;
  $('#mcp-create-view')!.hidden = true;

  $('#mcp-detail-title')!.textContent = server.name;
  $<HTMLInputElement>('#mcp-name')!.value = server.name;
  $<HTMLInputElement>('#mcp-transport')!.value = server.transport;
  const remote = server.transport !== 'stdio';
  $('#mcp-url-label')!.hidden = !remote;
  $('#mcp-command-label')!.hidden = remote;
  // Editing a server row is owner-only on the server; don't offer it to others.
  const owner = state.isOwnerView;
  $('#mcp-token-label')!.hidden = !remote || !owner;
  for (const id of ['#mcp-name', '#mcp-url', '#mcp-command']) $<HTMLInputElement>(id)!.readOnly = !owner;
  $('#mcp-detail-form button[type=submit]')!.hidden = !owner;
  $('#mcp-delete')!.hidden = !owner;
  $<HTMLInputElement>('#mcp-token')!.value = ''; // stored tokens are never displayed; blank = keep
  if (remote) $<HTMLInputElement>('#mcp-url')!.value = server.target;
  else $<HTMLInputElement>('#mcp-command')!.value = server.target;

  const usage = $('#mcp-detail-usage')!;
  usage.textContent =
    server.agents_assigned > 0
      ? `Attached to ${server.agents_assigned} agent${server.agents_assigned === 1 ? '' : 's'}.`
      : 'Not attached to any agent yet.';
  renderMcpHardening(server);

  $('#mcp-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
}

let hardeningApp: ReturnType<typeof createApp> | null = null;

function mountMcpHardening(): void {
  hardeningApp ??= mountIsland('#mcp-hardening', () =>
    createApp(McpHardening, {
      // Drift: the rug-pull alarm. Loud until a human re-approves.
      onApprove: async () => {
        const server = hardeningServer.value;
        const d = server?.drift;
        const parts: string[] = [];
        if (d?.added?.length) parts.push(`new: ${d.added.join(', ')}`);
        if (d?.removed?.length) parts.push(`removed: ${d.removed.join(', ')}`);
        if (d?.changed?.length) parts.push(`descriptions changed: ${d.changed.join(', ')}`);
        const ok = await deps.showConfirmModal({
          title: `Approve ${server.name}'s new tools?`,
          body: parts.join('\n') || 'The tool surface changed.',
          confirmLabel: 'Approve current tools',
        });
        if (!ok) return;
        try {
          await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/repin`, { method: 'POST' });
          showToast('Tool surface re-approved', { kind: 'success' });
          await fetchMcpServers();
          openMcpDetail(server.id);
        } catch (err: any) {
          showToast('Re-approve failed: ' + (err.message || err), { kind: 'error' });
        }
      },
      // All checked = no restriction, stored as null so future tools flow through
      // automatically. Compared against the checkbox count read from the DOM.
      onSaveTools: async () => {
        const server = hardeningServer.value;
        const listEl = $('#mcp-hardening .mcp-tools-list');
        if (!server || !listEl) return;
        const boxes = [...listEl.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
        const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.tool);
        const body = { enabled: chosen.length === boxes.length ? null : chosen };
        try {
          await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/tools`, { method: 'PUT', body });
          showToast(body.enabled ? `${chosen.length} of ${boxes.length} tools enabled` : 'All tools enabled', {
            kind: 'success',
          });
          await fetchMcpServers();
        } catch (err: any) {
          showToast('Save failed: ' + (err.message || err), { kind: 'error' });
        }
      },
      // Opens the authorization server in a new tab.
      onOauth: async () => {
        const server = hardeningServer.value;
        if (!server) return;
        oauthBusy.value = true;
        try {
          const body = await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/oauth/start`, {
            method: 'POST',
            body: {},
          });
          // authorizeUrl originates from a third-party MCP server's OAuth
          // metadata, relayed by our backend — treat the scheme as untrusted.
          // Same gate as originBadgeProps (origin-badge.ts): https? or nothing.
          if (!/^https?:\/\//i.test(body.authorizeUrl || '')) {
            throw new Error('Server returned an invalid authorization URL');
          }
          window.open(body.authorizeUrl, '_blank', 'noopener');
          showToast('Finish authorizing in the new tab, then come back', { kind: 'info' });
        } catch (err: any) {
          showToast('OAuth failed: ' + (err.message || err), { kind: 'error' });
        } finally {
          oauthBusy.value = false;
        }
      },
    }),
  );
}

// Health, drift re-approval, tool allowlist, OAuth connect — the hardening
// surface of one server's detail panel (remote servers only).
function renderMcpHardening(server?: any) {
  if (!$('#mcp-hardening')) return;
  hardeningServer.value = server ?? null;
  mountMcpHardening();
}

export function closeMcpDetail() {
  $('#mcp-detail')!.hidden = true;
  $('#mcp-edit-view')!.hidden = false;
  $('#mcp-create-view')!.hidden = true;
  selectedMcpId.value = null;
  if (manageActive.value && manageTab.value === 'mcp') renderMcpServers();
}

export function syncMcpCreateTransportFields() {
  const remote = $<HTMLInputElement>('#mcp-create-transport')!.value !== 'stdio';
  $('#mcp-create-token-label')!.hidden = !remote;
  $('#mcp-create-url-label')!.hidden = !remote;
  $('#mcp-create-command-label')!.hidden = remote;
  $('#mcp-create-args-label')!.hidden = remote;
}

function mcpProbeAuthHeaders() {
  const token = $<HTMLInputElement>('#mcp-probe-token')!.value.trim();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function runMcpProbe() {
  const url = $<HTMLInputElement>('#mcp-probe-url')!.value.trim();
  if (!url) {
    showToast('Enter a server URL first (e.g. host:8000/mcp).', { kind: 'error' });
    return;
  }
  if (/\s|[<>]/.test(url)) {
    showToast('URL contains invalid characters.', { kind: 'error' });
    return;
  }
  const status = $('#mcp-probe-status')!;
  const results = $('#mcp-probe-results')!;
  status.classList.remove('error');
  // The button shows the wait; the status line only ever holds an outcome.
  status.textContent = '';
  status.hidden = true;
  results.hidden = true;
  const done = buttonBusy($('#mcp-probe-btn')!, 'Probing…');
  try {
    const headers = mcpProbeAuthHeaders();
    const res = await authFetch('/api/mcp-servers/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(headers ? { url, headers } : { url }),
    });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = body.error || `Probe failed (${res.status})`;
      status.classList.add('error');
      return;
    }
    if (!body.transport) {
      // Auth-gated server: reveal the token field and invite a re-probe. A
      // WRONG token lands here too — same affordance, different message.
      if (body.requiresAuth) {
        const tokenLabel = $('#mcp-probe-token-label')!;
        const hadToken = Boolean(headers);
        tokenLabel.hidden = false;
        status.textContent = hadToken
          ? 'The server rejected that token — check it and probe again.'
          : 'This server requires a bearer token — enter it below and probe again.';
        status.classList.add('error');
        $('#mcp-probe-token')!.focus();
        return;
      }
      status.textContent = body.reason || 'No MCP server responded.';
      status.classList.add('error');
      return;
    }
    lastMcpProbe.value = body;
    lastMcpProbeToken.value = $<HTMLInputElement>('#mcp-probe-token')!.value.trim();
    renderMcpProbeResults(body);
  } catch (err: any) {
    status.textContent = 'Probe failed: ' + err.message;
    status.classList.add('error');
  } finally {
    status.hidden = !status.textContent;
    done();
  }
}

let mcpProbeToolsApp: ReturnType<typeof createApp> | null = null;

function mountMcpProbeTools(): void {
  mcpProbeToolsApp ??= mountIsland('#mcp-probe-tools', () => createApp(McpProbeTools));
}

function renderMcpProbeResults(probe?: any) {
  $('#mcp-probe-kind')!.className = `model-probe-kind kind-${probe.transport}`;
  $('#mcp-probe-kind')!.textContent = probe.transport;
  const n = probe.tools.length;
  $('#mcp-probe-notes')!.textContent =
    `${probe.serverName || 'MCP server'}${probe.serverVersion ? ' v' + probe.serverVersion : ''} — ` +
    `${n} tool${n === 1 ? '' : 's'}`;
  probeTools.value = probe.tools ?? [];
  mountMcpProbeTools();
  // Suggest a name from the server's self-reported identity.
  if (!$<HTMLInputElement>('#mcp-probe-name')!.value && probe.serverName) {
    $<HTMLInputElement>('#mcp-probe-name')!.value = probe.serverName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  $('#mcp-probe-results')!.hidden = false;
}

export async function createMcpServer(body?: any, btn?: any) {
  btn.disabled = true;
  try {
    const created = await apiJson('/api/mcp-servers', { method: 'POST', body });
    showToast(`Added ${body.name}`, { kind: 'success' });
    closeMcpDetail();
    await fetchMcpServers();
    // If this create was launched from an agent's "+ Add new server", attach
    // it to that agent and return to its settings (mirrors the models picker).
    await maybeAttachAfterMcpAdd(created.id || allMcpServers.value.find((s: any) => s.name === body.name)?.id, body.name);
  } catch (err: any) {
    showToast('Add failed: ' + (err.message || err), { kind: 'error' });
  } finally {
    btn.disabled = false;
  }
}

// Debounce for the catalog search box; module scope because it holds state
// across keystrokes.
let mcpCatalogTimer: ReturnType<typeof setTimeout> | undefined;

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The MCP panel: server add/edit, the catalog list and the reachability probe.
// Called from composition-root.ts at its place in boot order rather than run at module scope (check-boot-order.sh).

export function wireMcpPanel(): void {
  $<HTMLButtonElement>('#mcp-probe-btn')?.addEventListener('click', runMcpProbe);
  $<HTMLInputElement>('#mcp-probe-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runMcpProbe();
    }
  });

  // Add-from-probe: the URL + detected transport come from the probe result; the
  // token that made the probe succeed rides along so the saved server works too.
  $<HTMLButtonElement>('#mcp-probe-add')?.addEventListener('click', async () => {
    if (!lastMcpProbe.value) return;
    const name = ($<HTMLInputElement>('#mcp-probe-name')?.value ?? '').trim();
    if (!name) {
      showToast('Give the server a name first.', { kind: 'error' });
      return;
    }
    const body: Record<string, unknown> = {
      name,
      transport: lastMcpProbe.value.transport,
      url: lastMcpProbe.value.endpoint,
    };
    if (lastMcpProbeToken.value) body.headers = { Authorization: `Bearer ${lastMcpProbeToken.value}` };
    await createMcpServer(body, $<HTMLButtonElement>('#mcp-probe-add'));
  });

  // Manual entry (Advanced).
  $<HTMLFormElement>('#mcp-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const transport = ($<HTMLSelectElement>('#mcp-create-transport')?.value ?? '');
    const body: Record<string, unknown> = {
      name: ($<HTMLInputElement>('#mcp-create-name')?.value ?? '').trim(),
      transport,
    };
    if (transport === 'stdio') {
      body.command = ($<HTMLInputElement>('#mcp-create-command')?.value ?? '').trim();
      body.args = ($<HTMLTextAreaElement>('#mcp-create-args')?.value ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } else {
      body.url = ($<HTMLInputElement>('#mcp-create-url')?.value ?? '').trim();
      const token = ($<HTMLInputElement>('#mcp-create-token')?.value ?? '').trim();
      if (token) body.headers = { Authorization: `Bearer ${token}` };
    }
    await createMcpServer(body, $('#mcp-create-form button.btn-primary'));
  });

  // Save (rename / retarget) from the edit view.
  $<HTMLFormElement>('#mcp-detail-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedMcpId.value) return;
    const server = allMcpServers.value.find((s: any) => s.id === selectedMcpId.value);
    if (!server) return;
    const body: Record<string, unknown> = { name: ($<HTMLInputElement>('#mcp-name')?.value ?? '').trim() };
    if (server.transport === 'stdio') body.command = ($<HTMLInputElement>('#mcp-command')?.value ?? '').trim();
    else {
      body.url = ($<HTMLInputElement>('#mcp-url')?.value ?? '').trim();
    }
    // Token rotation: a typed token goes to the HOST-side credential store (the
    // relay injects it per request) — never into headers/container.json.
    const token = server.transport !== 'stdio' ? ($<HTMLInputElement>('#mcp-token')?.value ?? '').trim() : '';
    try {
      await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}`, { method: 'PUT', body });
      if (token) {
        await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}/auth`, {
          method: 'PUT',
          body: { token },
        });
      }
      showToast('Saved', { kind: 'success' });
      closeMcpDetail();
      await fetchMcpServers();
    } catch (err: any) {
      showToast('Save failed: ' + (err.message || err), { kind: 'error' });
    }
  });

  // Delete with cascade-with-confirmation (409 → impact list → ?force=1).
  $<HTMLButtonElement>('#mcp-delete')?.addEventListener('click', async () => {
    if (!selectedMcpId.value) return;
    const server = allMcpServers.value.find((s: any) => s.id === selectedMcpId.value);
    if (!server) return;
    try {
      try {
        await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}`, { method: 'DELETE' });
      } catch (err: any) {
        if (err.status !== 409) throw err;
        const n = (err.body.assigned_agent_group_ids || []).length;
        const confirmed = await showConfirmModal({
          title: 'Delete MCP server',
          body: `"${server.name}" is attached to ${n} agent${n === 1 ? '' : 's'}. They lose its tools on their next message.`,
          confirmLabel: 'Delete anyway',
          destructive: true,
        });
        if (!confirmed) return;
        await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}?force=1`, { method: 'DELETE' });
      }
      showToast(`Deleted "${server.name}".`, { kind: 'success' });
      closeMcpDetail();
      await fetchMcpServers();
    } catch (err: any) {
      showToast(`Failed to delete: ${err.message}`, { kind: 'error' });
    }
  });
}

/** The MCP catalog block: search, expand and add-from-catalog. */
export function wireMcpCatalog(): void {
  const block = document.getElementById('mcp-catalog-block') as HTMLDetailsElement | null;
  const search = document.getElementById('mcp-catalog-search') as HTMLInputElement | null;
  if (!block || !search) return;
  let loaded = false;
  block.addEventListener('toggle', () => {
    if (block.open && !loaded) {
      loaded = true;
      void loadMcpCatalog('');
    }
  });
  search.addEventListener('input', () => {
    clearTimeout(mcpCatalogTimer);
    mcpCatalogTimer = setTimeout(() => void loadMcpCatalog(search.value.trim()), 300);
  });
}
