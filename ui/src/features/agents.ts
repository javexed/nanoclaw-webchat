// ── Agents ───────────────────────────────────────────────────────────────────
// The agents surface: the list, the detail pane and its dirty/save tracking,
// per-agent controls (status, harness, egress), room wiring, and the secrets /
// deploy-key panels.
import { createApp, watchEffect } from 'vue';
import { toolSecretRows } from './tool-secrets-state.js';
import ToolSecretList from './ToolSecretList.vue';
import { userDisplayName } from './perms-user-info.js';
import { selectedRoomId } from './room-list-state.js';
import { allModels } from './model-list-state.js';
import {
  agentMcpServers,
  allMcpServers,
  lastMcpProbe,
  lastMcpProbeToken,
  mcpAddInProgress,
  mcpAgentForAdd,
  selectedMcpId,
} from './mcp-list-state.js';
import { permsAgents, permsMyUserId } from './perms-list-state.js';
import RoomWiredAgents from './RoomWiredAgents.vue';
import { roomWiredRows } from './room-wired-state.js';
import AgentList from './AgentList.vue';
import { selectedAgentId } from './agent-list-state.js';
import { installProgressLine } from './installer-state.js';
import { agentSecretEffective } from './agent-lists-state.js';
import AgentWiredRooms from './AgentWiredRooms.vue';
import AgentSessions from './AgentSessions.vue';
import AddAgentPicker from './AddAgentPicker.vue';
import RoomCreateAgentChecklist from './RoomCreateAgentChecklist.vue';
import AgentSecretList from './AgentSecretList.vue';
import AgentEnvList from './AgentEnvList.vue';
import AgentKeyList from './AgentKeyList.vue';
import {
  addAgentCandidates,
  agentKeyRows,
  agentSecretRows,
  createAgentAnyExist,
  createAgentCandidates,
  agentEnvNames,
  agentEnvDeleting,
} from './agent-lists-state.js';
import {
  agentDetailBaseline,
  agentDetailRooms,
  archivedAgentsCount,
  canManageRooms,
  roomDetailWiredAgents,
  sessions,
  sessionsError,
  sessionsPhase,
  showArchivedAgents,
  turnElapsedTimer,
  wiredRooms,
} from './agent-detail-state.js';
import { $, esc } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { closeModelDetail, openModelPicker } from './models.js';
import { confirmWithToggle, showConfirmModal } from './modals.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { renderAgentEgressHosts, setAgentEgressHostsMode } from './network.js';
import { state } from '../core/state.js';
import type { Agent } from '../core/state.js';
import { isAdminView } from '../core/state.js';
import { appendSystem } from './transcript.js';
import { ensureTurn, removeTurn } from './thinking.js';
import { thinkingTurns, turnFor } from './transcript-state.js';
import {
  closeMcpDetail,
  fetchMcpServers,
  renderAgentMcp,
  renderMcpServers,
  setAgentMcp,
  syncMcpCreateTransportFields,
} from './mcp.js';
import { renderAgentSkills, renderRoomSkills } from './skills.js';
import { renderAgentTemplateRow } from './agent-templates.js';
import { closeAttachPicker, openAttachPicker } from './files.js';
import { closeRoomDetail } from './rooms.js';

/**
 * Supplied by provideAgentsDeps in composition-root.ts. `any` marks a signature not yet
 * typed, not an opt-out of checking.
 */
export interface AgentsDeps {
  closeAttachPicker: () => any;
  closeModelDetail: () => any;
  closeRoomDetail: () => any;
  fetchModels: () => any;
  getWiredAgentsForCurrentRoom: () => any;
  inspectAndConfirmImport: (a0?: any, a1?: any, a2?: any) => any;
  modelKindLabel: (a0?: any) => any;
  openAttachPicker: (...args: any[]) => any;
  openRoomDetail: (a0?: any) => any;
  populateKnownModelOptions: () => any;
  setWiredAgentsForCurrentRoom: (v: any) => void;
  showConfirmModal: (a0?: any, a1?: any, a2?: any, a3?: any, a4?: any) => any;
  warnIfUnreachable: (a0?: any) => any;
}

const deps = {} as AgentsDeps;

/** Wire the composition-root helpers this module calls. Call once at startup. */
export function provideAgentsDeps(provided: Partial<AgentsDeps>): void {
  Object.assign(deps, provided);
}

// Stable per-name colour for a2a side-channel agent labels. Hashes the name to
// a hue so the same agent is always tinted the same; fixed saturation/lightness
// stay legible on both the light and dark themes.
export function agentColor(name?: any) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 60%, 55%)`;
}

export async function refreshWiredAgentsForCurrentRoom() {
  const roomId = state.currentRoom;
  if (!roomId) {
    deps.setWiredAgentsForCurrentRoom([]);
    return;
  }
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`);
    const next = await res.json();
    // Race guard: if the user navigated to a different room while this was
    // in flight, drop the stale result.
    if (state.currentRoom === roomId) deps.setWiredAgentsForCurrentRoom(next);
  } catch {
    // network blip — leave stale cache rather than blanking
  }
}

// Map a mention handle (folder/slug) to its wired agent's colour, matching the
// per-name tint used on a2a labels. Humans / unknown handles → null (default chip).
export function mentionAgentColor(handle?: any) {
  const a = (deps.getWiredAgentsForCurrentRoom() || []).find((x: any) => (x.folder || '').toLowerCase() === handle);
  return a && a.name ? agentColor(a.name) : null;
}

// Adding a skill asks WHICH agents up front — the same multi-select attach picker
// MCP uses. Each toggle wires the skill to just that agent (per-agent scoped
// import, no pool fan-out); "Wire to all agents" does the shared-pool import.
let wireSkillState: any = null;

export async function openWireToAgentsPicker(importBody?: any, displayName?: any, opts: any = {}) {
  if (!(await deps.inspectAndConfirmImport(importBody, displayName, !!opts.community))) return;
  if (!state.allAgents.length) await fetchAgents();
  wireSkillState = { importBody, name: null, wired: new Set() };
  deps.openAttachPicker({
    title: `Wire ${displayName} to agents`,
    searchPlaceholder: 'Search agents…',
    emptyText: 'No agents yet.',
    addNewLabel: 'Wire to all agents',
    items: () => state.allAgents,
    searchText: (a: any) => a.name,
    name: (a: any) => a.name,
    isAttached: (a: any) => wireSkillState.wired.has(a.id),
    onToggle: async (a: any, add: any) => {
      if (add) {
        const body = await apiJson(`/api/agents/${encodeURIComponent(a.id)}/skills/import`, {
          method: 'POST',
          body: importBody,
        });
        wireSkillState.name = body.name;
        wireSkillState.wired.add(a.id);
        showToast(`Wired ${body.name} to ${a.name}`, { kind: 'success' });
      } else {
        await apiJson(
          `/api/agents/${encodeURIComponent(a.id)}/skills/scoped/${encodeURIComponent(wireSkillState.name)}`,
          { method: 'DELETE' },
        );
        wireSkillState.wired.delete(a.id);
        showToast(`Unwired from ${a.name}`, { kind: 'success' });
      }
    },
    onAddNew: async () => {
      // "Wire to all agents" = the shared pool (every 'all' agent picks it up).
      deps.closeAttachPicker();
      try {
        const body = await apiJson('/api/skills/import', { method: 'POST', body: importBody });
        showToast(`Added ${body.name} to all agents`, { kind: 'success' });
      } catch (err) {
        showToast('Import failed: ' + ((err as any)?.message || err), { kind: 'error' });
      }
    },
  });
}

export function populatePermsAgentDropdowns() {
  // Only the wizard uses an agent-group dropdown now (the matrix UI lists
  // each group as its own row). Repopulate from the latest /api/agents.
  const el = $('#perms-create-group');
  if (!el) return;
  el.innerHTML = '<option value="">— global —</option>';
  permsAgents.value.forEach((a: any) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name || a.id;
    el.appendChild(opt);
  });
}

