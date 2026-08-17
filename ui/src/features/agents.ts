// ── Agents ───────────────────────────────────────────────────────────────────
// The agents surface: the list, the detail pane and its dirty/save tracking,
// per-agent controls (status, harness, egress), room wiring, and the secrets /
// deploy-key panels.
//
// The largest cluster left after skills, and the most public — agents are
// referenced from nearly every other view, so the export count stays high even
// though the coupling does not.
import { createApp, watchEffect } from 'vue';
import { toolSecretRows } from './tool-secrets-state.js';
import ToolSecretList from './ToolSecretList.vue';
import { userDisplayName } from './perms-user-info.js';
import { selectedRoomId } from './room-list-state.js';
import { allModels } from './model-list-state.js';
import { agentMcpServers, allMcpServers, lastMcpProbe, lastMcpProbeToken, mcpAddInProgress, mcpAgentForAdd, selectedMcpId } from './mcp-list-state.js';
import { permsAgents, permsMyUserId } from './perms-list-state.js';
import RoomWiredAgents from './RoomWiredAgents.vue';
import { roomWiredRows } from './room-wired-state.js';
import AgentList from './AgentList.vue';
import { agentSortAz, selectedAgentId } from './agent-list-state.js';
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
import { agentDetailBaseline, agentDetailRooms, archivedAgentsCount, canManageRooms, roomDetailWiredAgents, sessions, sessionsError, sessionsPhase, showArchivedAgents, turnElapsedTimer, wiredRooms } from './agent-detail-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { closeModelDetail, openModelPicker } from './models.js';
import { confirmWithToggle, showConfirmModal, showInputModal } from './modals.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import type { Agent } from '../core/state.js';
import { isAdminView } from '../core/state.js';
import { appendSystem } from './transcript.js';
import { ensureTurn, removeTurn } from './thinking.js';
import { thinkingTurns, turnFor } from './transcript-state.js';
import { closeMcpDetail, fetchMcpServers, renderAgentMcp, renderMcpServers, setAgentMcp, syncMcpCreateTransportFields } from './mcp.js';
import { renderAgentSkills, renderRoomSkills } from './skills.js';
import { closeAttachPicker, openAttachPicker } from './files.js';
import { closeRoomDetail } from './rooms.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideAgentsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
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

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideAgentsDeps(provided: Partial<AgentsDeps>): void {
  Object.assign(deps, provided);
}

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

export function mentionAgentColor(handle?: any) {
  const a = (deps.getWiredAgentsForCurrentRoom() || []).find((x: any) => (x.folder || '').toLowerCase() === handle);
  return a && a.name ? agentColor(a.name) : null;
}

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
    // Always fetch WITH archived and split here — the toggle needs the
    // archived COUNT even while they are hidden ("Show 2 archived", like the
    // sidebar's rooms toggle), and a second fetch just to count would be a
    // round-trip for one integer. state.allAgents still carries exactly what
    // it always carried: the visible set for the current toggle, so pickers,
    // the map and the matrix are unaffected.
    const res = await authFetch('/api/agents?includeArchived=1');
    const all = await res.json();
    const archived = all.filter((a: any) => a.status === 'archived');
    archivedAgentsCount.value = archived.length;
    state.allAgents = showArchivedAgents.value ? all : all.filter((a: any) => a.status !== 'archived');
    renderAgents();
  } catch (err) {
    console.error('Failed to fetch agents:', err);
  }
}


let agentListApp: ReturnType<typeof createApp> | null = null;

/**
 * Mount the AgentList island into <ul id="agent-list">, once.
 *
 * Vue replaces the mount element's children, and this <ul> has no server-
 * rendered content, so there is nothing to hydrate — a plain createApp is
 * correct here rather than createSSRApp.
 */
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

  // Creating an agent needs admin authority of some kind — `createAgentHandler`
  // is fronted by `isAnyAdmin` (owner OR global admin OR scoped admin of any
  // group). `isAdminView` is the client's copy of that same question, set when
  // /api/users succeeds, which is open to any admin. So this deliberately uses
  // the ADMIN signal, not the owner one: gating on owner here would hide the
  // button from scoped admins who are allowed to press it.
  watchEffect(() => {
    const btn = $('#create-agent-btn');
    if (btn) btn.hidden = !isAdminView.value;
  });
}