export async function showAgentsDetail() {
  const agents = await authFetch('/api/agents')
    .then((r) => r.json())
    .catch(() => []);
  if (agents.length === 0) {
    showDetail('Agents', '<div class="metric-sub">No agents</div>');
    return;
  }
  const sorted = [...agents].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const rows = sorted
    .map((b) => {
      const room = b.room_id ? `<code>${esc(b.room_id)}</code>` : '<span class="metric-sub">—</span>';
      return `<tr>
      <td>${esc(b.name)}</td>
      <td><code>${esc(b.folder)}</code></td>
      <td>${room}</td>
      <td><span class="metric-sub">${esc(new Date(b.created_at).toLocaleString())}</span></td>
    </tr>`;
    })
    .join('');
  showDetail(
    'Agents',
    `<table class="detail-table">
      <thead><tr><th>Name</th><th>Folder</th><th>Room</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

export async function fetchAgents() {
  try {
    // Always fetch WITH archived and split here: the toggle needs the archived
    // COUNT while they are hidden. state.allAgents is the visible set for the
    // current toggle.
    const all = await apiJson('/api/agents?includeArchived=1');
    const archived = all.filter((a: any) => a.status === 'archived');
    archivedAgentsCount.value = archived.length;
    state.allAgents = showArchivedAgents.value ? all : all.filter((a: any) => a.status !== 'archived');
    renderAgents();
  } catch (err) {
    console.error('Failed to fetch agents:', err);
  }
}

let agentListApp: ReturnType<typeof createApp> | null = null;

/** Mount the AgentList island into <ul id="agent-list">, once. */
function mountAgentList(): void {
  if (agentListApp) return;
  const host = $('#agent-list');
  if (!host) return;
  agentListApp = createApp(AgentList, {
    onPick: (id: string) => {
      const detail = $('#agent-detail');
      if (selectedAgentId.value === id && detail && !detail.hidden) closeAgentDetail();
      else openAgentDetail(id);
    },
  });
  agentListApp.mount(host);

  // Gate on the ADMIN signal, not owner: the create endpoint is fronted by
  // isAnyAdmin (scoped admins included), and isAdminView is the client's copy.
  watchEffect(() => {
    const btn = $('#create-agent-btn');
    if (btn) btn.hidden = !isAdminView.value;
  });
}

export function renderAgents(): void {
  // Mount-once; the island re-renders from state.allAgents on its own.
  mountAgentList();

  // "Show / hide archived" toggle — the sidebar's contract: count-bearing text
  // ("Show 2 archived"), hidden entirely when nothing is archived.
  const toggle = $('#agent-show-archived');
  if (toggle) {
    toggle.hidden = archivedAgentsCount.value === 0;
    if (archivedAgentsCount.value) {
      toggle.textContent = showArchivedAgents.value
        ? `Hide ${archivedAgentsCount.value} archived`
        : `Show ${archivedAgentsCount.value} archived`;
    }
  }
}

/**
 * Every agent has three network modes: Open, Allowlist (the default; the
 * install list lives in Manage → Network, and the agent's own hosts below the
 * control) and Model only. A move to or from Open waits for the agent's next
 * start (it changes the container's network).
 */
export function setAgentEgressControl(egress?: any) {
  const mode = egress || 'host-only';
  const ctl = $('#agent-egress-control');
  if (!ctl) return;
  ctl.querySelectorAll<HTMLElement>('.setting-option').forEach((b) => {
    b.classList.toggle('active', b.dataset.egress === mode);
  });
  const info = $('#agent-egress-info');
  if (info) {
    info.textContent = 'Open ↔ the others: next start.';
  }
  const badge = $('#agent-egress-badge');
  if (badge) badge.textContent = mode === 'open' ? 'Open' : mode === 'none' ? 'Model only' : '';
  const note = $('#agent-egress-note');
  if (note) note.hidden = true;
  setAgentEgressHostsMode(mode);
}

// Reflect the agent's status on the 3-button segmented control + hint.
export function setAgentStatusControl(status?: any) {
  const s = status || 'active';
  document.querySelectorAll('#agent-status-control .setting-option').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.status === s);
  });
}

// Which harnesses this control can render. A value outside the set (an
// uninstalled or retired provider) falls back to the built-in default rather
// than lighting nothing up, so the group of buttons always has exactly one
// pressed — an unpressed group reads as "no harness", which is never true.
const HARNESS_OPTIONS = ['claude', 'opencode', 'pi', 'codex', 'grok'] as const;

export function setAgentHarnessControl(provider?: any) {
  const p = HARNESS_OPTIONS.includes(provider) ? (provider as string) : 'claude';
  document.querySelectorAll('#agent-harness-control .setting-option').forEach((b) => {
    const on = (b as HTMLElement).dataset.provider === p;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

export function setAgentSubtab(name?: any) {
  document.querySelectorAll('#agent-edit-view .agent-subtab').forEach((t) => {
    const on = (t as HTMLElement).dataset.subtab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('#agent-edit-view .agent-subtab-panel').forEach((p) => {
    (p as HTMLElement).hidden = (p as HTMLElement).dataset.subtabPanel !== name;
  });
}

export async function openAgentDetail(id?: any) {
  const agent = state.allAgents.find((b) => b.id === id);
  if (!agent) return;
  selectedAgentId.value = id;
  renderAgents();
  deps.closeRoomDetail();
  deps.closeModelDetail();
  closeMcpDetail();

  // Show edit view, hide create view
  $('#agent-edit-view')!.hidden = false;
  $('#agent-create-view')!.hidden = true;
  setAgentSubtab('settings'); // always open on Settings, not the last-used tab

  $('#agent-detail-title')!.textContent = agent.name ?? '';
  $<HTMLInputElement>('#agent-name')!.value = agent.name ?? '';

  // Models dropdown — refresh the list lazily so a freshly-added model
  // shows up without a tab-switch round trip.
  if (allModels.value.length === 0) await deps.fetchModels();
  populateAgentModelSelect(agent.assigned_model_id);

  // Pinned Anthropic model (container_configs.model). Suggestions are
  // best-effort — the field stays usable if the fetch fails.
  $<HTMLInputElement>('#agent-config-model')!.value = agent.config_model || '';
  void deps.populateKnownModelOptions();

  setAgentStatusControl(agent.status);
  setAgentHarnessControl(agent.provider);

  // Template origin + update check. Fire-and-forget: it hides its own row when
  // the agent was not stamped, so it never blocks the rest of the detail view.
  void renderAgentTemplateRow(agent.id);
  setAgentEgressControl(agent.egress);
  void renderAgentEgressHosts(agent.id, agent.egress);
  void renderAgentEnv(id);

  // Load instructions (instructions.prepend.md — the provider-neutral standing
  // instructions composed into every provider's CLAUDE.md at spawn).
  try {
    const { content, legacyBytes } = await apiJson(`/api/agents/${encodeURIComponent(id ?? '')}/instructions`);
    $<HTMLInputElement>('#agent-instructions')!.value = content;
    // A group can hold a pre-cutover CLAUDE.local.md this editor does not
    // write; say so rather than showing an empty box.
    const note = $('#agent-instructions-legacy');
    if (note) {
      const show = !content && legacyBytes > 0;
      note.hidden = !show;
      if (show) {
        note.textContent =
          `This agent also has a ${Math.round(legacyBytes / 1024)} KB CLAUDE.local.md from before ` +
          'standing instructions moved here. It is not edited on this screen — run /migrate-memory to fold it in.';
      }
    }
  } catch {}

  // Rooms this agent is wired to (assign / unassign).
  await loadAgentRooms(id);

  // MCP servers wired to this agent (external tool servers).
  renderAgentMcp(id);
  void renderAgentLearning(id);

  // Skills (Anthropic Agent Skills) this agent loads.
  renderAgentSkills(id);

  // Credentials scoped to this agent (needs isolation to mean anything).
  void renderAgentSecrets(id);
  void renderAgentKeys(id);

  // Active sessions — reset a stuck one (incl. background a2a sessions).
  renderAgentSessions(id);

  // Name / model / instructions are now populated — snapshot them so Save
  // starts disabled and only lights up on a real edit.
  captureAgentDetailBaseline();

  $('#agent-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
}

export function closeAgentDetail() {
  $('#agent-detail')!.hidden = true;
  $('#agent-edit-view')!.hidden = false;
  $('#agent-create-view')!.hidden = true;
  selectedAgentId.value = null;
  agentDetailBaseline.value = null;
  renderAgents();
}

export function agentDetailSnapshot() {
  return {
    name: $<HTMLInputElement>('#agent-name')!.value.trim(),
    model: $<HTMLInputElement>('#agent-model')!.value || '',
    configModel: $<HTMLInputElement>('#agent-config-model')!.value.trim(),
    instructions: $<HTMLInputElement>('#agent-instructions')!.value,
  };
}

function captureAgentDetailBaseline() {
  agentDetailBaseline.value = agentDetailSnapshot();
  refreshAgentSaveDirty();
}

export function refreshAgentSaveDirty() {
  // By id: the form also contains #agent-skills-save (.btn-primary too), which
  // a first-match class query would grab instead.
  const btn = $('#agent-save-btn')! as HTMLInputElement;
  if (!btn || !agentDetailBaseline.value) return;
  // Don't fight the transient "Saving…" / "✓ Saved" button states.
  if (btn.classList.contains('success') || btn.textContent === 'Saving…') return;
  const now = agentDetailSnapshot();
  btn.disabled =
    now.name === agentDetailBaseline.value.name &&
    now.model === agentDetailBaseline.value.model &&
    now.configModel === agentDetailBaseline.value.configModel &&
    now.instructions === agentDetailBaseline.value.instructions;
}

let canManageAgentRooms = false;

export async function loadAgentRooms(agentId?: any) {
  try {
    agentDetailRooms.value = await apiJson(`/api/agents/${encodeURIComponent(agentId ?? '')}/rooms`);
    canManageAgentRooms = true;
  } catch {
    canManageAgentRooms = false;
    agentDetailRooms.value = [];
  }
  renderAgentWiredRooms();
  $('#agent-rooms-section')!.hidden = false;
}

let wiredRoomsApp: ReturnType<typeof createApp> | null = null;

function mountAgentWiredRooms(): void {
  wiredRoomsApp ??= mountIsland('#agent-wired-rooms', () =>
    createApp(AgentWiredRooms, {
      // Mirror of the room-settings → agent jump: click a room to open its
      // settings (openRoomDetail handles any roomId; it closes this agent panel).
      onOpenRoom: (roomId: string) => deps.openRoomDetail(roomId),
      onRemoveRoom: (roomId: string, roomName: string) => removeRoomFromAgent(roomId, roomName),
    }),
  );
}

function renderAgentWiredRooms() {
  const rooms = agentDetailRooms.value ?? [];
  const roomCount = $('#agent-rooms-count');
  if (roomCount) roomCount.textContent = rooms.length ? String(rooms.length) : '';
  wiredRooms.value = rooms;
  canManageRooms.value = canManageAgentRooms;
  mountAgentWiredRooms();
  // Assign control: any admin of this agent (owner or scoped); the backend
  // limits targets to rooms the caller can access. Outside the island, so imperative.
  $('#agent-add-room-toggle')!.hidden = !canManageAgentRooms;
}

async function removeRoomFromAgent(roomId?: any, roomName?: any) {
  if (!selectedAgentId.value) return;
  const confirmed = await deps.showConfirmModal({
    title: 'Remove from room',
    body: `Remove this agent from "${roomName}"? The room and its other agents are unaffected.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(selectedAgentId.value)}`, {
      method: 'DELETE',
    });
    showToast(`Removed from "${roomName}".`, { kind: 'success' });
    await loadAgentRooms(selectedAgentId.value);
  } catch (err) {
    showToast('Failed to remove from room: ' + (err as any)?.message, { kind: 'error' });
  }
}

let sessionsApp: ReturnType<typeof createApp> | null = null;
/**
 * Which agent the mounted session list belongs to. The reset callback reads it
 * rather than closing over the agentId of the call that mounted the app — the
 * app is created once and the detail pane is reopened for other agents, so a
 * captured id would reset the wrong agent's session.
 */
let sessionsAgentId: any = null;

function mountAgentSessions(): void {
  sessionsApp ??= mountIsland('#agent-sessions-list', () =>
    createApp(AgentSessions, {
      onReset: (sessionId: string, el: HTMLElement) => resetAgentSession(sessionsAgentId, sessionId, el),
    }),
  );
}

// Active sessions for an agent, each with a Reset control that injects /clear
// host-side — the only way to clear a background a2a session (a room-typed
// /clear only reaches the session you're in). Admin-gated server-side.
async function renderAgentSessions(agentId?: any) {
  const countEl = $('#agent-sessions-count');
  if (!$('#agent-sessions-list')) return;
  sessionsAgentId = agentId;
  sessionsPhase.value = 'loading';
  mountAgentSessions();
  let rows = [];
  try {
    rows = (await apiJson(`/api/agents/${encodeURIComponent(agentId ?? '')}/sessions`)).sessions || [];
  } catch (err) {
    // Bound as text, so the binding escapes it.
    sessionsError.value = `Sessions unavailable: ${(err as any)?.message}`;
    sessionsPhase.value = 'error';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = rows.length ? String(rows.length) : '';
  sessions.value = rows;
  sessionsPhase.value = 'ready';
}

async function resetAgentSession(agentId?: any, sessionId?: any, btn?: any) {
  const ok = await deps.showConfirmModal({
    title: 'Reset session',
    body: 'Inject /clear into this session — it drops the accumulated context and the next turn starts fresh. Useful when a session is stuck or "autocompact is thrashing".',
    confirmLabel: 'Reset',
  });
  if (!ok) return;
  btn!.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/reset`, { method: 'POST' });
    showToast('Session reset — /clear queued', { kind: 'success' });
    renderAgentSessions(agentId);
  } catch (err) {
    showToast('Could not reset: ' + (err as any)?.message, { kind: 'error' });
    btn!.disabled = false;
    btn.textContent = 'Reset';
  }
}

export async function continueAgentImport(up?: any) {
  const p = up.preview;
  const el = document.createElement('div');
  const line = (t?: any, cls?: any) => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = t;
    el.appendChild(d);
  };
  line(`${p.manifest.entity.name} → imports as “${p.suggestedName}” (${p.suggestedFolder})`);
  line(p.manifest.includesConversations ? 'Includes conversation history' : 'Config, memory and skills only');
  const roomsOk = p.rooms.filter((r: any) => r.found).map((r: any) => r.platform_id);
  const roomsMiss = p.rooms.filter((r: any) => !r.found).map((r: any) => r.platform_id);
  if (roomsOk.length) line(`Re-links rooms: ${roomsOk.join(', ')}`);
  if (roomsMiss.length) line(`⚠ Rooms not on this install (skipped): ${roomsMiss.join(', ')}`, 'import-warning');
  const mcpMiss = p.mcpServers.filter((m: any) => !m.found).map((m: any) => m.name);
  if (mcpMiss.length) line(`⚠ MCP servers to recreate: ${mcpMiss.join(', ')}`, 'import-warning');
  if (!p.modelFound && p.manifest.references.model)
    line(`⚠ Model not found here: ${p.manifest.references.model.model_id}`, 'import-warning');
  for (const c of p.manifest.requiredCredentials) line(`⚠ Needs: ${c}`, 'import-warning');
  const ok = await deps.showConfirmModal({ title: 'Import this agent?', body: el, confirmLabel: 'Import' });
  if (!ok) return;
  try {
    const out = await apiJson('/api/agents/import/apply', { method: 'POST', body: { token: up.token } });
    showToast(`Imported ${out.name}`, { kind: 'success' });
    await fetchAgents();
    renderAgents();
  } catch (err) {
    showToast('Import failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

// Learning defaults (agent-level layer): two On/Off pill pairs backed by the
// per-agent API. Room 🎓 settings override these — the section says so. The
// whole accordion hides for non-admins (the GET 403s).
async function renderAgentLearning(agentId?: any) {
  const section = $('#agent-learning-section');
  const accordion = section?.closest('details');
  if (!section) return;
  if (!state.learningMasterEnabled) {
    if (accordion) accordion.hidden = true; // master off — agents don't see it
    return;
  }
  let cfg = null;
  try {
    cfg = await apiJson(`/api/agents/${encodeURIComponent(agentId ?? '')}/learning`);
  } catch {}
  if (!cfg) {
    if (accordion) accordion.hidden = true;
    return;
  }
  if (accordion) accordion.hidden = false;
  $('#agent-learning-keep-row')!.hidden = !cfg.canAutoKeep;
  const paint = (groupEl?: any, on?: any) => {
    groupEl.querySelectorAll('.setting-option').forEach((b: any) => {
      b.classList.toggle('active', (b.dataset.on === '1') === on);
    });
  };
  paint($('#agent-learning-distill'), cfg.autoTrigger);
  paint($('#agent-learning-keep'), cfg.autoKeep);
  const wire = (groupEl?: any, key?: any) => {
    groupEl.querySelectorAll('.setting-option').forEach((b: any) => {
      b.onclick = async () => {
        const on = b.dataset.on === '1';
        try {
          await apiJson(`/api/agents/${encodeURIComponent(agentId ?? '')}/learning`, {
            method: 'PUT',
            body: { [key]: on },
          });
          paint(groupEl, on);
          showToast('Learning defaults saved');
        } catch (err) {
          toastError(err, 'Could not save');
        }
      };
    });
  };
  wire($('#agent-learning-distill'), 'autoTrigger');
  wire($('#agent-learning-keep'), 'autoKeep');

  const put = async (patch: any) => {
    await apiJson(`/api/agents/${encodeURIComponent(agentId ?? '')}/learning`, { method: 'PUT', body: patch });
  };

  // Review model — the agent's own model by default, or a roster entry / a
  // fixed Claude id (so Claude-only installs with an empty roster still have
  // choices). Roster options carry the roster id; the fixed entries carry
  // the raw Claude model id. Dormant until the digest review lands.
  const reviewSel = $('#agent-learning-review-model') as HTMLInputElement;
  if (reviewSel) {
    reviewSel.innerHTML = '';
    const addOpt = (value?: any, label?: any) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      reviewSel.appendChild(opt);
    };
    addOpt('', "Agent's model");
    try {
      const models = await apiJson('/api/models');
      for (const m of models) addOpt(m.id, `${m.name} (${m.model_id})`);
    } catch {
      /* roster unavailable — the default + Claude entries still render */
    }
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-5']) {
      if (![...(reviewSel as unknown as HTMLSelectElement).options].some((o) => o.value === id)) addOpt(id, id);
    }
    let stored = cfg.reviewModel || '';
    // A stored value no longer in the roster still shows as itself rather
    // than silently reading as the default.
    if (stored && ![...(reviewSel as unknown as HTMLSelectElement).options].some((o) => o.value === stored))
      addOpt(stored, stored);
    (reviewSel as HTMLInputElement).value = stored;
    reviewSel.onchange = async () => {
      try {
        await put({ reviewModel: (reviewSel as HTMLInputElement).value || null });
        stored = (reviewSel as HTMLInputElement).value;
        showToast('Learning defaults saved');
      } catch (err) {
        toastError(err, 'Could not save');
        reviewSel.value = stored;
      }
    };
  }

  // Review input — digest (default) or replay the full turn.
  const inputGroup = $('#agent-learning-review-input');
  if (inputGroup) {
    const paintInput = (replay?: any) => {
      inputGroup.querySelectorAll('.setting-option').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.value === (replay ? 'replay' : 'digest'));
      });
    };
    paintInput(cfg.replayReview === true);
    inputGroup.querySelectorAll('.setting-option').forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        const replay = (b as HTMLElement).dataset.value === 'replay';
        try {
          await put({ replayReview: replay });
          paintInput(replay);
          showToast('Learning defaults saved');
        } catch (err) {
          toastError(err, 'Could not save');
        }
      };
    });
  }
}

// Engage mode for the currently-loaded room, populated alongside the agents
// list. Only 'mention-only' exists (un-primed agents fire only when @-mentioned).
let roomDetailEngageMode = 'mention-only';