export function renderAgents(): void {
  // Mount-once, then sync. The island re-renders from state.allAgents on its
  // own — that is the point — but the two values it needs that are NOT reactive
  // still live in legacy.js, so they are pushed into refs here. Every one of
  // this function's eight call sites keeps working unchanged; only the
  // implementation stopped touching the DOM.
  mountAgentList();

  // "Show / hide archived" toggle — the SIDEBAR's contract, for consistency:
  // count-bearing text ("Show 2 archived"), and hidden entirely when nothing
  // is archived. A standing "Show archived agents" button on an install with
  // zero archived agents was a control that could only reveal nothing.
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


export function setAgentEgressControl(egress?: any) {
  const mode = egress || 'open';
  const ctl = $('#agent-egress-control');
  if (!ctl) return;
  ctl.querySelectorAll('.setting-option').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.egress === mode);
  });
  const badge = $('#agent-egress-badge');
  if (badge) badge.textContent = mode === 'open' ? '' : mode === 'host-only' ? 'Locked down' : mode;
  const note = $('#agent-egress-note');
  if (!note) return;
  const cliOnly = mode !== 'open' && mode !== 'host-only';
  note.hidden = !cliOnly;
  if (cliOnly) note.textContent = `Set to "${mode}" with ncl — not changeable here`;
  ctl.querySelectorAll('.setting-option').forEach((b) => ((b as HTMLInputElement).disabled = cliOnly));
}

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
const HARNESS_OPTIONS = ['claude', 'opencode', 'pi', 'codex'] as const;

export function setAgentHarnessControl(provider?: any) {
  // Was `provider === 'opencode' ? 'opencode' : 'claude'`, which collapsed every
  // OTHER harness onto Claude: an agent on pi stored pi, ran pi, and displayed
  // Claude. The control disagreed with the server and there was no way to tell
  // from the panel which harness a group was actually using. Match the value.
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
  setAgentEgressControl(agent.egress);
  void renderAgentEnv(id);

  // Load instructions (instructions.prepend.md — the provider-neutral standing
  // instructions composed into every provider's CLAUDE.md at spawn).
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(id ?? "")}/instructions`);
    if (res.ok) {
      const { content, legacyBytes } = await res.json();
      $<HTMLInputElement>('#agent-instructions')!.value = content;
      // A group can hold a big pre-cutover CLAUDE.local.md that this editor no
      // longer writes. Say so, rather than showing an empty box for an agent
      // that visibly has instructions.
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
  // #agent-save-btn by id — the form also contains #agent-skills-save
  // (.btn-primary too), and a first-match class query used to grab THAT,
  // leaving the real Save permanently disabled. See the markup note.
  const btn = ($('#agent-save-btn')!) as HTMLInputElement;
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
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/rooms`);
    canManageAgentRooms = res.ok;
    agentDetailRooms.value = res.ok ? await res.json() : [];
  } catch {
    canManageAgentRooms = false;
    agentDetailRooms.value = [];
  }
  renderAgentWiredRooms();
  $('#agent-rooms-section')!.hidden = false;
}

let wiredRoomsApp: ReturnType<typeof createApp> | null = null;

function mountAgentWiredRooms(): void {
  if (wiredRoomsApp) return;
  const host = $('#agent-wired-rooms');
  if (!host) return;
  wiredRoomsApp = createApp(AgentWiredRooms, {
    // Mirror of the room-settings → agent jump: click a room to open its
    // settings (openRoomDetail handles any roomId; it closes this agent panel).
    onOpenRoom: (roomId: string) => deps.openRoomDetail(roomId),
    onRemoveRoom: (roomId: string, roomName: string) => removeRoomFromAgent(roomId, roomName),
  });
  wiredRoomsApp.mount(host);
}

function renderAgentWiredRooms() {
  const rooms = agentDetailRooms.value ?? [];
  const roomCount = $('#agent-rooms-count');
  if (roomCount) roomCount.textContent = rooms.length ? String(rooms.length) : '';
  wiredRooms.value = rooms;
  canManageRooms.value = canManageAgentRooms;
  mountAgentWiredRooms();
  // Assign control: any admin of this agent (owner or scoped). The backend
  // limits the actual targets to rooms the caller can access.
  //
  // Outside the mount point, so it stays imperative — as does the count above.
  // An island owns the subtree it is mounted on and nothing else.
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
    const res = await authFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(selectedAgentId.value)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Failed to remove from room: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
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
  if (sessionsApp) return;
  const host = $('#agent-sessions-list');
  if (!host) return;
  sessionsApp = createApp(AgentSessions, {
    onReset: (sessionId: string, el: HTMLElement) => resetAgentSession(sessionsAgentId, sessionId, el),
  });
  sessionsApp.mount(host);
}