export async function refreshRoomWiredAgents(roomId?: any) {
  try {
    const [agentsRes, modeRes] = await Promise.all([
      authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`),
      authFetch(`/api/rooms/${encodeURIComponent(roomId)}/engage-mode`),
    ]);
    roomDetailWiredAgents.value = await agentsRes.json();
    await modeRes.json().catch(() => ({}));
    roomDetailEngageMode = 'mention-only';
  } catch (err) {
    console.error('Failed to fetch wired agents:', err);
    roomDetailWiredAgents.value = [];
    roomDetailEngageMode = 'mention-only';
  }
  renderRoomWiredAgents();
  await populateAddAgentSelect();
  void renderRoomSkills();
}

let roomWiredApp: ReturnType<typeof createApp> | null = null;

function mountRoomWiredAgents(): void {
  roomWiredApp ??= mountIsland('#room-wired-agents', () =>
    createApp(RoomWiredAgents, {
      onPrime: (agent: any) => togglePrimeAgent(agent),
      onRemove: (agent: any) => removeAgentFromRoom(agent.id, agent.name),
      onOpen: async (agent: any) => {
        // The agent-detail overlay is standalone and opens over the room view.
        if (!state.allAgents.some((x: any) => x.id === agent.id)) await fetchAgents();
        await openAgentDetail(agent.id);
      },
    }),
  );
}

export function renderRoomWiredAgents(): void {
  const wired = roomDetailWiredAgents.value ?? [];
  roomWiredRows.value = wired;
  mountRoomWiredAgents();

  // The reply-mode info button lives on the "Wired agents" LABEL line, outside
  // the list container, so it stays imperative — the island owns one <ul>.
  const anyPrime = wired.some((a: any) => a.is_prime);
  const effectiveMode = anyPrime ? 'prime' : roomDetailEngageMode;
  const modeTip =
    effectiveMode === 'prime'
      ? `Replies to everything: ${wired.find((a: any) => a.is_prime)?.name ?? 'unknown'} — except messages that @-mention a different agent.`
      : 'No agents reply unless @-mentioned. Star an agent to make it reply to everything.';
  const modeInfo = $('#room-mode-info');
  if (modeInfo) {
    modeInfo.hidden = false;
    modeInfo.className = `mode-info-btn mode-${effectiveMode}`;
    modeInfo.setAttribute('aria-label', `Reply mode — ${modeTip}`);
    // Reassign (not addEventListener) so re-renders don't stack handlers.
    modeInfo.onclick = (e) => {
      e.stopPropagation();
      toggleModeInfoPopup(modeInfo, modeTip);
    };
  }
}

async function togglePrimeAgent(agent?: any) {
  if (!selectedRoomId.value) return;
  const url = `/api/rooms/${encodeURIComponent(selectedRoomId.value)}/prime`;
  try {
    await apiJson(url, agent.is_prime ? { method: 'DELETE' } : { method: 'PUT', body: { agentId: agent.id } });
    await refreshRoomWiredAgents(selectedRoomId.value);
  } catch (err) {
    showToast('Could not update the default agent: ' + (err as any)?.message, { kind: 'error' });
  }
}

async function populateAddAgentSelect() {
  // Make sure allAgents is fresh for the picker (avoid showing stale list).
  if (state.allAgents.length === 0) await fetchAgents();
  const wiredIds = new Set(roomDetailWiredAgents.value.map((a: any) => a.id));
  // Never offer archived agents for wiring (even if the list toggle is on).
  addAgentCandidates.value = state.allAgents.filter((a: Agent) => !wiredIds.has(a.id) && a.status !== 'archived');
  mountAddAgentPicker();
  // Once here; the per-checkbox change listener keeps it in step after that.
  updateAddAgentSubmitLabel();
}

let addAgentPickerApp: ReturnType<typeof createApp> | null = null;

function mountAddAgentPicker(): void {
  addAgentPickerApp ??= mountIsland('#room-add-agent-list', () =>
    createApp(AddAgentPicker, { onToggle: () => updateAddAgentSubmitLabel() }),
  );
}

function updateAddAgentSubmitLabel() {
  const checked = $('#room-add-agent-list')!.querySelectorAll('input[type=checkbox]:checked');
  const btn = $('#room-add-agent-existing-submit')! as HTMLInputElement;
  const n = checked.length;
  btn.textContent = n > 0 ? `Wire selected (${n})` : 'Wire selected';
  btn!.disabled = n === 0;
}

export async function addExistingAgentToRoom() {
  if (!selectedRoomId.value) return;
  const checked = Array.from($('#room-add-agent-list')!.querySelectorAll('input[type=checkbox]:checked'));
  if (checked.length === 0) return;
  const ids = checked.map((cb) => (cb as HTMLInputElement).value);
  // Add each selected agent. POST /api/rooms/:id/agents currently takes one
  // agent per call; we issue them sequentially so a failure surfaces with
  // the matching agent and partial progress is preserved.
  $<HTMLInputElement>('#room-add-agent-existing-submit')!.disabled = true;
  try {
    for (const id of ids) {
      await addAgentToRoom(selectedRoomId.value, { kind: 'existing', id });
    }
  } finally {
    // populateAddAgentSelect re-runs after each addAgentToRoom (via the
    // refresh path), so the list is now empty of just-added entries.
    updateAddAgentSubmitLabel();
  }
}

export async function addNewAgentToRoom() {
  if (!selectedRoomId.value) return;
  const name = $<HTMLInputElement>('#room-add-agent-new-name')!.value.trim();
  if (!name) return;
  const instructions = $<HTMLInputElement>('#room-add-agent-new-instructions')!.value;
  await addAgentToRoom(selectedRoomId.value, { kind: 'new', name, instructions });
}

async function addAgentToRoom(roomId?: any, ref?: any) {
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/agents`, { method: 'POST', body: ref });
    $<HTMLInputElement>('#room-add-agent-new-name')!.value = '';
    $<HTMLInputElement>('#room-add-agent-new-instructions')!.value = '';
    // Refresh agents (in case a new one was created), then re-render wirings.
    await fetchAgents();
    await refreshRoomWiredAgents(roomId);
  } catch (err) {
    showToast('Failed to add agent: ' + (err as any)?.message, { kind: 'error' });
  }
}

async function removeAgentFromRoom(agentId?: any, agentName?: any) {
  if (!selectedRoomId.value) return;
  const confirmed = await deps.showConfirmModal({
    title: 'Remove agent',
    body: `Remove "${agentName}" from this room? The agent itself will not be deleted.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await apiJson(
      `/api/rooms/${encodeURIComponent(selectedRoomId.value)}/agents/${encodeURIComponent(agentId ?? '')}`,
      {
        method: 'DELETE',
      },
    );
    showToast(`Removed "${agentName}" from the room.`, { kind: 'success' });
    await refreshRoomWiredAgents(selectedRoomId.value);
  } catch (err) {
    showToast('Failed to remove agent: ' + (err as any)?.message, { kind: 'error' });
  }
}

let roomCreateChecklistApp: ReturnType<typeof createApp> | null = null;

function mountRoomCreateAgentChecklist(): void {
  roomCreateChecklistApp ??= mountIsland('#room-create-existing-agents', () => createApp(RoomCreateAgentChecklist));
}

export function renderRoomCreateAgentChecklist() {
  // The empty note keys off allAgents, the rows off the non-archived subset
  // (see createAgentAnyExist).
  createAgentAnyExist.value = state.allAgents.length > 0;
  createAgentCandidates.value = state.allAgents.filter((a: Agent) => a.status !== 'archived');
  mountRoomCreateAgentChecklist();
}

export function beginAgentTurn(name?: any) {
  const turn = ensureTurn(name);
  turn.startedAt = Date.now();
  turn.lastActivityAt = turn.startedAt;
  turn.reasoningLog.length = 0;
  turn.tools.length = 0;
  turn.notes.length = 0;
  // Owned by an active status turn, so the typing-heartbeat path won't clear it
  // during a quiet stretch; cleared with the turn on 'done'.
  turn.statusLive = true;
  ensureElapsedTimer();
  updateTurnElapsed();
  return turn;
}

export function endAgentTurn(name?: any) {
  removeTurn(name || state.agentName || 'Agent');
  if (turnElapsedTimer.value && !thinkingTurns.value.length) {
    clearInterval(turnElapsedTimer.value ?? undefined);
    turnElapsedTimer.value = null;
  }
}

// Remove every agent's bubble (room switch / reset).
export function endAllAgentTurns() {
  for (const t of [...thinkingTurns.value]) removeTurn(t.name);
  if (turnElapsedTimer.value) {
    clearInterval(turnElapsedTimer.value ?? undefined);
    turnElapsedTimer.value = null;
  }
}

// Interrupt ONE agent's in-progress turn (per-agent Stop) — sends a "stop" over
// the WS targeting that agent (the host resolves the name to its session). The
// GUI equivalent of the CLI's ESC. Removes that agent's bubble optimistically;
// the host's stream-abort + 'done' keep it gone.
export function interruptAgent(name?: any) {
  if (!state.currentRoom || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'interrupt', room_id: state.currentRoom, agent_name: name || null }));
  endAgentTurn(name);
  appendSystem(name ? `Stopped ${name}.` : 'Stopped.');
}

// Per-agent secrets. Isolation is the prerequisite, not a nicety: in the default
// `all` mode the gateway offers every vault secret to every agent, so a secret
// "for this agent" would in fact be handed to all of them. Isolating pins the
// agent's model credential and switches it to `selective` first.
let agentSecretsWired = false;

let agentEnvApp: ReturnType<typeof createApp> | null = null;
/** Whose env is mounted — the app is created once, the panel is reopened. */
let agentEnvGroupId: any = null;

function mountAgentEnv(): void {
  agentEnvApp ??= mountIsland('#agent-env-list', () =>
    createApp(AgentEnvList, {
      onRemove: async (name: string) => {
        agentEnvDeleting.value = new Set(agentEnvDeleting.value).add(name);
        try {
          await apiJson(
            `/api/agents/${encodeURIComponent(agentEnvGroupId ?? '')}/env?name=${encodeURIComponent(name)}`,
            {
              method: 'DELETE',
            },
          );
          showToast(`Removed $${name} — applies when the agent restarts`);
          void renderAgentEnv(agentEnvGroupId);
        } catch {
          showToast('Could not remove variable', { kind: 'error' });
        } finally {
          const next = new Set(agentEnvDeleting.value);
          next.delete(name);
          agentEnvDeleting.value = next;
        }
      },
    }),
  );
}

/**
 * Per-agent env vars. The list shows NAMES only — the server never returns a
 * value, so there is nothing to render and nothing to leak into a screenshot.
 */
async function renderAgentEnv(agentGroupId?: any) {
  if (!$('#agent-env-list')) return;
  agentEnvGroupId = agentGroupId;
  let names = [];
  try {
    names = (await apiJson(`/api/agents/${encodeURIComponent(agentGroupId ?? '')}/env`)).names || [];
  } catch {}
  $('#agent-env-count')!.textContent = names.length ? String(names.length) : '';
  agentEnvNames.value = names;
  mountAgentEnv();
  const save = $('#agent-env-save') as HTMLInputElement;
  if (save && !save.dataset.wired) {
    save.dataset.wired = '1';
    save.addEventListener('click', async () => {
      const id = $('#agent-secrets-section')!.dataset.agentId;
      const name = $<HTMLInputElement>('#agent-env-name')!.value.trim();
      const value = $<HTMLInputElement>('#agent-env-value')!.value;
      if (!name || !value) {
        showToast('Name and value are required', { kind: 'error' });
        return;
      }
      (save as HTMLInputElement).disabled = true;
      try {
        const r = await authFetch(`/api/agents/${encodeURIComponent(id ?? '')}/env`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
          body: JSON.stringify({ name, value }),
        });
        if (!r.ok) {
          showToast((await r.json().catch(() => ({}))).error || 'Could not add variable', { kind: 'error' });
          return;
        }
        // Clear the value first and always — it is the sensitive field.
        $<HTMLInputElement>('#agent-env-value')!.value = '';
        $<HTMLInputElement>('#agent-env-name')!.value = '';
        showToast(`Added $${name} — applies when the agent restarts`);
        void renderAgentEnv(id);
      } finally {
        save.disabled = false;
      }
    });
  }
}

// ── Who a new secret reaches ─────────────────────────────────────────────────
// The one choice the form asks. Three answers, nearest first, in the words the
// list uses for its sections — so what you pick here is what you will see it
// filed under. "Only me" can only ever mean the person typing: letting an admin
// pick someone else would require them to paste that person's token, which is
// what per-user credentials exist to prevent.
type SecretReachChoice = 'me' | 'agent' | 'all';
const REACH_HELP: Record<SecretReachChoice, string> = {
  me: 'Your turns only. Wins over the agent’s.',
  agent: 'Every member’s turns, unless they have their own.',
  all: 'Every agent, unless a nearer one exists.',
};
const REACH_ME_UNAVAILABLE = 'Only me needs your own Claude/Codex account — connect it from the @handle menu.';

function reachChoice(): SecretReachChoice {
  return ($('#agent-secrets-section')!.dataset.reach as SecretReachChoice) || 'agent';
}

function setReachChoice(choice: SecretReachChoice): void {
  const section = $('#agent-secrets-section')!;
  section.dataset.reach = choice;
  document.querySelectorAll('#agent-secret-reach .setting-option').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.value === choice);
  });
  // The reason Only me is greyed stays on the line whatever is picked — it
  // answers the question a greyed option raises, before and after the click.
  const why = section.dataset.meUnavailable === '1' ? ` ${REACH_ME_UNAVAILABLE}` : '';
  $('#agent-secret-reach-help')!.textContent = REACH_HELP[choice] + why;
}

/** Source words for the "For you" line — the section titles, possessive. */
const SOURCE_WORD: Record<string, string> = { user: 'yours', agent: 'this agent’s', workspace: 'all agents’' };

export async function renderAgentSecrets(agentGroupId?: any) {
  const section = $('#agent-secrets-section');
  if (!section) return;
  if (!agentSecretsWired) {
    agentSecretsWired = true;
    $('#agent-secret-save')!.addEventListener('click', () => {
      const agentGroupId = $('#agent-secrets-section')!.dataset.agentId;
      const choice = reachChoice();
      const scope =
        choice === 'me' ? { agentGroupId, userId: permsMyUserId.value } : choice === 'agent' ? agentGroupId : null;
      void saveToolSecret(scope, '#agent-secret');
    });
    $('#agent-secret-cancel')!.addEventListener('click', () => endSecretUpdate('#agent-secret'));
    // Greyed-but-clickable when unavailable (same idiom as the credential
    // providers); the reason is already on the help line, so a click just
    // leaves the current choice — nothing else is needed to confirm it.
    document.querySelectorAll('#agent-secret-reach .setting-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement;
        if (el.classList.contains('is-unavailable')) return;
        setReachChoice(el.dataset.value as SecretReachChoice);
      });
    });
    wireSecretKind('#agent-secret');
  }
  // The form is shared by every agent's panel: an update begun on another agent ends here.
  if (section.dataset.agentId !== agentGroupId) endSecretUpdate('#agent-secret');
  section.dataset.agentId = agentGroupId;

  let isolation = null;
  let secrets = [];
  let members = [];
  let effective: any[] = [];
  let workspace: any[] | null = null;
  try {
    const b = await apiJson(toolSecretUrl(agentGroupId));
    isolation = b.isolation;
    secrets = b.secrets || [];
    members = b.members || [];
    effective = b.effective || [];
    workspace = b.workspace ?? null;
  } catch {}

  // Isolation is install policy (CREDENTIAL_ISOLATION=fleet), not a per-agent
  // switch, so only report it — and only when it is NOT private. The form is
  // always available: the server creates (and isolates) a vault identity on first use.
  const isolated = !!isolation?.isolated;
  $('#agent-secrets-note')!.textContent =
    !isolated && isolation?.available ? 'Not private yet — secrets added here would also reach other agents' : '';
  $('#agent-secret-form')!.hidden = false;

  // "Only me" attaches to the caller's own per-member agent, which exists once
  // they have connected their login — offered greyed until then, with the
  // reason on click. "All agents" is the workspace scope: offered only to
  // someone the server let list it. Default to the nearest reach that works —
  // a pasted PAT is almost always the typist's own.
  const enrolled = members.some((m: any) => m.userId === permsMyUserId.value);
  const meBtn = $('#agent-secret-reach [data-value="me"]');
  const allBtn = $('#agent-secret-reach [data-value="all"]');
  if (meBtn) meBtn.classList.toggle('is-unavailable', !enrolled);
  if (allBtn) allBtn.hidden = workspace === null;
  section.dataset.meUnavailable = enrolled ? '' : '1';
  const current = reachChoice();
  const usable = (c: SecretReachChoice) => (c === 'me' ? enrolled : c === 'all' ? workspace !== null : true);
  setReachChoice(section.dataset.reach && usable(current) ? current : enrolled ? 'me' : 'agent');

  renderAgentSecretList(agentGroupId, secrets, members, workspace, effective);
  const mine = members.find((m: any) => m.userId === permsMyUserId.value)?.secrets.length ?? 0;
  const total = secrets.length + (workspace?.length ?? 0) + members.reduce((n: any, m: any) => n + m.secrets.length, 0);
  $('#agent-secrets-count')!.textContent = total ? (mine ? `${total} · ${mine} only you` : String(total)) : '';
}

let agentSecretsApp: ReturnType<typeof createApp> | null = null;
/**
 * The agent whose secrets are mounted. removeToolSecret needs it, and the app
 * is created once while the panel is reopened for other agents — so the
 * callback reads this rather than capturing the render call's argument.
 */
let agentSecretsGroupId: any = null;

function mountAgentSecretList(): void {
  agentSecretsApp ??= mountIsland('#agent-secrets-list', () =>
    createApp(AgentSecretList, {
      onRemove: (r: { scope: unknown; sec: unknown }) =>
        void removeToolSecret(r.scope, r.sec, '#agent-secrets-list', agentSecretsGroupId),
      onUpdate: (r: { scope: unknown; sec: unknown }) => startSecretUpdate('#agent-secret', r.scope, r.sec),
    }),
  );
}

/**
 * One row per credential: the host, a scope pill, and Remove. `personal` gets
 * the accent colour because it is the exception worth noticing.
 */
function renderAgentSecretList(agentGroupId?: any, secrets?: any, members?: any, workspace?: any, effective?: any) {
  agentSecretsGroupId = agentGroupId;
  // Precedence, read back from the server: for each host, which scope the
  // VIEWER's turns are served from. A row a nearer one beats says so, so two
  // same-host rows never read as a tie.
  const servedFrom = new Map<string, string>((effective ?? []).map((e: any) => [e.hostPattern, e.source]));
  const beatenNote = (host: string, own: 'agent' | 'workspace') => {
    const src = servedFrom.get(host);
    if (!src || src === own) return '';
    return src === 'user' ? 'yours is used instead' : 'this agent’s is used instead';
  };
  const rows = [
    ...(members ?? []).flatMap((m: any) => {
      const mine = m.userId === permsMyUserId.value;
      return (m.secrets ?? []).map((s: any) => ({
        key: `user:${m.userId}:${s.hostPattern}`,
        host: s.hostPattern,
        reach: mine ? ('mine' as const) : ('other' as const),
        ownerLabel: mine ? '' : userDisplayName({ id: m.userId }),
        note: '',
        canRemove: mine,
        scope: { agentGroupId, userId: m.userId },
        sec: s,
      }));
    }),
    ...(secrets ?? []).map((s: any) => ({
      key: `agent:${s.hostPattern}`,
      host: s.hostPattern,
      reach: 'agent' as const,
      ownerLabel: '',
      note: beatenNote(s.hostPattern, 'agent'),
      canRemove: true,
      scope: agentGroupId,
      sec: s,
    })),
    // Present only for someone who may list (and so remove) the workspace scope.
    ...(workspace ?? []).map((s: any) => ({
      key: `workspace:${s.hostPattern}`,
      host: s.hostPattern,
      reach: 'workspace' as const,
      ownerLabel: '',
      note: beatenNote(s.hostPattern, 'workspace'),
      canRemove: true,
      scope: null,
      sec: s,
    })),
  ];
  agentSecretRows.value = rows;
  // The direct answer, in one line: what goes out for YOU, per host.
  const parts = (effective ?? []).map((e: any) => `${e.hostPattern} → ${SOURCE_WORD[e.source] ?? e.source}`);
  agentSecretEffective.value = parts.length ? `For you: ${parts.join(' · ')}` : 'For you: no credential yet';
  mountAgentSecretList();
}

let agentKeysWired = false;
let agentKeysApp: any = null;
/**
 * Which agent the mounted list belongs to. The island outlives any one render,
 * so its Remove handler reads this rather than capturing a render argument —
 * the same reason agentSecretsGroupId exists.
 */
let agentKeysGroupId: any = null;

function mountAgentKeyList(): void {
  agentKeysApp ??= mountIsland('#agent-keys-list', () =>
    createApp(AgentKeyList, {
      onCopy: async (r: { publicKey: string }) => {
        try {
          await navigator.clipboard.writeText(r.publicKey);
          showToast('Public key copied');
        } catch {
          showToast('Could not copy', { kind: 'error' });
        }
      },
      onRemove: (r: { key: unknown }) => void removeAgentKey(agentKeysGroupId, r.key),
    }),
  );
}

async function renderAgentKeys(agentGroupId?: any) {
  const section = $('#agent-keys-section');
  if (!section) return;
  if (!agentKeysWired) {
    agentKeysWired = true;
    $('#agent-key-create')!.addEventListener('click', () => void createAgentKey());
  }
  section.dataset.agentId = agentGroupId;

  let keys = [];
  try {
    keys = (await apiJson(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? '')}`)).keys || [];
  } catch {}

  agentKeysGroupId = agentGroupId;
  agentKeyRows.value = keys.map((k: any) => ({
    name: k.name,
    meta: k.target ? `ssh -i ${k.path} ${k.target}` : `${k.path} · no login target set`,
    publicKey: k.publicKey,
    key: k,
  }));
  mountAgentKeyList();
  $('#agent-keys-count')!.textContent = keys.length ? String(keys.length) : '';
}

async function createAgentKey() {
  const agentGroupId = $('#agent-keys-section')!.dataset.agentId;
  const name = $<HTMLInputElement>('#agent-key-name')!.value.trim().toLowerCase();
  const target = $<HTMLInputElement>('#agent-key-target')!.value.trim();
  if (!name) {
    showToast('Name is required', { kind: 'error' });
    return;
  }
  const btn = $('#agent-key-create')! as HTMLInputElement;
  (btn as HTMLInputElement).disabled = true;
  try {
    const body = await apiJson(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? '')}`, {
      method: 'POST',
      // target (user@host) rides in the key's comment: it tells the agent who to log in as.
      body: target ? { name, target } : { name },
    });
    $<HTMLInputElement>('#agent-key-name')!.value = '';
    $<HTMLInputElement>('#agent-key-target')!.value = '';
    // The public key is only useful once it's on the far end, so put it on the
    // clipboard immediately rather than making them hunt for the copy button.
    try {
      await navigator.clipboard.writeText(body.key.publicKey);
      showToast(`Created ${name} — public key copied`);
    } catch {
      showToast(`Created ${name}`);
    }
    await renderAgentKeys(agentGroupId);
  } catch (err) {
    showToast((err as any)?.body?.error || 'Could not create key', { kind: 'error' });
  } finally {
    btn!.disabled = false;
  }
}

export async function removeAgentKey(agentGroupId?: any, key?: any) {
  const ok = await deps.showConfirmModal({
    title: 'Remove deploy key',
    body: `Delete “${key.name}”? Anything using it to authenticate will stop working.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!ok) return;
  const r = await authFetch(
    `/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? '')}&name=${encodeURIComponent(key.name)}`,
    { method: 'DELETE', headers: { 'X-Webchat-CSRF': '1' } },
  );
  if (!r.ok) {
    showToast('Could not remove key', { kind: 'error' });
    return;
  }
  showToast(`Removed ${key.name}`);
  await renderAgentKeys(agentGroupId);
}

// ── Agent → Model assignment ──────────────────────────────────────────────
// The Model picker in the agent edit form, populated on every openAgentDetail
// and saved with the other agent fields.
function populateAgentModelSelect(currentModelId?: any) {
  // #agent-model is a hidden input holding the chosen id; Save reads it.
  $<HTMLInputElement>('#agent-model')!.value = currentModelId || '';
  refreshAgentModelTrigger();
}

/**
 * Update the picker trigger button's labels to reflect the currently-
 * assigned model. Two-line layout: name on top, kind+model_id+host underneath.
 * No selection → "Default" / "Built-in Anthropic".
 */
export function refreshAgentModelTrigger() {
  const trigger = $('#agent-model-trigger');
  if (!trigger) return;
  const id = $<HTMLInputElement>('#agent-model')!.value;
  const nameEl = trigger.querySelector('.model-picker-trigger-name')!;
  const metaEl = trigger.querySelector('.model-picker-trigger-meta')!;
  if (!id) {
    nameEl.textContent = 'Default';
    // No webchat model assigned. If the agent runs on a non-Claude provider,
    // surface its real model instead of the misleading "Built-in Anthropic".
    const derived = state.allAgents.find((a: any) => a.id === selectedAgentId.value)?.effective_model_label;
    metaEl.textContent = derived ? `${derived} · auto-detected` : 'Built-in Anthropic';
    return;
  }
  const m = allModels.value.find((mm: any) => mm.id === id);
  if (!m) {
    nameEl.textContent = 'Unknown model';
    metaEl.textContent = id;
    return;
  }
  nameEl.textContent = m.name ?? '';
  const host = endpointHost(m.endpoint);
  metaEl.textContent = host
    ? `${deps.modelKindLabel(m.kind)} · ${m.model_id} · ${host}`
    : `${deps.modelKindLabel(m.kind)} · ${m.model_id}`;
}

// Status labels + the one-line hint shown under the detail control.
export const AGENT_STATUS_HINTS: Record<string, string> = {
  active: 'Responds normally and appears everywhere.',
  paused: 'Wiring is kept, but the agent never responds. Still listed.',
  archived: 'Retired: never responds and hidden from lists, pickers, and the map.',
};

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The agent detail panel: the close buttons, the edit form fields, harness,
// status and egress controls, the archived toggle and room attachment.
// Called from composition-root.ts at its place in boot order rather than run at module scope (check-boot-order.sh).