async function renderAgentSessions(agentId?: any) {
  const countEl = $('#agent-sessions-count');
  if (!$('#agent-sessions-list')) return;
  sessionsAgentId = agentId;
  sessionsPhase.value = 'loading';
  mountAgentSessions();
  let rows = [];
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/sessions`);
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    rows = (await res.json()).sessions || [];
  } catch (err) {
    // Bound as text, so the binding escapes it — the imperative version had to
    // call esc() because it was building an innerHTML string.
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
    const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/reset`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
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
  if (!p.modelFound && p.manifest.references.model) line(`⚠ Model not found here: ${p.manifest.references.model.model_id}`, 'import-warning');
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
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/learning`);
    if (res.ok) cfg = await res.json();
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
          const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/learning`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: on }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
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
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/learning`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
  };

  // Review model — the agent's own model by default, or a roster entry / a
  // fixed Claude id (so Claude-only installs with an empty roster still have
  // choices). Roster options carry the roster id; the fixed entries carry
  // the raw Claude model id. Dormant until the digest review lands (#353).
  const reviewSel = ($('#agent-learning-review-model')) as HTMLInputElement;
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
      const models = await (await authFetch('/api/models')).json();
      for (const m of models) addOpt(m.id, `${m.name} (${m.model_id})`);
    } catch {
      /* roster unavailable — the default + Claude entries still render */
    }
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-5']) {
      if (![...((reviewSel as unknown as HTMLSelectElement).options)].some((o) => o.value === id)) addOpt(id, id);
    }
    let stored = cfg.reviewModel || '';
    // A stored value no longer in the roster still shows as itself rather
    // than silently reading as the default.
    if (stored && ![...((reviewSel as unknown as HTMLSelectElement).options)].some((o) => o.value === stored)) addOpt(stored, stored);
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
  if (roomWiredApp) return;
  const host = $('#room-wired-agents');
  if (!host) return;
  roomWiredApp = createApp(RoomWiredAgents, {
    onPrime: (agent: any) => togglePrimeAgent(agent),
    onRemove: (agent: any) => removeAgentFromRoom(agent.id, agent.name),
    onOpen: async (agent: any) => {
      // The agent-detail overlay is standalone and opens over the room view.
      if (!state.allAgents.some((x: any) => x.id === agent.id)) await fetchAgents();
      await openAgentDetail(agent.id);
    },
  });
  roomWiredApp.mount(host);
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
    const res = agent.is_prime
      ? await authFetch(url, { method: 'DELETE' })
      : await authFetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agent.id }),
        });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Could not update the default agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
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
  // Still called once here, as before. The per-checkbox change listener keeps
  // it in step after that; the island re-renders only when the candidate list
  // itself changes, which is exactly when the imperative version rebuilt the
  // <ul> and cleared the ticks.
  updateAddAgentSubmitLabel();
}

let addAgentPickerApp: ReturnType<typeof createApp> | null = null;

function mountAddAgentPicker(): void {
  if (addAgentPickerApp) return;
  const host = $('#room-add-agent-list');
  if (!host) return;
  addAgentPickerApp = createApp(AddAgentPicker, { onToggle: () => updateAddAgentSubmitLabel() });
  addAgentPickerApp.mount(host);
}

function updateAddAgentSubmitLabel() {
  const checked = $('#room-add-agent-list')!.querySelectorAll('input[type=checkbox]:checked');
  const btn = ($('#room-add-agent-existing-submit')!) as HTMLInputElement;
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
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ref),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Failed to add agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
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
    const res = await authFetch(
      `/api/rooms/${encodeURIComponent(selectedRoomId.value)}/agents/${encodeURIComponent(agentId ?? "")}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Failed to remove agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    showToast(`Removed "${agentName}" from the room.`, { kind: 'success' });
    await refreshRoomWiredAgents(selectedRoomId.value);
  } catch (err) {
    showToast('Failed to remove agent: ' + (err as any)?.message, { kind: 'error' });
  }
}

let roomCreateChecklistApp: ReturnType<typeof createApp> | null = null;

function mountRoomCreateAgentChecklist(): void {
  if (roomCreateChecklistApp) return;
  const host = $('#room-create-existing-agents');
  if (!host) return;
  roomCreateChecklistApp = createApp(RoomCreateAgentChecklist);
  roomCreateChecklistApp.mount(host);
}

export function renderRoomCreateAgentChecklist() {
  // The empty note keys off allAgents, the rows off the non-archived subset —
  // not the same predicate. Preserved rather than harmonised; see the note in
  // the component.
  createAgentAnyExist.value = state.allAgents.length > 0;
  createAgentCandidates.value = state.allAgents.filter((a: Agent) => a.status !== 'archived');
  mountRoomCreateAgentChecklist();
}