const HARNESS_LABEL: Record<string, string> = { claude: 'Claude', opencode: 'OpenCode', pi: 'pi', codex: 'Codex', grok: 'Grok' };

/**
 * A harness that is not installed: offer the install (owners), follow it
 * through the host restart it ends with, then make the switch that was asked.
 */
// An image build plus restart takes minutes; past this the page stops watching.
const HARNESS_INSTALL_WATCH_MS = 10 * 60_000;

async function offerHarnessInstall(agentId: string, provider: string): Promise<void> {
  const label = HARNESS_LABEL[provider] ?? provider;
  const ok = await showConfirmModal({
    title: `Install ${label}?`,
    body: 'Rebuilds the agent image, then restarts. A few minutes.',
    confirmLabel: 'Install',
  });
  if (!ok) return;
  // The wizard's install window: progress line, then the install's own log.
  const line = $('#agent-harness-install')!;
  line.hidden = false;
  line.textContent = 'Installing…';
  const url = `/api/install/${encodeURIComponent(provider)}`;
  try {
    const res = await authFetch(url, { method: 'POST' });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      if (err.code !== 'already-installed') throw new Error(err.error || `HTTP ${res.status}`);
    }
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      if (Date.now() - started > HARNESS_INSTALL_WATCH_MS)
        throw new Error('Still installing after 10 minutes: check back in Settings later');
      // The install ends with a host restart: a failed poll is the restart, not the end.
      const st = await authFetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!st) {
        line.textContent = `Restarting… ${Math.round((Date.now() - started) / 1000)}s`;
        continue;
      }
      const tail: string[] = Array.isArray(st.lines) ? st.lines.slice(-14) : [];
      if (st.installed && !st.running) break;
      if (!st.running && st.exitCode && st.exitCode !== 0) {
        line.textContent = ['Install failed:', ...tail].join('\n');
        throw new Error('Install failed');
      }
      line.textContent = st.running ? [installProgressLine(st), ...tail].join('\n') : tail.join('\n') || 'Restarting…';
    }
    line.hidden = true;
    await apiJson(`/api/agents/${encodeURIComponent(agentId)}/provider`, { method: 'PUT', body: { provider } });
    showToast(`${label} installed`, { kind: 'success' });
    await fetchAgents();
    if (selectedAgentId.value === agentId) setAgentHarnessControl(provider);
  } catch (err) {
    if (!line.textContent?.startsWith('Install failed')) line.textContent = String((err as Error)?.message || err);
    toastError(err, `${label} not installed`);
  }
}

export function wireAgentsPanel(): void {
  $('#agent-harness-control')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.setting-option');
    if (!btn || !selectedAgentId.value) return;
    const provider = btn.dataset.provider;
    const agent = state.allAgents.find((a) => a.id === selectedAgentId.value);
    if (!agent || (agent.provider || 'claude') === provider) return; // no change
    setAgentHarnessControl(provider); // optimistic
    try {
      await apiJson(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/provider`, {
        method: 'PUT',
        body: { provider },
      });
      showToast(`Harness → ${provider === 'opencode' ? 'OpenCode' : 'Claude'} — restarting the agent…`, {
        kind: 'success',
      });
      await fetchAgents();
    } catch (err) {
      setAgentHarnessControl(agent.provider); // revert
      if ((err as { body?: { code?: string } })?.body?.code === 'not-installed' && state.isOwnerView && provider) {
        void offerHarnessInstall(selectedAgentId.value, provider);
        return;
      }
      toastError(err, 'Could not change harness');
    }
  });

  // Agent-detail sub-tabs: Settings (status/name/model/MCP/rooms) vs Instructions.
  // Instructions lives behind a tab so it doesn't dominate a panel that's mostly
  // used for quick status/model/wiring tweaks. All fields share one <form>, so a
  // hidden tab's values still submit on Save.
  document.querySelectorAll<HTMLElement>('#agent-edit-view .agent-subtab').forEach((tab) => {
    tab.addEventListener('click', () => setAgentSubtab(tab.dataset.subtab));
  });

  $<HTMLButtonElement>('#agent-detail-close')?.addEventListener('click', closeAgentDetail);
  $<HTMLButtonElement>('#agent-create-close')?.addEventListener('click', closeAgentDetail);

  // Save persists only name / model / instructions (everything else auto-saves
  // on its own control), so dirty-track those three and keep Save disabled otherwise.
  $<HTMLInputElement>('#agent-name')?.addEventListener('input', refreshAgentSaveDirty);
  $<HTMLTextAreaElement>('#agent-instructions')?.addEventListener('input', refreshAgentSaveDirty);
  $<HTMLInputElement>('#agent-config-model')?.addEventListener('input', refreshAgentSaveDirty);

  // Status control: each button PUTs the new status, then refreshes the list so
  // the badge + (if archived) visibility update immediately.
  $('#agent-status-control')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.setting-option');
    if (!btn || !selectedAgentId.value) return;
    const status = btn.dataset.status;
    // Type guard only: every .setting-option here carries data-status.
    if (!status) return;
    const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
    if (agent && (agent.status || 'active') === status) return;
    setAgentStatusControl(status); // optimistic
    try {
      await apiJson(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/status`, {
        method: 'PUT',
        body: { status },
      });
      if (agent) agent.status = status;
      showToast(`${status[0].toUpperCase()}${status.slice(1)} — ${AGENT_STATUS_HINTS[status] || ''}`);
      renderAgents();
    } catch (err) {
      console.error('Failed to set agent status:', err);
      showToast('Could not change status', { kind: 'error' });
      if (agent) setAgentStatusControl(agent.status); // revert
    }
  });

  // Egress control. Only a move to Open confirms (see below).
  $('#agent-egress-control')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.setting-option');
    if (!btn || btn.disabled || !selectedAgentId.value) return;
    const egress = btn.dataset.egress;
    const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
    const current = (agent && agent.egress) || 'host-only';
    if (current === egress) return;

    if (egress === 'open') {
      // Loosening is the direction that needs a second look: open egress leaves
      // from central's address, past the organisation's own network controls.
      const ok = await showConfirmModal({
        title: 'Open network for this agent?',
        body: 'Any host. Next start.',
        confirmLabel: 'Open',
        destructive: true,
      });
      if (!ok) return;
    }

    setAgentEgressControl(egress); // optimistic
    try {
      const out = await apiJson(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/egress`, {
        method: 'PUT',
        body: { egress },
      });
      if (agent) agent.egress = egress;
      const label = egress === 'open' ? 'Open' : egress === 'none' ? 'Model only' : 'Allowlist';
      const now = out?.appliesNow;
      showToast(`${label} — ${now ? 'applies now' : 'applies at next start'}`);
    } catch (err) {
      console.error('Failed to set agent egress:', err);
      showToast('Could not change network mode', { kind: 'error' });
      setAgentEgressControl(current); // revert
    }
  });

  // Show / hide archived agents in the list.
  $<HTMLButtonElement>('#agent-show-archived')?.addEventListener('click', async () => {
    showArchivedAgents.value = !showArchivedAgents.value;
    await fetchAgents();
  });

  // ── Agent ↔ Room wiring (agent-centric; mirror of the room-detail panel) ──────
  // Read = GET /api/agents/:id/rooms (any admin of the agent). Writes go to
  // POST/DELETE /api/rooms/:roomId/agents, which allow owners plus scoped admins
  // of this agent (the backend enforces per-room access). The GET succeeding
  // (res.ok) already means the caller administers this agent, so we reuse it as
  // the signal for showing the assign / remove controls — no owner-only gate.
  // "+ Wire to room" opens the shared attach picker — toggle the agent in/out of
  // any room. (Rooms are created from the room list, so no "+ Add new" here.)
  $<HTMLButtonElement>('#agent-add-room-toggle')?.addEventListener('click', async () => {
    const agentId = selectedAgentId.value;
    if (!agentId) return;
    let allRooms: any[] = [];
    try {
      allRooms = await apiJson('/api/rooms');
    } catch {}
    deps.openAttachPicker({
      title: 'Rooms',
      searchPlaceholder: 'Search rooms…',
      emptyText: 'No rooms yet.',
      items: () => allRooms,
      searchText: (r: any) => r.name || r.id,
      name: (r: any) => r.name || r.id,
      isAttached: (r: any) => agentDetailRooms.value.some((x: any) => x.id === r.id),
      onToggle: async (r: any, add: any) => {
        if (add) {
          await apiJson(`/api/rooms/${encodeURIComponent(r.id)}/agents`, {
            method: 'POST',
            body: { kind: 'existing', id: agentId },
          });
        } else {
          await apiJson(`/api/rooms/${encodeURIComponent(r.id)}/agents/${encodeURIComponent(agentId)}`, {
            method: 'DELETE',
          });
        }
        showToast(add ? `Wired to ${r.name || r.id}` : `Unwired from ${r.name || r.id}`, { kind: 'success' });
        await loadAgentRooms(agentId);
      },
    });
  });
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Remaining agent-detail wiring: the secrets, env and deploy-key controls.
// One function per run of boot statements: a call cannot span an executing statement without reordering boot.

export function wireAgentDetail1(): void {
  $<HTMLFormElement>('#agent-detail-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedAgentId.value) return;
    const btn = $<HTMLButtonElement>('#agent-save-btn');
    if (!btn) return;
    const originalLabel = btn.textContent;
    btn!.disabled = true;
    btn.textContent = 'Saving…';
    btn.classList.remove('success');
    const updates = {
      name: ($<HTMLInputElement>('#agent-name')?.value ?? '').trim(),
    };
    try {
      // Update agent config
      await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      // Update instructions
      await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/instructions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: $<HTMLTextAreaElement>('#agent-instructions')?.value ?? '' }),
      });
      // Update model assignment (empty string in the select = unassign).
      const selectedModel = ($<HTMLInputElement>('#agent-model')?.value ?? '') || null;
      const currentModel = state.allAgents.find((b) => b.id === selectedAgentId.value)?.assigned_model_id || null;
      if (selectedModel !== currentModel) {
        const mRes = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/model`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: selectedModel }),
        });
        try {
          if (mRes.ok) deps.warnIfUnreachable((await mRes.json()).reachability);
        } catch {
          /* reachability is best-effort */
        }
      }
      // Pinned Anthropic model (container_configs.model). This one restarts the
      // agent, so only send it when changed — and surface a rejection, never swallow it.
      const configModel = ($<HTMLInputElement>('#agent-config-model')?.value ?? '').trim();
      const currentConfigModel = state.allAgents.find((b) => b.id === selectedAgentId.value)?.config_model || '';
      if (configModel !== currentConfigModel) {
        const cRes = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/config-model`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: configModel }),
        });
        if (!cRes.ok) {
          let detail = `HTTP ${cRes.status}`;
          try {
            detail = (await cRes.json()).error || detail;
          } catch {
            /* keep the status */
          }
          // don't leave a lie on screen
          const cfgModel = $<HTMLInputElement>('#agent-config-model');
          if (cfgModel) cfgModel.value = currentConfigModel;
          throw new Error(detail);
        }
      }
      await fetchAgents();
      // Don't re-openAgentDetail: it re-fetches instructions and resets the
      // cursor. The list re-render is what makes a rename visible.
      agentDetailBaseline.value = agentDetailSnapshot(); // what we just saved is the new clean state
      btn.textContent = '✓ Saved';
      btn.classList.add('success');
      setTimeout(() => {
        // Only restore if the user hasn't navigated away (form still mounted).
        if (btn.isConnected) {
          btn.textContent = originalLabel;
          btn.classList.remove('success');
          refreshAgentSaveDirty(); // baseline == current → back to disabled
        }
      }, 1500);
    } catch (err: any) {
      console.error('Failed to update agent:', err);
      showToast('Failed to save agent: ' + (err.message || 'Unknown error'), { kind: 'error' });
      btn.textContent = originalLabel;
      btn.classList.remove('success');
      btn!.disabled = false;
    }
  });
}

export function wireAgentDetail2(): void {
  $<HTMLButtonElement>('#room-add-agent-existing-submit')?.addEventListener('click', addExistingAgentToRoom);
}

export function wireAgentDetail3(): void {
  $<HTMLButtonElement>('#agent-model-trigger')?.addEventListener('click', () => {
    if (selectedAgentId.value) openModelPicker();
  });
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Agent detail controls: delete, MCP attach, secrets and env.

export function wireAgentControls1(): void {
  $<HTMLButtonElement>('#agent-export-btn')?.addEventListener('click', async () => {
    if (!selectedAgentId.value) return;
    const {
      ok,
      checks: [checked, withSecrets],
    } = await confirmWithToggle({
      title: 'Export this agent?',
      toggleLabels: ['Include conversations (larger; briefly stops this agent)', 'Include deploy keys'],
      note: 'Other credentials never export — the bundle lists what to reconnect on import.',
      confirmLabel: 'Export',
    });
    if (!ok) return;
    const q = new URLSearchParams();
    if (checked) q.set('conversations', '1');
    if (withSecrets) q.set('secrets', '1');
    const a = document.createElement('a');
    a.href = `/api/agents/${encodeURIComponent(selectedAgentId.value)}/export${q.toString() ? `?${q}` : ''}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Export started — check your downloads', { kind: 'success' });
  });
}