export function beginAgentTurn(name?: any) {
  const turn = ensureTurn(name);
  turn.startedAt = Date.now();
  turn.lastActivityAt = turn.startedAt;
  turn.reasoningLog.length = 0;
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

export function endAllAgentTurns() {
  for (const t of [...thinkingTurns.value]) removeTurn(t.name);
  if (turnElapsedTimer.value) {
    clearInterval(turnElapsedTimer.value ?? undefined);
    turnElapsedTimer.value = null;
  }
}

export function interruptAgent(name?: any) {
  if (!state.currentRoom || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'interrupt', room_id: state.currentRoom, agent_name: name || null }));
  endAgentTurn(name);
  appendSystem(name ? `Stopped ${name}.` : 'Stopped.');
}

let agentSecretsWired = false;

let agentEnvApp: ReturnType<typeof createApp> | null = null;
/** Whose env is mounted — the app is created once, the panel is reopened. */
let agentEnvGroupId: any = null;

function mountAgentEnv(): void {
  if (agentEnvApp) return;
  const host = $('#agent-env-list');
  if (!host) return;
  agentEnvApp = createApp(AgentEnvList, {
    onRemove: async (name: string) => {
      agentEnvDeleting.value = new Set(agentEnvDeleting.value).add(name);
      try {
        const r = await authFetch(
          `/api/agents/${encodeURIComponent(agentEnvGroupId ?? '')}/env?name=${encodeURIComponent(name)}`,
          { method: 'DELETE', headers: { 'X-Webchat-CSRF': '1' } },
        );
        if (!r.ok) throw new Error('delete failed');
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
  });
  agentEnvApp.mount(host);
}

async function renderAgentEnv(agentGroupId?: any) {
  if (!$('#agent-env-list')) return;
  agentEnvGroupId = agentGroupId;
  let names = [];
  try {
    const r = await authFetch(`/api/agents/${encodeURIComponent(agentGroupId ?? "")}/env`);
    if (r.ok) names = (await r.json()).names || [];
  } catch {}
  $('#agent-env-count')!.textContent = names.length ? String(names.length) : '';
  agentEnvNames.value = names;
  mountAgentEnv();
  const save = ($('#agent-env-save')) as HTMLInputElement;
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
        const r = await authFetch(`/api/agents/${encodeURIComponent(id ?? "")}/env`, {
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

export async function renderAgentSecrets(agentGroupId?: any) {
  const section = $('#agent-secrets-section');
  if (!section) return;
  if (!agentSecretsWired) {
    agentSecretsWired = true;
    $('#agent-secret-save')!.addEventListener('click', () => {
      const agentGroupId = $('#agent-secrets-section')!.dataset.agentId;
      // "Personal" can only ever mean the person typing. Letting an admin pick
      // someone else would require them to paste that person's token — which
      // defeats the point of per-user credentials.
      const personal = $<HTMLInputElement>('#agent-secret-personal')!.checked;
      void saveToolSecret(personal ? { agentGroupId, userId: permsMyUserId.value } : agentGroupId, '#agent-secret');
    });
    wireCustomScheme('#agent-secret');
  }
  section.dataset.agentId = agentGroupId;

  let isolation = null;
  let secrets = [];
  let members = [];
  try {
    const r = await authFetch(toolSecretUrl(agentGroupId));
    if (r.ok) {
      const b = await r.json();
      isolation = b.isolation;
      secrets = b.secrets || [];
      members = b.members || [];
    }
  } catch {}

  // Isolation is install policy (CREDENTIAL_ISOLATION=fleet), not a per-agent
  // switch — a toggle here would appear to work and then be undone at the next
  // spawn. Report the state, and only explain when it is NOT private.
  // The form is always available: a group with no vault identity yet gets one
  // created (and isolated) on first use, server-side. The note only speaks up
  // in the state that would actually be unsafe.
  const isolated = !!isolation?.isolated;
  $('#agent-secrets-note')!.textContent =
    !isolated && isolation?.available ? 'Not private yet — secrets added here would also reach other agents' : '';
  $('#agent-secret-form')!.hidden = false;

  // Personal credentials attach to the caller's own per-member agent, which
  // only exists once they have connected their credentials — so the option is
  // offered only when it would actually work.
  const enrolled = members.some((m: any) => m.userId === permsMyUserId.value);
  const personalBox = ($('#agent-secret-personal')!) as HTMLInputElement;
  const personalRow = $('#agent-secret-personal-row')!;
  personalRow.hidden = !enrolled;
  if (!enrolled) personalBox.checked = false;

  renderAgentSecretList(agentGroupId, secrets, members);
  const total = secrets.length + members.reduce((n: any, m: any) => n + m.secrets.length, 0);
  $('#agent-secrets-count')!.textContent = total ? String(total) : '';
}

let agentSecretsApp: ReturnType<typeof createApp> | null = null;
/**
 * The agent whose secrets are mounted. removeToolSecret needs it, and the app
 * is created once while the panel is reopened for other agents — so the
 * callback reads this rather than capturing the render call's argument.
 */
let agentSecretsGroupId: any = null;

function mountAgentSecretList(): void {
  if (agentSecretsApp) return;
  const host = $('#agent-secrets-list');
  if (!host) return;
  agentSecretsApp = createApp(AgentSecretList, {
    onRemove: (r: { scope: unknown; sec: unknown }) =>
      void removeToolSecret(r.scope, r.sec, '#agent-secrets-list', agentSecretsGroupId),
  });
  agentSecretsApp.mount(host);
}

function renderAgentSecretList(agentGroupId?: any, secrets?: any, members?: any) {
  agentSecretsGroupId = agentGroupId;
  // Flattened here, because the DOM was always one flat <ul> — the two loops
  // were an artifact of sharing a row() builder, not a structure the markup had.
  // Only personal rows need to say WHOSE; "shared" already says everyone's.
  const rows = [
    ...(secrets ?? []).map((s: any) => ({
      key: `shared:${s.hostPattern}`,
      host: s.hostPattern,
      personal: false,
      ownerLabel: '',
      scope: agentGroupId,
      sec: s,
    })),
    ...(members ?? []).flatMap((m: any) =>
      (m.secrets ?? []).map((s: any) => ({
        key: `user:${m.userId}:${s.hostPattern}`,
        host: s.hostPattern,
        personal: true,
        ownerLabel: userDisplayName({ id: m.userId }),
        scope: { agentGroupId, userId: m.userId },
        sec: s,
      })),
    ),
  ];
  agentSecretRows.value = rows;
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
  if (agentKeysApp) return;
  const host = $('#agent-keys-list');
  if (!host) return;
  agentKeysApp = createApp(AgentKeyList, {
    onCopy: async (r: { publicKey: string }) => {
      try {
        await navigator.clipboard.writeText(r.publicKey);
        showToast('Public key copied');
      } catch {
        showToast('Could not copy', { kind: 'error' });
      }
    },
    onRemove: (r: { key: unknown }) => void removeAgentKey(agentKeysGroupId, r.key),
  });
  agentKeysApp.mount(host);
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
    const r = await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? "")}`);
    if (r.ok) keys = (await r.json()).keys || [];
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
  const btn = ($('#agent-key-create')!) as HTMLInputElement;
  (btn as HTMLInputElement).disabled = true;
  try {
    const r = await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? "")}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ name }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showToast(body.error || 'Could not create key', { kind: 'error' });
      return;
    }
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
  } catch {
    showToast('Could not create key', { kind: 'error' });
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
    `/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? "")}&name=${encodeURIComponent(key.name)}`,
    { method: 'DELETE', headers: { 'X-Webchat-CSRF': '1' } },
  );
  if (!r.ok) {
    showToast('Could not remove key', { kind: 'error' });
    return;
  }
  showToast(`Removed ${key.name}`);
  await renderAgentKeys(agentGroupId);
}

function populateAgentModelSelect(currentModelId?: any) {
  // The <select> was replaced by a button-driven picker; agent-model is now
  // a hidden input that holds the chosen id. The existing save handler in
  // saveAgentDetail still reads `$<HTMLInputElement>('#agent-model').value`.
  $<HTMLInputElement>('#agent-model')!.value = currentModelId || '';
  refreshAgentModelTrigger();
}

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
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireAgentsPanel() at the exact line the
// first block occupied, so execution order is unchanged.

export function wireAgentsPanel(): void {
  $('#agent-harness-control')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.setting-option');
    if (!btn || !selectedAgentId.value) return;
    const provider = btn.dataset.provider;
    const agent = state.allAgents.find((a) => a.id === selectedAgentId.value);
    if (!agent || (agent.provider || 'claude') === provider) return; // no change
    setAgentHarnessControl(provider); // optimistic
    try {
      const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/provider`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      showToast(`Harness → ${provider === 'opencode' ? 'OpenCode' : 'Claude'} — restarting the agent…`, {
        kind: 'success',
      });
      await fetchAgents();
    } catch (err) {
      setAgentHarnessControl(agent.provider); // revert
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

  // The bottom agent-detail "Save" persists only name / model / instructions —
  // status, learning defaults, MCP, skills, secrets and rooms each auto-save on
  // their own controls. Dirty-track those three so Save is disabled when there's
  // nothing to persist; otherwise it flashes "✓ Saved" on a no-op click and reads
  // as doing nothing. Mirrors the disabled-until-dirty "Save skills" button.
  $<HTMLInputElement>('#agent-name')?.addEventListener('input', refreshAgentSaveDirty);
  $<HTMLTextAreaElement>('#agent-instructions')?.addEventListener('input', refreshAgentSaveDirty);
  $<HTMLInputElement>('#agent-config-model')?.addEventListener('input', refreshAgentSaveDirty);
  $('#agent-status-control')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.setting-option');
    if (!btn || !selectedAgentId.value) return;
    const status = btn.dataset.status;
    // Every .setting-option in #agent-status-control carries data-status, so this
    // is a type guard rather than a behaviour change: without it `status[0]` a few
    // lines down would throw on undefined, which is what the JS did.
    if (!status) return;
    const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
    if (agent && (agent.status || 'active') === status) return;
    setAgentStatusControl(status); // optimistic
    try {
      const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('status ' + res.status);
      if (agent) agent.status = status;
      showToast(`${status[0].toUpperCase()}${status.slice(1)} — ${AGENT_STATUS_HINTS[status] || ''}`);
      renderAgents();
    } catch (err) {
      console.error('Failed to set agent status:', err);
      showToast('Could not change status', { kind: 'error' });
      if (agent) setAgentStatusControl(agent.status); // revert
    }
  });

  // Egress control. Locking down is the direction that can silently break an
  // agent — and it breaks at NEXT SPAWN, so it surfaces as a broken agent rather
  // than as a setting someone changed. So that direction confirms; unlocking
  // never does, because restoring reachability cannot break anything.
  $('#agent-egress-control')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.setting-option');
    if (!btn || btn.disabled || !selectedAgentId.value) return;
    const egress = btn.dataset.egress;
    const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
    const current = (agent && agent.egress) || 'open';
    if (current === egress) return;

    if (egress === 'host-only') {
      const ok = await showConfirmModal({
        title: 'Lock down this agent?',
        body:
          'It will only reach the network through the credential gateway. Anything ' +
          'it does over HTTPS keeps working. Direct connections stop — SSH and rsync, ' +
          'services on your LAN, and a model server running on this host. ' +
          'Applies the next time the agent starts.',
        confirmLabel: 'Lock down',
        destructive: true,
      });
      if (!ok) return;
    }

    setAgentEgressControl(egress); // optimistic
    try {
      const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/egress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify({ egress }),
      });
      if (!res.ok) throw new Error('status ' + res.status);
      if (agent) agent.egress = egress;
      showToast(egress === 'host-only' ? 'Locked down — applies when the agent restarts' : 'Open network');
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
  $<HTMLButtonElement>('#agent-add-room-toggle')?.addEventListener('click', async () => {
    const agentId = selectedAgentId.value;
    if (!agentId) return;
    let allRooms: any[] = [];
    try {
      const res = await authFetch('/api/rooms');
      allRooms = res.ok ? await res.json() : [];
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
        const res = add
          ? await authFetch(`/api/rooms/${encodeURIComponent(r.id)}/agents`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'existing', id: agentId }),
            })
          : await authFetch(`/api/rooms/${encodeURIComponent(r.id)}/agents/${encodeURIComponent(agentId)}`, {
              method: 'DELETE',
            });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        showToast(add ? `Wired to ${r.name || r.id}` : `Unwired from ${r.name || r.id}`, { kind: 'success' });
        await loadAgentRooms(agentId);
      },
    });
  });

  // ── Per-agent MCP servers (attach/detach over the registry) ─────────────────
  // Servers are DEFINED in the MCP tab (the registry); the agent panel only
  // attaches/detaches them — a compact list + checklist picker mirroring the
  // Rooms wiring block. GET/PUT /api/agents/:id/mcp-servers (admin-gated; the
  // server never returns env/headers).

}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Remaining agent-detail wiring: the secrets, env and deploy-key controls.
//
// One function per GROUP of blocks, each called from the line its group
// started on. Blocks with an executing statement between them cannot share a
// function: a single call at the first block moves the later ones ahead of
// whatever ran in between, which the boot-order trace catches.

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
        body: JSON.stringify({ content: ($<HTMLTextAreaElement>('#agent-instructions')?.value ?? '') }),
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
      // Pinned Anthropic model (container_configs.model). Unlike the fields above
      // this one restarts the agent, so only send it when it actually changed.
      // A rejection here must be surfaced, not swallowed: silently keeping the old
      // model is exactly the failure this field exists to fix.
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
      // Don't re-openAgentDetail — that re-fetches instructions and resets the
      // user's cursor position. The form values already reflect what they typed,
      // and the agent list re-render is what we actually need for the rename
      // to be visible.
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
// Agent detail controls whose elements no module referenced yet: delete, MCP attach, secrets and env.
//
// These blocks were invisible to the ownership census: no module referenced
// their element ids, because the wiring that would have referenced them was
// still here in legacy.js. Attributed by the subject element's NAME instead.