export function wireAgentControls2(): void {
  $<HTMLButtonElement>('#import-agent-btn')?.addEventListener('click', () =>
    $<HTMLInputElement>('#import-agent-file')?.click(),
  );
  $<HTMLInputElement>('#import-agent-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!file) return;
    showToast('Uploading bundle…', { kind: 'info' });
    let up;
    try {
      const fd = new FormData();
      fd.append('bundle', file);
      const res = await authFetch('/api/agents/import', { method: 'POST', body: fd });
      up = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(up.error || res.statusText);
    } catch (err: any) {
      showToast('Import failed: ' + (err?.message || err), { kind: 'error' });
      return;
    }
    return continueAgentImport(up);
  });
}

export function wireAgentControls3(): void {
  $<HTMLButtonElement>('#agent-mcp-attach-toggle')?.addEventListener('click', async () => {
    const agentId = selectedAgentId.value;
    if (!agentId) return;
    await fetchMcpServers();
    openAttachPicker({
      title: 'MCP servers',
      searchPlaceholder: 'Search servers…',
      emptyText: 'No servers yet — use “+ Add new server”.',
      addNewLabel: '+ Add new server',
      items: () => allMcpServers.value,
      searchText: (s: any) => `${s.name} ${s.transport} ${s.target}`,
      name: (s: any) => s.name,
      meta: (s: any) => `${s.transport} · ${s.target}`,
      isAttached: (s: any) => agentMcpServers.value.some((a: any) => a.id === s.id),
      onToggle: (s: any, add: any) =>
        setAgentMcp(
          agentId,
          add ? { add: [s.id] } : { remove: [s.id] },
          add ? `Attached ${s.name}` : `Detached ${s.name}`,
        ),
      onAddNew: () => {
        mcpAddInProgress.value = true;
        mcpAgentForAdd.value = agentId;
        closeAttachPicker();
        setTimeout(() => $<HTMLButtonElement>('#create-mcp-btn')?.click(), 180);
      },
    });
  });
}

export function wireAgentControls4(): void {
  $<HTMLButtonElement>('#agent-delete')?.addEventListener('click', async () => {
    if (!selectedAgentId.value) return;
    const agent = state.allAgents.find((b: any) => b.id === selectedAgentId.value);
    const confirmed = await showConfirmModal({
      title: 'Delete agent',
      body: `Delete "${agent?.name}"? This removes the agent, its workspace, and all session history. This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await apiJson(`/api/agents/${encodeURIComponent(selectedAgentId.value)}`, { method: 'DELETE' });
      showToast(`Deleted "${agent?.name}".`, { kind: 'success' });
      closeAgentDetail();
      await fetchAgents();
    } catch (err: any) {
      showToast(`Failed to delete agent: ${err.message}`, { kind: 'error' });
    }
  });
}

export function wireAgentControls5(): void {
  $<HTMLButtonElement>('#room-add-agent-new-submit')?.addEventListener('click', addNewAgentToRoom);
  document.querySelectorAll<HTMLElement>('.room-agent-picker-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document
        .querySelectorAll<HTMLElement>('.room-agent-picker-tab')
        .forEach((t: any) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.picker;
      const existing = $('#room-add-agent-existing');
      const fresh = $('#room-add-agent-new');
      if (existing) existing.hidden = which !== 'existing';
      if (fresh) fresh.hidden = which !== 'new';
    });
  });
}

// ── Panel wiring ───────────────────────────────────────────────────────────

export function wireAgentCreate1(): void {
  $<HTMLButtonElement>('#create-agent-btn')?.addEventListener('click', () => {
    selectedAgentId.value = null;
    renderAgents();
    const el1 = $('#agent-edit-view');
    if (el1) el1.hidden = true;
    const el2 = $('#agent-create-view');
    if (el2) el2.hidden = false;
    const _el1 = $<HTMLInputElement>('#agent-create-name');
    if (_el1) _el1.value = '';
    const el3 = $('#agent-detail');
    if (el3) el3.hidden = false;
    const el4 = $('#members-panel');
    if (el4) el4.hidden = true;
    $<HTMLInputElement>('#agent-create-name')?.focus();
  });
}

export function wireAgentCreate2(): void {
  $<HTMLButtonElement>('#create-mcp-btn')?.addEventListener('click', () => {
    selectedMcpId.value = null;
    renderMcpServers();
    closeAgentDetail();
    closeRoomDetail();
    closeModelDetail();
    closeMcpDetail();
    const el5 = $('#mcp-edit-view');
    if (el5) el5.hidden = true;
    const el6 = $('#mcp-create-view');
    if (el6) el6.hidden = false;
    // Reset the probe block + manual form between opens.
    const _el2 = $<HTMLInputElement>('#mcp-probe-url');
    if (_el2) _el2.value = '';
    const el7 = $('#mcp-probe-status');
    if (el7) el7.hidden = true;
    const el8 = $('#mcp-probe-results');
    if (el8) el8.hidden = true;
    const _el3 = $<HTMLInputElement>('#mcp-probe-name');
    if (_el3) _el3.value = '';
    const _el4 = $<HTMLInputElement>('#mcp-probe-token');
    if (_el4) _el4.value = '';
    const h1 = $<HTMLLabelElement>('#mcp-probe-token-label');
    if (h1) h1.hidden = true;
    lastMcpProbe.value = null;
    lastMcpProbeToken.value = '';
    const _el5 = $<HTMLInputElement>('#mcp-create-name');
    if (_el5) _el5.value = '';
    const _el6 = $<HTMLInputElement>('#mcp-create-url');
    if (_el6) _el6.value = '';
    const _el7 = $<HTMLInputElement>('#mcp-create-command');
    if (_el7) _el7.value = '';
    const _el8 = $<HTMLTextAreaElement>('#mcp-create-args');
    if (_el8) _el8.value = '';
    const _el9 = $<HTMLInputElement>('#mcp-create-token');
    if (_el9) _el9.value = '';
    const _el10 = $<HTMLSelectElement>('#mcp-create-transport');
    if (_el10) _el10.value = 'http';
    syncMcpCreateTransportFields();
    const el9 = $('#mcp-detail');
    if (el9) el9.hidden = false;
    const el10 = $('#members-panel');
    if (el10) el10.hidden = true;
  });
}

// Click-to-open help popup for the reply-mode icon. Toggles, and dismisses on
// outside-click or Escape (mirrors the thread/room menu dismissal pattern).
export function toggleModeInfoPopup(anchor: HTMLElement, text: string) {
  // Anchor to the label row (not the icon) so the popup left-aligns to the
  // panel content and never overflows the narrow drawer's right edge.
  const wrap = anchor.closest('.form-label-row');
  const existing = wrap!.querySelector('.mode-info-popup');
  if (existing) {
    existing.remove();
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'mode-info-popup';
  pop.setAttribute('role', 'tooltip');
  pop.textContent = text;
  wrap!.appendChild(pop);
  const close = (e?: Event) => {
    if (e && (pop.contains(e.target as Node) || anchor.contains(e.target as Node))) return;
    pop.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }, 0);
}

type SecretKind = 'token' | 'custom' | 'basic';

function secretKind(p: string): SecretKind {
  return ($(`${p}-kind`)?.dataset.kind as SecretKind) || 'token';
}

/**
 * The Type choice decides which fields the form shows: a token (scheme inferred
 * from the host), a token with a stated header, or a username + password the
 * server encodes as HTTP Basic. Wired once per form; hidden rows stay in the
 * DOM so values survive switching away and back.
 */
export function wireSecretKind(p: string) {
  const group = $(`${p}-kind`);
  if (!group || group.dataset.wired) return;
  group.dataset.wired = '1';
  const buttons = group.querySelectorAll<HTMLElement>('.setting-option');
  const set = (kind: SecretKind) => {
    group.dataset.kind = kind;
    buttons.forEach((btn) => {
      const on = btn.dataset.value === kind;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    $(`${p}-value-row`)!.hidden = kind === 'basic';
    $(`${p}-username-row`)!.hidden = kind !== 'basic';
    $(`${p}-password-row`)!.hidden = kind !== 'basic';
    $(`${p}-custom-header-row`)!.hidden = kind !== 'custom';
    $(`${p}-custom-format-row`)!.hidden = kind !== 'custom';
  };
  buttons.forEach((btn) => btn.addEventListener('click', () => set(btn.dataset.value as SecretKind)));
  set('token');
}

export function endpointHost(endpoint: string) {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function showDetail(title: string, html: string) {
  $('#dash-detail-title')!.textContent = title;
  $('#dash-detail-body')!.innerHTML = html;
  $('#dash-detail')!.hidden = false;
  $('#dash-detail')!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Scope → query string. `null` = system-wide, a string = that agent,
 * `{agentGroupId,userId}` = that one person's credential.
 */
export function toolSecretUrl(scope: any, extra = '') {
  if (scope && typeof scope === 'object')
    return `/api/tool-secrets?agentGroupId=${encodeURIComponent(scope.agentGroupId)}&userId=${encodeURIComponent(scope.userId)}${extra}`;
  return `/api/tool-secrets?agentGroupId=${encodeURIComponent(scope ?? '*')}${extra}`;
}

// ── Turn liveness ─────────────────────────────────────────────────────────
// The thinking bubble follows the turn lifecycle (start → done/stalled), NOT
// the typing heartbeat, so it survives long quiet operations. One bubble per
// agent (thinkingTurns, keyed by name); one shared ticker updates every
// elapsed counter.
const TURN_QUIET_MS = 5000;

export function markTurnActivity(name: string) {
  const turn = turnFor(name);
  if (turn) turn.lastActivityAt = Date.now();
}

// Ticked on an interval: writes each turn's elapsed label into state for the
// bubble component to render.
export function updateTurnElapsed() {
  for (const t of thinkingTurns.value) {
    const secs = Math.floor((Date.now() - t.startedAt) / 1000);
    if (secs < 2) {
      t.elapsed = '';
      continue;
    }
    const quiet = Date.now() - t.lastActivityAt > TURN_QUIET_MS;
    t.elapsed = quiet ? ` · still working ${secs}s` : ` · ${secs}s`;
  }
  if (!thinkingTurns.value.length && turnElapsedTimer.value) {
    clearInterval(turnElapsedTimer.value);
    turnElapsedTimer.value = null;
  }
}

export function ensureElapsedTimer() {
  if (!turnElapsedTimer.value) turnElapsedTimer.value = setInterval(updateTurnElapsed, 1000);
}

// ── Tool secrets ────────────────────────────────────────────────────────────
// Per-agent API credentials held in the gateway vault, so a token never has to
// be typed into a room (where it would persist in the message DB). Write-only:
// the server returns metadata only.

let secretsWired = false;

// System-wide secrets: created unassigned, so every agent in the default `all`
// secret mode can use them. Per-agent secrets live on the agent (see
// renderAgentSecrets) and require that agent to be isolated first.
export async function renderToolSecrets() {
  const section = $('#settings-secrets');
  if (!section) return;
  section.hidden = !state.isOwnerView;
  if (!state.isOwnerView) return;
  if (!secretsWired) {
    secretsWired = true;
    $('#secret-save')!.addEventListener('click', () => void saveToolSecret());
    $('#secret-cancel')!.addEventListener('click', () => endSecretUpdate('#secret'));
    wireSecretKind('#secret');
  }
  await loadToolSecretList();
}

let toolSecretsApp: any = null;
/** The scope the mounted list belongs to — the remove callback reads it. */
let toolSecretsScope: any = null;

function mountToolSecrets() {
  toolSecretsApp ??= mountIsland('#secrets-list', () =>
    createApp(ToolSecretList, {
      onRemove: (secret: any) => void removeToolSecret(toolSecretsScope, secret, '#secrets-list'),
      onUpdate: (secret: any) => startSecretUpdate('#secret', toolSecretsScope, secret),
    }),
  );
}

export async function loadToolSecretList(scope: any = null, listSel: string | null = '#secrets-list') {
  // listSel is kept for the signature, but '#secrets-list' is the only selector
  // that reaches here: removeToolSecret routes an agent-scoped delete to
  // renderAgentSecrets, which repaints the OTHER island.
  if (listSel !== '#secrets-list' || !$('#secrets-list')) return;
  toolSecretsScope = scope;
  let secrets = [];
  try {
    secrets = (await apiJson(toolSecretUrl(scope))).secrets || [];
  } catch {
    secrets = [];
  }
  toolSecretRows.value = secrets;
  mountToolSecrets();
}

/**
 * A form in update mode: the secret it will overwrite, and the scope it lives
 * in. Keyed by form (the agent panel's, Settings'), since both can be open.
 */
const secretUpdates: Record<string, { scope: any; secret: any } | undefined> = {};

/**
 * Update an existing secret with the form it was added with: its host filled
 * in and fixed (the host is what the credential is — another host is remove
 * and add), who uses it fixed too, its current kind chosen (a custom header's
 * fields filled in), and the value empty: the server never sends it back.
 */
export function startSecretUpdate(p: string, scope: any, secret: any) {
  secretUpdates[p] = { scope, secret };
  const host = $<HTMLInputElement>(`${p}-host`)!;
  host.value = secret.hostPattern;
  host.readOnly = true;
  const kind: SecretKind = secret.kind === 'basic' || secret.kind === 'custom' ? secret.kind : 'token';
  $<HTMLElement>(`${p}-kind [data-value="${kind}"]`)?.click();
  if (kind === 'custom') {
    $<HTMLInputElement>(`${p}-custom-header`)!.value = secret.headerName ?? '';
    $<HTMLInputElement>(`${p}-custom-format`)!.value = secret.valueFormat ?? '';
  }
  for (const f of ['value', 'username', 'password']) $<HTMLInputElement>(`${p}-${f}`)!.value = '';
  const reach = $(`${p}-reach`)?.closest<HTMLElement>('.secret-reach');
  if (reach) reach.hidden = true;
  $(`${p}-save`)!.textContent = 'Update secret';
  $(`${p}-cancel`)!.hidden = false;
  const first = $<HTMLInputElement>(kind === 'basic' ? `${p}-username` : `${p}-value`);
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  first?.focus({ preventScroll: true });
}

/** Back to adding: the form as it was, its fields cleared. */
export function endSecretUpdate(p: string) {
  if (!secretUpdates[p]) return;
  secretUpdates[p] = undefined;
  const host = $<HTMLInputElement>(`${p}-host`);
  if (host) {
    host.readOnly = false;
    host.value = '';
  }
  for (const f of ['value', 'username', 'password', 'custom-header', 'custom-format']) {
    const el = $<HTMLInputElement>(`${p}-${f}`);
    if (el) el.value = '';
  }
  const reach = $(`${p}-reach`)?.closest<HTMLElement>('.secret-reach');
  if (reach) reach.hidden = false;
  const save = $(`${p}-save`);
  if (save) save.textContent = 'Add secret';
  const cancel = $(`${p}-cancel`);
  if (cancel) cancel.hidden = true;
}

export async function saveToolSecret(scope: any = null, p = '#secret') {
  const update = secretUpdates[p];
  if (update) scope = update.scope;
  const hostPattern = $<HTMLInputElement>(`${p}-host`)!.value.trim();
  const kind = secretKind(p);
  let body: Record<string, unknown>;
  if (kind === 'basic') {
    // The server base64-encodes the pair and validates it; nothing is encoded here.
    const username = $<HTMLInputElement>(`${p}-username`)!.value.trim();
    const password = $<HTMLInputElement>(`${p}-password`)!.value;
    if (!hostPattern || !username || !password) {
      showToast('Host, username and password are required', { kind: 'error' });
      return;
    }
    body = { hostPattern, basic: { username, password } };
  } else {
    const value = $<HTMLInputElement>(`${p}-value`)!.value;
    if (!hostPattern || !value) {
      showToast('Host and value are required', { kind: 'error' });
      return;
    }
    // Token = the server infers the auth scheme from the host (right for a
    // public API). Custom header = the operator states it, for a host that
    // cannot say which service answers. The server validates the pair; the
    // client never decides what is a safe header.
    let scheme: any;
    if (kind === 'custom') {
      const headerName = $<HTMLInputElement>(`${p}-custom-header`)?.value.trim() || '';
      const valueFormat = $<HTMLInputElement>(`${p}-custom-format`)?.value.trim() || '';
      if (!headerName || !valueFormat) {
        showToast('A custom header needs both a name and a value template', { kind: 'error' });
        return;
      }
      scheme = { headerName, valueFormat };
    }
    body = scheme ? { value, hostPattern, scheme } : { value, hostPattern };
  }

  const btn = $<HTMLButtonElement>(`${p}-save`);
  btn!.disabled = true;
  try {
    if (update) {
      // The host is the secret's own and is not sent: the server keeps it.
      delete body.hostPattern;
      await apiJson(toolSecretUrl(scope, `&id=${encodeURIComponent(update.secret.id)}`), { method: 'PUT', body });
    } else await apiJson(toolSecretUrl(scope), { method: 'POST', body });
    // Clear the sensitive fields first and always — they must not linger in
    // the DOM after a successful write.
    $<HTMLInputElement>(`${p}-value`)!.value = '';
    $<HTMLInputElement>(`${p}-password`)!.value = '';
    $<HTMLInputElement>(`${p}-username`)!.value = '';
    $<HTMLInputElement>(`${p}-host`)!.value = '';
    if ($(`${p}-custom-header`)) $<HTMLInputElement>(`${p}-custom-header`)!.value = '';
    if ($(`${p}-custom-format`)) $<HTMLInputElement>(`${p}-custom-format`)!.value = '';
    showToast(update ? `Updated ${hostPattern}` : `Added ${hostPattern}`);
    if (update) endSecretUpdate(p);
    // The agent panel's form can add at any reach, including all-agents — so
    // it repaints by which FORM was used, not by the scope written.
    if (p === '#agent-secret') await renderAgentSecrets($('#agent-secrets-section')!.dataset.agentId);
    else if (scope) await renderAgentSecrets(typeof scope === 'object' ? scope.agentGroupId : scope);
    if (!scope) await loadToolSecretList(null, '#secrets-list');
  } catch (err) {
    showToast((err as any)?.body?.error || (update ? 'Could not update secret' : 'Could not add secret'), {
      kind: 'error',
    });
  } finally {
    btn!.disabled = false;
  }
}

export async function removeToolSecret(
  scope: any,
  secret: any,
  listSel: string | null = '#secrets-list',
  agentGroupId = null,
) {
  const ok = await showConfirmModal({
    title: 'Remove secret',
    body: `Delete the credential for ${secret.hostPattern}? Requests that rely on it will start failing.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!ok) return;
  try {
    await apiJson(toolSecretUrl(scope, `&id=${encodeURIComponent(secret.id)}`), { method: 'DELETE' });
    showToast(`Removed ${secret.label}`);
    if (agentGroupId) await renderAgentSecrets(agentGroupId);
    else if (listSel) await loadToolSecretList(scope, listSel);
    // A workspace row removed from the agent panel is also a Settings row.
    if (scope === null && agentGroupId && $('#secrets-list')) await loadToolSecretList(null, '#secrets-list');
    // listSel === null: the caller owns its own re-render (My credentials).
  } catch {
    showToast('Could not remove secret', { kind: 'error' });
  }
}