export function wireAgentControls1(): void {
  $<HTMLButtonElement>('#agent-export-btn')?.addEventListener('click', async () => {
    if (!selectedAgentId.value) return;
    const { ok, checked } = await confirmWithToggle({
      title: 'Export this agent?',
      toggleLabel: 'Include conversations (larger; briefly stops this agent)',
      note: 'Credentials never export — the bundle lists what to reconnect on import.',
      confirmLabel: 'Export',
    });
    if (!ok) return;
    const a = document.createElement('a');
    a.href = `/api/agents/${encodeURIComponent(selectedAgentId.value)}/export${checked ? '?conversations=1' : ''}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Export started — check your downloads', { kind: 'success' });
  });
}

export function wireAgentControls2(): void {
  $<HTMLButtonElement>('#import-agent-btn')?.addEventListener('click', () => $<HTMLInputElement>('#import-agent-file')?.click());
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
        setAgentMcp(agentId, add ? { add: [s.id] } : { remove: [s.id] }, add ? `Attached ${s.name}` : `Detached ${s.name}`),
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
      const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`Failed to delete agent: ${err.error || res.statusText}`, { kind: 'error' });
        return;
      }
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
      document.querySelectorAll<HTMLElement>('.room-agent-picker-tab').forEach((t: any) => t.classList.remove('active'));
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
// Blocks the census read as multi-owner: the union of every id they touch spans
// several modules, but the element each one WIRES belongs here.

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
      if (_el10) _el10.value = 'sse';
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

/**
 * Reveal the header/template fields only when the operator opts into stating
 * them. Wired once per form; the rows stay in the DOM so values survive a
 * toggle away and back, and are cleared on a successful save with the rest.
 */
export function wireCustomScheme(p: any) {
  const box = $(`${p}-custom`);
  if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';
  const sync = () => {
    $(`${p}-custom-header-row`)!.hidden = !(box as HTMLInputElement).checked;
    $(`${p}-custom-format-row`)!.hidden = !(box as HTMLInputElement).checked;
  };
  box.addEventListener('change', sync);
  sync();
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
// The thinking bubble is tied to the actual turn lifecycle (start → done/
// stalled), NOT the heartbeat-driven typing signal — so it stays up through
// long quiet operations and only clears on a real terminal signal. While a
// turn is active an elapsed counter ticks so liveness is always explicit.
// Per-agent turn state lives in thinkingTurns ({startedAt,
// lastActivityAt, reasoningLog}), keyed by agent name (data-agent). A
// multi-agent room shows one bubble per agent instead of interleaving everyone's
// activity into one; a single-agent room is unchanged. One shared ticker updates
// every live bubble's elapsed counter.
const TURN_QUIET_MS = 5000;

export function markTurnActivity(name: string) {
  const turn = turnFor(name);
  if (turn) turn.lastActivityAt = Date.now();
}

// Ticked on an interval: writes each turn's elapsed label into state instead of
// into a .thinking-elapsed span, which the bubble component now renders.
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

// Selector-safe lookup of a specific agent's bubble.
export function ensureElapsedTimer() {
  if (!turnElapsedTimer.value) turnElapsedTimer.value = setInterval(updateTurnElapsed, 1000);
}

// Per-agent API credentials (PATs, tokens) held in the OneCLI vault and injected
// by the gateway. The point of this panel is that a token never has to be typed
// into a room, where it would persist in the message DB and every archived
// transcript. Write-only: the server returns metadata only, so there is nothing
// here that can display a stored value.

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
    wireCustomScheme('#secret');
  }
  await loadToolSecretList();
}


let toolSecretsApp: any = null;
/** The scope the mounted list belongs to — the remove callback reads it. */
let toolSecretsScope: any = null;

function mountToolSecrets() {
  if (toolSecretsApp) return;
  const host = $('#secrets-list');
  if (!host) return;
  toolSecretsApp = createApp(ToolSecretList, {
    onRemove: (secret: any) => void removeToolSecret(toolSecretsScope, secret, '#secrets-list'),
  });
  toolSecretsApp.mount(host);
}

export async function loadToolSecretList(scope: any = null, listSel: string | null = '#secrets-list') {
  // listSel is kept for the signature, but '#secrets-list' is the only selector
  // that reaches here: removeToolSecret routes an agent-scoped delete to
  // renderAgentSecrets, which repaints the OTHER island.
  if (listSel !== '#secrets-list' || !$('#secrets-list')) return;
  toolSecretsScope = scope;
  let secrets = [];
  try {
    const r = await authFetch(toolSecretUrl(scope));
    if (r.ok) secrets = (await r.json()).secrets || [];
  } catch {
    secrets = [];
  }
  toolSecretRows.value = secrets;
  mountToolSecrets();
}


export async function saveToolSecret(scope: any = null, p = '#secret') {
  const hostPattern = $<HTMLInputElement>(`${p}-host`)!.value.trim();
  const value = $<HTMLInputElement>(`${p}-value`)!.value;
  if (!hostPattern || !value) {
    showToast('Host and value are required', { kind: 'error' });
    return;
  }
  // The auth scheme (and any encoding, e.g. Azure DevOps' base64 Basic) is
  // inferred from the host on the server — one place, not a dropdown. The
  // Service select is the escape hatch for a self-hosted API on a LAN IP, where
  // the host cannot say which service answers. Empty = infer, as before. It
  // names a service, never a raw header, so the scheme table stays server-side.
  // Unchecked = infer the auth header from the host, which is right for a
  // public API. Checked = the operator states it, for a host that cannot say
  // which service answers there. The server validates the pair; the client
  // never decides what is a safe header.
  let scheme: any;
  if ($<HTMLInputElement>(`${p}-custom`)?.checked) {
    const headerName = $<HTMLInputElement>(`${p}-custom-header`)?.value.trim() || '';
    const valueFormat = $<HTMLInputElement>(`${p}-custom-format`)?.value.trim() || '';
    if (!headerName || !valueFormat) {
      showToast('A custom header needs both a name and a value template', { kind: 'error' });
      return;
    }
    scheme = { headerName, valueFormat };
  }

  const btn = $<HTMLButtonElement>(`${p}-save`);
  btn!.disabled = true;
  try {
    const r = await authFetch(toolSecretUrl(scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify(scheme ? { value, hostPattern, scheme } : { value, hostPattern }),
    });
    if (!r.ok) {
      showToast((await r.json().catch(() => ({}))).error || 'Could not add secret', { kind: 'error' });
      return;
    }
    // Clear the value field first and always — it is the sensitive one and must
    // not linger in the DOM after a successful write.
    $<HTMLInputElement>(`${p}-value`)!.value = '';
    $<HTMLInputElement>(`${p}-host`)!.value = '';
    if ($(`${p}-custom-header`)) $<HTMLInputElement>(`${p}-custom-header`)!.value = '';
    if ($(`${p}-custom-format`)) $<HTMLInputElement>(`${p}-custom-format`)!.value = '';
    showToast(`Added ${hostPattern}`);
    if (scope) await renderAgentSecrets(typeof scope === 'object' ? scope.agentGroupId : scope);
    else await loadToolSecretList(null, '#secrets-list');
  } catch {
    showToast('Could not add secret', { kind: 'error' });
  } finally {
    btn!.disabled = false;
  }
}

export async function removeToolSecret(scope: any, secret: any, listSel: string | null = '#secrets-list', agentGroupId = null) {
  const ok = await showConfirmModal({
    title: 'Remove secret',
    body: `Delete the credential for ${secret.hostPattern}? Requests that rely on it will start failing.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!ok) return;
  try {
    const r = await authFetch(toolSecretUrl(scope, `&id=${encodeURIComponent(secret.id)}`), {
      method: 'DELETE',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!r.ok) {
      showToast('Could not remove secret', { kind: 'error' });
      return;
    }
    showToast(`Removed ${secret.label}`);
    if (agentGroupId) await renderAgentSecrets(agentGroupId);
    else if (listSel) await loadToolSecretList(scope, listSel);
    // listSel === null: the caller owns its own re-render (My credentials).
  } catch {
    showToast('Could not remove secret', { kind: 'error' });
  }
}
