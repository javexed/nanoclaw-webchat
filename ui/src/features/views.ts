// ── Full views ───────────────────────────────────────────────────────────────
// The full-screen surfaces and the stack that manages them: Manage, Dashboard,
// Topology, Journey and the wiring Matrix, plus openView/closeView and the
// hide-the-others plumbing every panel calls when it takes over the screen.
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { closeRouteDetail } from './routing.js';
import { renderRoutingSetup } from './settings.js';
import { adminActive, helpActive, manageActive, manageTab, matrixWired, topoData, viewStack } from './views-state.js';
import { allModels, modelSortAz } from './model-list-state.js';
import { routingAvailable } from './routing-state.js';
import { agentFilter, agentSortAz } from './agent-list-state.js';
import { permsActive } from './perms-list-state.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { closeAgentDetail, fetchAgents, openAgentDetail, renderAgents, showAgentsDetail, showDetail } from './agents.js';
import { closeMcpDetail, fetchMcpServers, openMcpDetail, renderMcpSources } from './mcp.js';
import { showConfirmModal } from './modals.js';
import { closeModelDetail, fetchModels, openModelDetail, renderModels } from './models.js';
import { closeRoomDetail, openRoomDetail, roomColor } from './rooms.js';
import { openScopedSkillEditor, renderSkillSources, renderSkillsRegistry } from './skills.js';
import { createApp } from 'vue';
import UsageTable from './UsageTable.vue';
import UsageSpark from './UsageSpark.vue';
import UsageModels from './UsageModels.vue';
import { usageBars, usageModels, usageRows } from './usage-state.js';
import WiringMatrix from './WiringMatrix.vue';
import { matrixAgents, matrixEdges, matrixRooms } from './matrix-state.js';
import JourneyList from './JourneyList.vue';
import { journeyEvents, journeyFilter, journeyPhase } from './journey-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideViewsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface ViewsDeps {
  /** Still in legacy: walks the topology graph from a focus node. */
  closeAllDetailDrawers: () => any;
  getAfterDetailClose: () => any;
  getDetailRouterOpen: () => any;
  loadRoutingTab: () => any;
  probeRoutingAvailability: () => any;
  refreshRouterMetrics: () => any;
  setAfterDetailClose: (v: any) => void;
}

const deps = {} as ViewsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideViewsDeps(provided: Partial<ViewsDeps>): void {
  Object.assign(deps, provided);
}

export function openView(name?: any, teardown?: any) {
  viewStack.push({ name, teardown });
  history.pushState({ viewDepth: viewStack.length }, '');
}

export function closeView(name?: any) {
  const idx = viewStack.map((v: any) => v.name).lastIndexOf(name);
  if (idx === -1) return;
  history.go(-(viewStack.length - idx)); // drives popstate, which runs teardown
}

export function openFullView(fn?: any) {
  if (deps.getDetailRouterOpen()) {
    deps.setAfterDetailClose(fn);
    deps.closeAllDetailDrawers();
    return;
  }
  fn();
}

export function openManage(tab = 'agents') {
  // openFullView closes any open detail drawer first, then runs this (see there
  // for why the deferral matters). Close any other full view too; manage overlays
  // the chat pane, so restore chat as its backdrop (a prior full view had hidden
  // it + set in-dashboard).
  openFullView(() => {
    hideOtherFullViews('manage');
    $('#chat')!.hidden = false;
    $('#app')!.classList.remove('in-dashboard');
    manageActive.value = true;
    $('#manage')!.hidden = false;
    $('#overflow-btn')?.classList.add('active');
    switchManageTab(tab);
    if (!viewStack.some((v: any) => v.name === 'manage')) openView('manage', teardownManage);
    deps.probeRoutingAvailability();
  });
}

function teardownManage() {
  manageActive.value = false;
  $('#manage')!.hidden = true;
  $('#overflow-btn')?.classList.remove('active');
}

export function switchManageTab(tab?: any) {
  manageTab.value = tab;
  document.querySelectorAll('.manage-tab').forEach((t: any) => {
    const on = (t as HTMLElement).dataset.mtab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#mtab-agents')!.hidden = tab !== 'agents';
  $('#mtab-models')!.hidden = tab !== 'models';
  $('#mtab-mcp')!.hidden = tab !== 'mcp';
  $('#mtab-skills')!.hidden = tab !== 'skills';
  $('#mtab-routing')!.hidden = tab !== 'routing';
  if (typeof syncManageSortIcon === 'function') syncManageSortIcon(); // reflect the active tab's sort
  // The Manage toolbar is shared across tabs, so the agent filter has to follow
  // its own tab. Leaving it visible on Models/MCP/Skills would be a control that
  // silently filters something you are not looking at.
  const agentFilterEl = $<HTMLInputElement>('#agent-filter');
  if (agentFilterEl) {
    agentFilterEl.hidden = tab !== 'agents';
    if (tab !== 'agents' && agentFilter.value) {
      // Leaving a stale query behind means returning to Agents later and seeing
      // a truncated list with no visible cause.
      agentFilterEl.value = '';
      agentFilter.value = '';
    }
  }
  if (tab === 'agents') fetchAgents();
  else if (tab === 'models') fetchModels();
  else if (tab === 'mcp') {
    fetchMcpServers();
    // The catalog's registry source, global-admin only — self-hiding on 403.
    void renderMcpSources();
  } else if (tab === 'skills') {
    renderSkillsRegistry();
    // The catalog's sources, owner-only — self-hiding for everyone else.
    void renderSkillSources();
  }
  else if (tab === 'routing') {
    if (!routingAvailable.value && !state.isOwnerView) return switchManageTab('agents');
    // Setup first (Install button ↔ badge), then the live panel when installed.
    void renderRoutingSetup();
    if (routingAvailable.value) deps.loadRoutingTab();
  }
}

let dashboardActive = false;

export function hideOtherFullViews(keep?: any) {
  // `manage` (the Agents/Models pane) is a full surface like the rest — it must
  // close when another view opens, or it lingers on top with the new view
  // underneath. (Pass no `keep` to close them all, e.g. when opening a room.)
  if (keep !== 'manage' && manageActive.value) {
    manageActive.value = false;
    $('#manage')!.hidden = true;
    $('#overflow-btn')?.classList.remove('active');
  }
  if (keep !== 'dashboard' && dashboardActive) {
    dashboardActive = false;
    $('#dashboard')!.hidden = true;
    $('#dash-btn')?.classList.remove('active');
  }
  if (keep !== 'admin' && adminActive.value) {
    adminActive.value = false;
    $('#admin')!.hidden = true;
    $('#overflow-btn')?.classList.remove('active');
  }
  if (keep !== 'permissions' && permsActive.value) {
    permsActive.value = false;
    $('#permissions')!.hidden = true;
  }
  if (keep !== 'topology' && topologyActive) {
    topologyActive = false;
    $('#topology')!.hidden = true;
  }
  if (keep !== 'journey' && journeyActive) {
    journeyActive = false;
    $('#journey')!.hidden = true;
  }
  if (keep !== 'matrix' && matrixActive) {
    matrixActive = false;
    $('#matrix')!.hidden = true;
  }
  if (keep !== 'help' && helpActive.value) {
    helpActive.value = false;
    $('#help')!.hidden = true;
  }
}

function openDashboard() {
  openFullView(() => {
    hideOtherFullViews('dashboard');
    dashboardActive = true;
    $('#chat')!.hidden = true;
    $('#dashboard')!.hidden = false;
    $('#dash-btn')?.classList.add('active');
    $('#app')!.classList.add('in-dashboard');
    $('#app')!.classList.remove('in-room');
    refreshDashboard();
    openView('dashboard', teardownDashboard);
  });
}

function teardownDashboard() {
  dashboardActive = false;
  $('#chat')!.hidden = false;
  $('#dashboard')!.hidden = true;
  $('#dash-btn')?.classList.remove('active');
  $('#app')!.classList.remove('in-dashboard');
}

export function toggleDashboard() {
  if (dashboardActive) closeView('dashboard');
  else openDashboard();
}

let topologyActive = false;

function openTopology() {
  openFullView(() => {
    hideOtherFullViews('topology');
    topologyActive = true;
    $('#chat')!.hidden = true;
    $('#topology')!.hidden = false;
    $('#app')!.classList.add('in-dashboard'); // reuse the full-view mobile layout
    $('#app')!.classList.remove('in-room');
    refreshTopology();
    openView('topology', teardownTopology);
  });
}

function teardownTopology() {
  topologyActive = false;
  $('#chat')!.hidden = false;
  $('#topology')!.hidden = true;
  $('#app')!.classList.remove('in-dashboard');
}

export function toggleTopology() {
  if (topologyActive) closeView('topology');
  else openTopology();
}

let journeyActive = false;

const journeyAgents = new Map(); // agentGroupId → agentName, from loaded events

function setJourneyPreset(preset?: any) {
  journeyFilter.value.agent = preset?.agentGroupId || '';
  journeyFilter.value.kind = '';
  journeyFilter.value.skill = preset?.skill || '';
  if (journeyFilter.value.agent && !journeyAgents.has(journeyFilter.value.agent)) {
    const known = typeof state.allAgents !== 'undefined' && state.allAgents.find?.((a: any) => a.id === journeyFilter.value.agent);
    journeyAgents.set(journeyFilter.value.agent, preset?.agentName || (known && known.name) || journeyFilter.value.agent);
  }
  renderJourneyFilterControls();
}

export function openJourney(preset?: any) {
  if (journeyActive) {
    // Already open (e.g. History from a skill editor launched off a Journey
    // row): just retarget the filters — no second view-stack entry.
    setJourneyPreset(preset);
    applyJourneyFilters();
    return;
  }
  openFullView(() => {
    hideOtherFullViews('journey');
    journeyActive = true;
    $('#chat')!.hidden = true;
    $('#journey')!.hidden = false;
    $('#app')!.classList.add('in-dashboard'); // reuse the full-view mobile layout
    $('#app')!.classList.remove('in-room');
    journeyAgents.clear();
    setJourneyPreset(preset);
    void refreshJourney(true);
    openView('journey', teardownJourney);
  });
}

function teardownJourney() {
  journeyActive = false;
  $('#chat')!.hidden = false;
  $('#journey')!.hidden = true;
  $('#app')!.classList.remove('in-dashboard');
}

export function toggleJourney() {
  if (journeyActive) closeView('journey');
  else openJourney();
}

let journeyCursor: any = null;


export async function refreshJourney(reset?: any) {
  if (!$('#journey-list')) return;
  if (reset) {
    journeyCursor = null;
    journeyEvents.value = [];
    journeyPhase.value = 'loading';
  }
  mountJourney();
  const more = $('#journey-more');
  try {
    const q = !reset && journeyCursor ? `&before=${journeyCursor}` : '';
    const data = await apiJson(`/api/learning/timeline?limit=100${q}`);
    const events = data.events || [];
    noteJourneyAgents(events);
    // Append, never replace: 'Load more' pages in older events, and the day
    // headers are derived from the accumulated list rather than remembered
    // across calls the way journeyLastDay had to be.
    journeyEvents.value = reset ? events : [...journeyEvents.value, ...events];
    journeyCursor = data.nextBefore || null;
    if (more) more.hidden = !journeyCursor;
    journeyPhase.value = journeyEvents.value.length ? 'ready' : 'empty';
    renderJourneyFilterControls(); // newly loaded events may add agents
    applyJourneyFilters(); // 'Load more' rows obey the active filters too
  } catch (err) {
    if (reset) journeyPhase.value = 'error';
    else toastError(err, 'Could not load more');
  }
}

const JOURNEY_VERBS = {
  proposed: 'Proposed',
  kept: 'Kept',
  discarded: 'Discarded',
  revised: 'Revised',
  archived: 'Archived',
} as Record<string, string>;

function journeyMeta(ev?: any) {
  const bits = [];
  if (ev.kind === 'kept' && ev.by === 'auto-keep') bits.push('kept automatically');
  else if (ev.kind === 'discarded' && ev.by === 'expired') bits.push('expired unreviewed');
  else if (ev.kind === 'discarded' && ev.by === 'superseded') bits.push('replaced by a newer draft');
  else if (ev.kind === 'archived') bits.push('unused, moved to the archive');
  if (ev.roomName) bits.push(ev.roomName);
  return bits.join(' · ');
}

let journeyApp: ReturnType<typeof createApp> | null = null;

function mountJourney(): void {
  if (journeyApp) return;
  const host = $('#journey-list');
  if (!host) return;
  journeyApp = createApp(JourneyList, {
    verbs: JOURNEY_VERBS,
    meta: journeyMeta,
    onOpen: (ev: any) => openScopedSkillEditor(ev.agentGroupId, ev.skillName),
    onRevert: async (ev: any) => {
      const ok = await showConfirmModal({
        title: `Revert ${ev.skillName}?`,
        body: 'Restores the previous version. The current version is kept in history.',
        confirmLabel: 'Revert',
        destructive: true,
      });
      if (!ok) return;
      try {
        await apiJson(
          `/api/agents/${encodeURIComponent(ev.agentGroupId)}/skills/scoped/${encodeURIComponent(ev.skillName)}/revert`,
          { method: 'POST' },
        );
        showToast(`Reverted ${ev.skillName}`, { kind: 'success' });
        void refreshJourney(true);
      } catch (err) {
        toastError(err, 'Revert failed');
      }
    },
  });
  journeyApp.mount(host);
}

/** Record the agents seen in a page, for the filter dropdown. */
function noteJourneyAgents(events: any[]) {
  for (const ev of events) {
    if (ev.agentGroupId && !journeyAgents.has(ev.agentGroupId)) {
      journeyAgents.set(ev.agentGroupId, ev.agentName || ev.agentGroupId);
    }
  }
}

export function renderJourneyFilterControls() {
  const sel = ($('#journey-agent-filter')) as HTMLInputElement;
  if (sel) {
    sel.innerHTML = '';
    sel.appendChild(new Option('All agents', ''));
    for (const [id, name] of [...journeyAgents].sort((a: any, b: any) => a[1].localeCompare(b[1]))) {
      sel.appendChild(new Option(name, id));
    }
    (sel as HTMLInputElement).value = journeyFilter.value.agent;
    if (sel.value !== journeyFilter.value.agent) journeyFilter.value.agent = ''; // option vanished
  }
  for (const b of document.querySelectorAll('#journey-kind-filter .setting-option')) {
    const active = ((b as HTMLElement).dataset.kind || '') === journeyFilter.value.kind;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  const chip = $('#journey-skill-chip');
  if (chip) {
    chip.hidden = !journeyFilter.value.skill;
    if (journeyFilter.value.skill) chip.textContent = `skill: ${journeyFilter.value.skill} ✕`;
  }
}

export function applyJourneyFilters() {
  const f = journeyFilter.value;
  // A NEW object, not the same one: legacy mutates its filter in place, and Vue
  // tracks the ref assignment rather than a mutation behind it.
  journeyFilter.value = { agent: f.agent || '', kind: f.kind || '', skill: f.skill || '' };
  // #journey-no-match sits outside the mount point, so the counts are derived
  // here rather than read back off the rendered rows.
  const total = journeyEvents.value.length;
  const shown = journeyEvents.value.filter(
    (ev: any) =>
      (!f.agent || (ev.agentGroupId || '') === f.agent) &&
      (!f.kind || ev.kind === f.kind) &&
      (!f.skill || (ev.skillName || '') === f.skill),
  ).length;
  const none = $('#journey-no-match');
  if (none) none.hidden = !(total > 0 && shown === 0);
}

export async function refreshTopology() {
  const canvas = $('#topology-canvas');
  if (!canvas) return;
  canvas.textContent = 'Loading…';
  try {
    const r = await authFetch('/api/topology');
    if (!r.ok) {
      canvas.textContent = 'Could not load topology.';
      return;
    }
    renderTopology(await r.json());
  } catch {
    canvas.textContent = 'Could not load topology.';
  }
}

function renderTopology(data?: any) {
  const canvas = $('#topology-canvas');
  if (!canvas) return;
  topoData.value = data;
  setTopoFocus(null); // every (re)render starts on the full graph
  updateTopoFocusPill();
  canvas.textContent = '';
  const rooms = data.rooms || [];
  const agents = data.agents || [];
  const models = data.models || [];
  const edges = data.edges || [];
  // MCP servers are the agent's reach OUTWARD — worth seeing on the same canvas as
  // the rooms feeding it, not buried in a settings drawer.
  const mcpServers = data.mcpServers || [];
  const mcpEdges = data.mcpEdges || [];
  // SCOPED skills only — a skill wired to one agent. The shared pool is on nearly
  // every agent, so its edges would be a uniform wall that hides the few that
  // actually distinguish an agent (including anything the learning loop produced).
  const skills = data.skills || [];
  const skillEdges = data.skillEdges || [];
  if (rooms.length === 0) {
    canvas.textContent = 'No rooms yet.';
    return;
  }

  // Adjacency.
  const push = (m?: any, k?: any, v?: any) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  const agentRooms = new Map();
  const roomAgents = new Map();
  const modelAgents = new Map();
  for (const e of edges) {
    push(agentRooms, e.agent, e.room);
    push(roomAgents, e.room, e.agent);
  }
  for (const a of agents) if (a.modelId) push(modelAgents, a.modelId, a.id);
  const mcpAgents = new Map();
  const agentMcps = new Map();
  for (const e of mcpEdges) {
    push(mcpAgents, e.mcp, e.agent);
    push(agentMcps, e.agent, e.mcp);
  }
  const skillAgents = new Map();
  for (const e of skillEdges) push(skillAgents, e.skill, e.agent);

  // Barycenter ordering: average a node's y over its neighbors. Orphans (no
  // neighbors) sink to the bottom. Forward (agents←rooms, models←agents), one
  // reverse (rooms←agents), then re-settle — two-ish passes cut most crossings.
  const indexMap = (arr?: any) => new Map(arr.map((x: any, i: any) => [x.id, i]));
  const bary = (neighbors?: any, posMap?: any) =>
    !neighbors || neighbors.length === 0
      ? Number.POSITIVE_INFINITY
      : neighbors.reduce((s: any, n: any) => s + (posMap.get(n) ?? 0), 0) / neighbors.length;
  const reorder = (items?: any, neighborsOf?: any, posMap?: any) => {
    const ranked = items.map((it: any, i: number) => ({ id: it.id, b: bary(neighborsOf(it.id), posMap), i }));
    ranked.sort((x: any, y: any) => x.b - y.b || x.i - y.i); // stable on ties
    return new Map(ranked.map((r: any, i: any) => [r.id, i]));
  };
  let roomY = indexMap(rooms);
  let agentY = reorder(agents, (id: any) => agentRooms.get(id), roomY);
  let modelY = reorder(models, (id: any) => modelAgents.get(id), agentY);
  roomY = reorder(rooms, (id: any) => roomAgents.get(id), agentY);
  agentY = reorder(agents, (id: any) => agentRooms.get(id), roomY);
  modelY = reorder(models, (id: any) => modelAgents.get(id), agentY);
  const mcpY = reorder(mcpServers, (id: any) => mcpAgents.get(id), agentY);
  const skillY = reorder(skills, (id: any) => skillAgents.get(id), agentY);

  // Pixel layout.
  const ROW = 46;
  const PAD = 28;
  const COLW = 240;
  const cols = {
    room: PAD,
    agent: PAD + COLW,
    model: PAD + COLW * 2,
    mcp: PAD + COLW * 3,
    skill: PAD + COLW * 4,
  };
  const rowsCount = Math.max(rooms.length, agents.length, models.length, mcpServers.length, skills.length, 1);
  // Only widen the canvas for columns that actually have something in them.
  const lastCol = skills.length ? cols.skill : mcpServers.length ? cols.mcp : cols.model;
  const W = lastCol + COLW;
  const H = PAD * 2 + 20 + rowsCount * ROW;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'topology-svg', preserveAspectRatio: 'xMidYMin meet' });
  const NODE_X = 6; // circle radius; line attaches just past the label gap
  const LABEL_W = 84; // px reserved before an edge leaves a node's right side
  const yPx = (yMap?: any, id?: any) => PAD + 20 + (yMap.get(id) ?? 0) * ROW + ROW / 2;

  // Column headers.
  const heads: Array<[string, number]> = [
    ['Rooms', cols.room],
    ['Agents', cols.agent],
    ['Models', cols.model],
    ...(mcpServers.length ? ([['MCP servers', cols.mcp]] as Array<[string, number]>) : []),
    ...(skills.length ? ([['Skills', cols.skill]] as Array<[string, number]>) : []),
  ];
  for (const [label, x] of heads) {
    const h = svgEl('text', { x: String(x), y: String(PAD), class: 'topo-col-head' });
    h.textContent = label;
    svg.appendChild(h);
  }

  // Edges (under nodes). Room→agent edges are tinted with the room's own color
  // (the same palette as the sidebar dots) so you can trace each room's fan-out
  // at a glance. Inline style beats the `.topo-edge` CSS stroke. Agent→model
  // edges stay neutral — an agent can belong to several rooms, so there's no one
  // room color to give them.
  const edgeLine = (x1?: any, y1?: any, x2?: any, y2?: any, stroke?: any) => {
    const ln = svgEl('line', { x1, y1, x2, y2, class: 'topo-edge' });
    if (stroke) ln.style.stroke = stroke;
    return svg.appendChild(ln);
  };
  for (const e of edges) {
    const ln = edgeLine(cols.room + LABEL_W, yPx(roomY, e.room), cols.agent - NODE_X, yPx(agentY, e.agent), roomColor(e.room));
    ln.setAttribute('data-room', e.room);
    ln.setAttribute('data-agent', e.agent);
  }
  for (const a of agents)
    if (a.modelId) {
      const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, a.id), cols.model - NODE_X, yPx(modelY, a.modelId));
      ln.setAttribute('data-agent', a.id);
      ln.setAttribute('data-model', a.modelId);
    }

  // Agent→MCP edges. Both the model and the MCP servers hang off the AGENT, so this
  // starts at the agent and spans the models column (edges draw under nodes, so it
  // passes behind them). Dashed, so a line crossing that column reads as a different
  // relation rather than as model→server.
  for (const e of mcpEdges) {
    const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, e.agent), cols.mcp - NODE_X, yPx(mcpY, e.mcp));
    ln.classList.add('topo-edge-mcp');
    ln.setAttribute('data-agent', e.agent);
    ln.setAttribute('data-mcp', e.mcp);
  }

  // Agent→skill edges. Like MCP, these hang off the agent and span the columns
  // between, so they pass behind those nodes. DOTTED rather than dashed, so a
  // skill edge and a tool-server edge stay tellable apart when they cross.
  for (const e of skillEdges) {
    const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, e.agent), cols.skill - NODE_X, yPx(skillY, e.skill));
    ln.classList.add('topo-edge-skill');
    ln.setAttribute('data-agent', e.agent);
    ln.setAttribute('data-skill', e.skill);
  }

  // Nodes.
  const drawNode = (x?: any, yMap?: any, item?: any, kind?: any, degree?: any, stroke?: any) => {
    const y = yPx(yMap, item.id);
    const g = svgEl('g', { class: `topo-node topo-${kind}${degree === 0 ? ' topo-orphan' : ''}` });
    // Click a node to open that item's settings drawer (overlays the graph;
    // closing it returns here). Keyboard-accessible too.
    g.style.cursor = 'pointer';
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-label', `Open ${kind} settings: ${item.name}`);
    g.setAttribute('data-kind', kind);
    g.setAttribute('data-node-id', item.id);
    // Clicking a node focuses the graph on its connections (dims the rest) AND
    // opens its settings drawer — the drawer is a right-side panel on desktop,
    // so the dimmed graph stays visible beside it.
    const activate = () => {
      setTopoFocus(kind, item.id, item.name);
      openTopologyItem(kind, item.id);
    };
    g.addEventListener('click', activate);
    g.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    const c = svgEl('circle', { cx: x, cy: y, r: NODE_X });
    // Match the room node to its edge color (skip orphans — they keep the
    // red-dashed "unused" treatment).
    if (stroke && degree > 0) c.style.stroke = stroke;
    g.appendChild(c);
    const t = svgEl('text', { x: x + 11, y: y + 4, class: 'topo-label' });
    t.textContent = degree > 0 ? `${item.name} · ${degree}` : item.name;
    g.appendChild(t);
    svg.appendChild(g);
  };
  for (const r of rooms) drawNode(cols.room, roomY, r, 'room', (roomAgents.get(r.id) || []).length, roomColor(r.id));
  for (const a of agents) drawNode(cols.agent, agentY, a, 'agent', (agentRooms.get(a.id) || []).length);
  for (const m of models) drawNode(cols.model, modelY, m, 'model', (modelAgents.get(m.id) || []).length);
  for (const srv of mcpServers) drawNode(cols.mcp, mcpY, srv, 'mcp', (mcpAgents.get(srv.id) || []).length);
  for (const sk of skills) drawNode(cols.skill, skillY, sk, 'skill', (skillAgents.get(sk.id) || []).length);

  // Click empty canvas to clear a focus (nodes handle their own clicks).
  svg.addEventListener('click', (ev: any) => {
    if (ev.target === svg) clearTopoFocus();
  });
  canvas.appendChild(svg);
}

async function openTopologyItem(kind?: any, id?: any) {
  try {
    if (kind === 'room') {
      await openRoomDetail(id);
    } else if (kind === 'agent') {
      if (!state.allAgents.length) await fetchAgents();
      await openAgentDetail(id);
    } else if (kind === 'model') {
      if (!allModels.value.length) await fetchModels();
      await openModelDetail(id);
    } else if (kind === 'mcp') {
      // Same affordance as every other node: click it, get its settings.
      await openMcpDetail(id);
    }
    // A skill has no per-item drawer, and opening the Skills view would REPLACE
    // the graph — throwing away the focus the click just set. Every other node
    // opens an overlay and leaves the graph visible, so a skill click focuses
    // only: who carries it, and where it therefore acts. Manage from ⋯ → Skills.
  } catch (err) {
    showToast('Couldn’t open settings: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

let matrixActive = false;

function openMatrix() {
  openFullView(() => {
    hideOtherFullViews('matrix');
    matrixActive = true;
    $('#chat')!.hidden = true;
    $('#matrix')!.hidden = false;
    $('#app')!.classList.add('in-dashboard');
    $('#app')!.classList.remove('in-room');
    refreshMatrix();
    openView('matrix', teardownMatrix);
  });
}

function teardownMatrix() {
  matrixActive = false;
  // Unmount on the way out, so reopening rebuilds rather than showing a
  // placeholder over a corpse.
  unmountMatrix();
  $('#chat')!.hidden = false;
  $('#matrix')!.hidden = true;
  $('#app')!.classList.remove('in-dashboard');
}

export function toggleMatrix() {
  if (matrixActive) closeView('matrix');
  else openMatrix();
}

export async function refreshMatrix() {
  const canvas = $('#matrix-canvas');
  if (!canvas) return;
  // `#matrix-canvas` is BOTH the placeholder target and the island's mount
  // host, so writing textContent into it destroys the mounted app's DOM — and
  // mountMatrix() refuses to rebuild while matrixApp is set. Painting the
  // placeholder unconditionally therefore left "Loading…" on screen forever
  // from the second render on (reopen the view, or press Refresh). Only paint
  // it when nothing is mounted; tear the island down first on the paths that
  // must replace it with text.
  if (!matrixApp) canvas.textContent = 'Loading…';
  const fail = () => {
    unmountMatrix();
    canvas.textContent = 'Could not load wiring.';
  };
  try {
    const r = await authFetch('/api/topology');
    if (!r.ok) return fail();
    renderMatrix(await r.json());
  } catch {
    fail();
  }
}

let matrixApp: ReturnType<typeof createApp> | null = null;

function mountMatrix(): void {
  if (matrixApp) return;
  const host = $('#matrix-canvas');
  if (!host) return;
  matrixApp = createApp(WiringMatrix);
  matrixApp.mount(host);
}

/**
 * Drop the island so the next open mounts a fresh one.
 *
 * Load-bearing: without it, `matrixApp` stayed set for the life of the page
 * while the host's DOM got wiped by the placeholder, and the mount guard then
 * refused to rebuild — the view never recovered short of a reload.
 */
function unmountMatrix(): void {
  if (!matrixApp) return;
  matrixApp.unmount();
  matrixApp = null;
}

function renderMatrix(data?: any) {
  if (!$('#matrix-canvas')) return;
  const rooms = data.rooms || [];
  const agents = data.agents || [];
  matrixWired.value = new Set((data.edges || []).map((e: any) => `${e.room}|${e.agent}`));
  matrixRooms.value = rooms;
  matrixAgents.value = agents;
  // A COPY, not the same Set: legacy mutates matrixWired.value in place when a cell
  // toggles, and a shared reference would leave the island unaware — Vue tracks
  // the ref assignment, not a mutation behind it. refreshMatrixCells() below
  // re-syncs after every toggle.
  matrixEdges.value = new Set(matrixWired.value);
  mountMatrix();
}

/** Re-read the edge set after legacy toggles a cell. */
export function refreshMatrixCells(): void {
  matrixEdges.value = new Set(matrixWired.value);
}

let usageRangeDays = 7;

let usageWired = false;

let usageApps: Array<ReturnType<typeof createApp>> = [];

function mountUsage(): void {
  if (usageApps.length) return;
  const mounts: Array<[string, any]> = [
    ['#usage-tbody', UsageTable],
    ['#usage-spark', UsageSpark],
    ['#usage-models', UsageModels],
  ];
  for (const [sel, comp] of mounts) {
    const host = $(sel);
    if (!host) continue;
    const app = createApp(comp);
    app.mount(host);
    usageApps.push(app);
  }
}

/**
 * Token usage — a DASHBOARD panel now, not a Settings section. Usage is a
 * thing you check, not a thing you configure; it sat in Settings because
 * that was the only owner-gated surface at the time. The endpoint stays
 * owner-only and a 403 hides the whole panel, so the move changes surface,
 * not audience.
 */
export async function renderUsagePanel() {
  const section = $('#dash-usage-section');
  if (!section) return;
  let data = null;
  try {
    const r = await authFetch('/api/webchat/usage?days=' + usageRangeDays);
    if (!r.ok) {
      section.hidden = true; // 403 for non-owners → hide the whole section
      return;
    }
    data = await r.json();
  } catch {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (!usageWired) {
    usageWired = true;
    document.querySelectorAll('#usage-range .setting-option').forEach((b) => {
      b.addEventListener('click', () => {
        usageRangeDays = Number((b as HTMLElement).dataset.days) || 7;
        document.querySelectorAll('#usage-range .setting-option').forEach((x: any) => x.classList.toggle('active', x === b));
        renderUsagePanel();
      });
    });
  }
  const fmt = (n?: any) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  $('#usage-total')!.textContent =
    '~' +
    fmt(data.totals.tokens) +
    ' tokens · ' +
    data.totals.turns +
    ' turns · ' +
    data.totals.users +
    ' user' +
    (data.totals.users === 1 ? '' : 's');

  mountUsage();

  // The table's hidden flag and #usage-empty swap the WHOLE table for a note —
  // a decision about the section, not the rows, so they stay out here.
  const table = $('#usage-table')!;
  const empty = $('#usage-empty')!;
  usageRows.value = data.perUser.map((u: any) => ({
    cells: [
      String(u.user).split(':').pop(),
      '~' + fmt(u.inputTokens),
      '~' + fmt(u.outputTokens),
      '~' + fmt(u.totalTokens),
      String(u.turns),
    ],
  }));
  table.hidden = !data.perUser.length;
  empty.hidden = !!data.perUser.length;

  // Per-day sparkline. Suppressed entirely below two days of data — a 4px floor
  // keeps a near-zero day visible when it is shown.
  const spark = $('#usage-spark')!;
  if (data.perDay.length > 1) {
    const max = Math.max.apply(null, data.perDay.map((d: any) => d.tokens).concat(1));
    usageBars.value = data.perDay.map((d: any) => ({
      height: Math.max(4, Math.round((d.tokens / max) * 36)) + 'px',
      title: d.day + ': ~' + fmt(d.tokens),
    }));
    spark.hidden = false;
  } else {
    usageBars.value = [];
    spark.hidden = true;
  }

  // Model breakdown (via each room's agent's current model).
  const models = $('#usage-models')!;
  usageModels.value = data.byModel.map((m: any) => m.model + ' · ~' + fmt(m.tokens));
  models.hidden = !data.byModel.length;
}

export async function refreshDashboard() {
  // Owner-only panel, self-hiding on 403 — fire alongside the snapshot fetch.
  void renderUsagePanel();
  let snap;
  try {
    const res = await authFetch('/api/overview');
    if (!res.ok) {
      $('#dash-graph')!.innerHTML = `<div class="dash-empty">Unable to load overview (${res.status})</div>`;
      return;
    }
    snap = await res.json();
  } catch (err) {
    $('#dash-graph')!.innerHTML = `<div class="dash-empty">Unable to load overview: ${esc((err as any)?.message)}</div>`;
    return;
  }
  renderHealthStrip(snap);
  renderMetrics(snap);
  deps.refreshRouterMetrics();
}

export function syncManageSortIcon() {
  const btn = $('#manage-sort-az');
  if (!btn) return;
  const on = manageTab.value === 'models' ? modelSortAz.value : agentSortAz.value;
  btn!.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}


// ── Panel wiring ─────────────────────────────────────────────────────────────
// The full-view stack: opening, closing and the back affordance.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireViewsPanel() at the exact line the
// first block occupied, so execution order is unchanged.

export function wireViewsPanel(): void {
  $<HTMLButtonElement>('#journey-more')?.addEventListener('click', () => void refreshJourney(false));
  $<HTMLSelectElement>('#journey-agent-filter')?.addEventListener('change', (e: any) => {
    journeyFilter.value.agent = (e.target as HTMLSelectElement).value;
    applyJourneyFilters();
  });
  $('#journey-kind-filter')?.addEventListener('click', (e: any) => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('.setting-option');
    if (!btn) return;
    journeyFilter.value.kind = btn.dataset.kind || '';
    renderJourneyFilterControls();
    applyJourneyFilters();
  });
  $<HTMLButtonElement>('#journey-skill-chip')?.addEventListener('click', () => {
    journeyFilter.value.skill = '';
    renderJourneyFilterControls();
    applyJourneyFilters();
  });


  $('#matrix-canvas')?.addEventListener('click', async (e: any) => {
    const cell = (e.target as Element | null)?.closest<HTMLElement>('.matrix-cell');
    if (!cell || cell.classList.contains('pending')) return;
    const roomId = cell.dataset.room;
    const agentId = cell.dataset.agent;
    // Both come off data-* attributes, so both are string | undefined. A cell
    // without them is not actionable — bail rather than building a URL with
    // "undefined" in the path.
    if (!roomId || !agentId) return;
    const wantWired = !cell.classList.contains('on');
    cell.classList.add('pending');
    cell.classList.toggle('on', wantWired); // optimistic
    try {
      const r = wantWired
        ? await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'existing', id: agentId }),
          })
        : await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`, {
            method: 'DELETE',
          });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      matrixWired.value[wantWired ? 'add' : 'delete'](`${roomId}|${agentId}`);
      // Make the island's copy authoritative again. The optimistic classList
      // toggle above is still what the user sees during the request — Vue only
      // patches when this ref changes, which is after the server agreed.
      refreshMatrixCells();
    } catch (err: any) {
      cell.classList.toggle('on', !wantWired); // revert
      showToast('Could not update wiring: ' + (err.message || err), { kind: 'error' });
    } finally {
      cell.classList.remove('pending');
    }
  });

  // ── Permissions section (owner-only) ──────────────────────────────────────
  // List + detail pattern (mirrors the Agents tab). Header button is hidden
  // by default and revealed by probeIsOwner() once /api/users succeeds. The
  // detail pane has two views — selected user (chips + add-role form) and
  // new-user form — plus an empty-state shown when nothing is selected.
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Remaining full-view chrome: the dashboard and topology controls.
//
// One function per GROUP of blocks, each called from the line its group
// started on. Blocks with an executing statement between them cannot share a
// function: a single call at the first block moves the later ones ahead of
// whatever ran in between, which the boot-order trace catches.

export function wireViewChrome1(): void {
  $<HTMLButtonElement>('#dash-btn')?.addEventListener('click', toggleDashboard); // ▦ quick-toggle, left of the ⋯ menu
  $<HTMLButtonElement>('#dash-back')?.addEventListener('click', toggleDashboard);
  $<HTMLButtonElement>('#dash-refresh')?.addEventListener('click', refreshDashboard);

  // ── Topology (room → agent → model explore graph) ──────────────────────────
  // Full-width SVG view (no graph library): fixed three columns, barycenter
  // ordering to minimize edge crossings. Fan-in = load; a node with no lines is
  // unused. Data: GET /api/topology (access-scoped server-side).
  $<HTMLButtonElement>('#topology-back')?.addEventListener('click', toggleTopology);
  $<HTMLButtonElement>('#topology-refresh')?.addEventListener('click', refreshTopology);

  // ── Journey (learning timeline) ─────────────────────────────────────────────
  // A day-grouped, newest-first feed of what each agent learned: proposed /
  // kept / discarded / revised / archived. Data: GET /api/learning/timeline
  // (admin-scoped server-side, cursor-paged). Kept and revised rows open the
  // existing scoped SKILL.md editor; the newest revision of a live skill offers
  // Revert through the existing revert endpoint. Everything else is a record.
  // Client-side visibility filters over the loaded events (same posture as the
  // Skills search — no refetch). Transient view state: reset on every open, not
  // persisted. `preset` (agentGroupId/agentName/skill) is the 'View history'
  // deep-link — views aren't URL-routed, so it travels as in-memory args.
}

export function wireViewChrome2(): void {
  $<HTMLInputElement>('#agent-filter')?.addEventListener('input', (e) => {
    // Local match against a list already in memory — no debounce to justify.
    agentFilter.value = (e.target as HTMLInputElement).value;
  });

  $<HTMLButtonElement>('#manage-sort-az')?.addEventListener('click', () => {
    if (manageTab.value === 'models') {
      modelSortAz.value = !modelSortAz.value;
      sessionStorage.setItem('webchat:modelSortAz', modelSortAz.value ? '1' : '0');
      renderModels();
    } else {
      agentSortAz.value = !agentSortAz.value;
      sessionStorage.setItem('webchat:agentSortAz', agentSortAz.value ? '1' : '0');
      renderAgents();
    }
    syncManageSortIcon();
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

// ── Topology focus ─────────────────────────────────────────────────────────
// Clicking a node dims everything not connected to it. For a model that's the
// model + the agents assigned to it + the rooms those agents serve; for an agent
// its rooms + model; for a room its agents + their models. A directed reach (not
// the whole component) — focusing a model doesn't fan back out to a room's other
// agents. Reversible via the "Focused: …" pill, an empty-canvas click, or refresh.
let topoFocus: any = null;

export function updateTopoFocusPill() {
  const pill = $('#topo-focus-pill');
  if (!pill) return;
  if (topoFocus) {
    pill.textContent = `Focused: ${topoFocus.name} ✕`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

export function applyTopoFocus() {
  const svg = $('#topology-canvas')?.querySelector('svg');
  if (!svg) return;
  if (!topoFocus) {
    svg.querySelectorAll('.topo-dimmed').forEach((el) => el.classList.remove('topo-dimmed'));
    return;
  }
  const hl = computeTopoFocus(topoData.value, topoFocus.kind, topoFocus.id);
  const setFor = (k: string | null) =>
    k === 'room'
      ? hl.rooms
      : k === 'agent'
        ? hl.agents
        : k === 'mcp'
          ? hl.mcps
          : k === 'skill'
            ? hl.skills
            : hl.models;
  svg.querySelectorAll('.topo-node').forEach((g: any) => {
    const on = setFor(g.getAttribute('data-kind')).has(g.getAttribute('data-node-id') ?? '');
    g.classList.toggle('topo-dimmed', !on);
  });
  svg.querySelectorAll('.topo-edge').forEach((ln) => {
    const on = ln.hasAttribute('data-skill')
      ? hl.agents.has(ln.getAttribute('data-agent')) && hl.skills.has(ln.getAttribute('data-skill'))
      : ln.hasAttribute('data-mcp')
        ? hl.agents.has(ln.getAttribute('data-agent')) && hl.mcps.has(ln.getAttribute('data-mcp'))
        : ln.hasAttribute('data-model')
        ? hl.agents.has(ln.getAttribute('data-agent')) && hl.models.has(ln.getAttribute('data-model'))
        : hl.rooms.has(ln.getAttribute('data-room')) && hl.agents.has(ln.getAttribute('data-agent'));
    ln.classList.toggle('topo-dimmed', !on);
  });
}

export function setTopoFocus(kind: string | null, id?: string | null, name?: string) {
  topoFocus = { kind, id, name };
  applyTopoFocus();
  updateTopoFocusPill();
}

export function clearTopoFocus() {
  topoFocus = null;
  applyTopoFocus();
  updateTopoFocusPill();
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function renderHealthStrip(snap: any) {
  const wsOk = state.ws && state.ws.readyState === WebSocket.OPEN;
  const pills = [
    { dot: 'ok', label: 'Server', value: 'Online' },
    { dot: 'ok', label: 'Uptime', value: snap.health.uptime ? formatUptime(snap.health.uptime) : '—' },
    { dot: wsOk ? 'ok' : 'err', label: 'WebSocket', value: wsOk ? 'Connected' : 'Disconnected' },
  ];
  if (snap.health.container_runtime_ok !== undefined && !snap.restricted) {
    pills.push({
      dot: snap.health.container_runtime_ok ? 'ok' : 'warn',
      label: 'Containers',
      value: snap.health.container_runtime_ok ? 'Up' : 'Unreachable',
    });
  }
  $('#dash-health')!.innerHTML = pills
    .map(
      (p: any) =>
        `<div class="dash-pill"><span class="pill-dot ${p.dot}"></span><span class="pill-label">${esc(p.label)}</span><span class="pill-value">${esc(p.value)}</span></div>`,
    )
    .join('');
}

// { kind, id, name } or null

export function computeTopoFocus(data: any, kind: string, id: string) {
  const agents = data?.agents || [];
  const edges = data?.edges || [];
  const mcpEdges = data?.mcpEdges || [];
  const skillEdges = data?.skillEdges || [];
  const rooms = new Set();
  const ags = new Set();
  const models = new Set();
  const mcps = new Set();
  const skls = new Set();
  const agentModel = new Map(agents.map((a: any) => [a.id, a.modelId]));
  const roomsOfAgent = new Map();
  const agentsOfRoom = new Map();
  const agentsOfModel = new Map();
  const agentsOfMcp = new Map();
  const mcpsOfAgent = new Map();
  const agentsOfSkill = new Map();
  const skillsOfAgent = new Map();
  const push = (m: any, k: any, v: any) => {
    if (k == null) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const e of edges) {
    push(roomsOfAgent, e.agent, e.room);
    push(agentsOfRoom, e.room, e.agent);
  }
  for (const a of agents) if (a.modelId) push(agentsOfModel, a.modelId, a.id);
  for (const e of mcpEdges) {
    push(agentsOfMcp, e.mcp, e.agent);
    push(mcpsOfAgent, e.agent, e.mcp);
  }
  for (const e of skillEdges) {
    push(agentsOfSkill, e.skill, e.agent);
    push(skillsOfAgent, e.agent, e.skill);
  }
  if (kind === 'model') {
    models.add(id);
    for (const a of agentsOfModel.get(id) || []) {
      ags.add(a);
      for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
    }
  } else if (kind === 'agent') {
    ags.add(id);
    if (agentModel.get(id)) models.add(agentModel.get(id));
    for (const r of roomsOfAgent.get(id) || []) rooms.add(r);
  } else if (kind === 'room') {
    rooms.add(id);
    for (const a of agentsOfRoom.get(id) || []) {
      ags.add(a);
      if (agentModel.get(a)) models.add(agentModel.get(a));
    }
  } else if (kind === 'mcp') {
    // Focusing a server answers the question that matters about it: who can
    // reach it — and therefore whose messages can end up there.
    mcps.add(id);
    for (const a of agentsOfMcp.get(id) || []) {
      ags.add(a);
      if (agentModel.get(a)) models.add(agentModel.get(a));
      for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
    }
  } else if (kind === 'skill') {
    // Focusing a skill: which agents carry it, and therefore which rooms it
    // can act in. For a learned skill that's exactly the blast radius.
    skls.add(id);
    for (const a of agentsOfSkill.get(id) || []) {
      ags.add(a);
      if (agentModel.get(a)) models.add(agentModel.get(a));
      for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
    }
  }
  // Whatever agents are in view, so are the servers and skills they carry.
  for (const a of ags) {
    for (const m of mcpsOfAgent.get(a) || []) mcps.add(m);
    for (const k of skillsOfAgent.get(a) || []) skls.add(k);
  }
  return { rooms, agents: ags, models, mcps, skills: skls };
}

// routing skill isn't installed or the viewer isn't the owner.



export function renderMetrics(snap: any) {
  const el = $('#dash-graph');
  const num = (v: any) => esc(String(Number(v) || 0));

  const agentsLabel = snap.restricted ? 'Visible agents' : 'Agents';
  const agentsCount = snap.restricted ? snap.agents.visible : snap.agents.total;
  const agentsCard = `<div class="metric-card clickable" data-detail="agents">
    <div class="metric-value">${num(agentsCount)}</div>
    <div class="metric-label">${esc(agentsLabel)}</div>
  </div>`;

  const sessionsCard = `<div class="metric-card">
    <div class="metric-value">${num(snap.sessions.active)}</div>
    <div class="metric-label">Active sessions</div>
    <div class="metric-sub">${num(snap.sessions.total)} total</div>
  </div>`;

  const messagesCard = `<div class="metric-card clickable" data-detail="messages">
    <div class="metric-value">${num(snap.messages.webchat_24h)}</div>
    <div class="metric-label">Webchat messages (24h)</div>
  </div>`;

  let containersCard;
  if (snap.restricted || snap.active_containers === null) {
    containersCard = `<div class="metric-card">
      <div class="metric-value">—</div>
      <div class="metric-label">Containers</div>
    </div>`;
  } else {
    containersCard = `<div class="metric-card clickable" data-detail="containers">
      <div class="metric-value">${num(snap.active_containers)}</div>
      <div class="metric-label">Active containers</div>
    </div>`;
  }

  const topRow = `<div class="metrics-grid">${agentsCard}${sessionsCard}${messagesCard}${containersCard}</div>`;

  // System (owner-only).
  let systemCards = '';
  if (snap.system) {
    const memBar = snap.system.memory_used_pct;
    const memColor = memBar > 85 ? 'var(--delete-color)' : memBar > 60 ? '#ffd54f' : 'var(--accent)';
    const loadStr = snap.system.load_avg.join(' / ');
    const sysCard = `<div class="metric-card wide">
      <div class="metric-label">System</div>
      <div class="sys-row"><span>Memory</span><span>${num(snap.system.memory_used_gb)} / ${num(snap.system.memory_total_gb)} GB (${num(memBar)}%)</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${num(memBar)}%;background:${memColor}"></div></div>
      <div class="sys-row"><span>CPU Load (1/5/15m)</span><span>${esc(loadStr)}</span></div>
      <div class="sys-row"><span>CPUs</span><span>${num(snap.system.cpus)}</span></div>
      <div class="sys-row"><span>Platform</span><span>${esc(snap.system.platform)}</span></div>
    </div>`;
    let ollamaCard;
    if (!snap.ollama) {
      ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">Ollama</div>
        <div class="metric-sub">Not configured</div>
      </div>`;
    } else {
      const dot = snap.ollama.ok ? '<span class="pill-dot ok"></span>' : '<span class="pill-dot err"></span>';
      const models =
        snap.ollama.models && snap.ollama.models.length
          ? snap.ollama.models.map((m: any) => `<span class="model-tag">${esc(m)}</span>`).join(' ')
          : '<span class="metric-sub">No models</span>';
      ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">${dot} Ollama</div>
        <div class="sys-row"><span>Host</span><span>${esc(snap.ollama.host)}</span></div>
        <div class="sys-row"><span>Status</span><span>${snap.ollama.ok ? 'Connected' : 'Unreachable'}</span></div>
        <div style="margin-top:6px">${models}</div>
      </div>`;
    }
    systemCards = `<div class="metrics-grid two-col">${sysCard}${ollamaCard}</div>`;
  }

  // Channels — owner-only. `null` means the server withheld it (restricted
  // caller), which is distinct from `{}` meaning "nothing wired yet"; the
  // former hides the card, the latter shows the empty state.
  let channelsCard = '';
  if (snap.channels) {
    const channelEntries = Object.entries(snap.channels).sort((a: any, b: any) => b[1] - a[1]);
    const channelHtml =
      channelEntries.length === 0
        ? '<div class="metric-sub">No channels wired</div>'
        : channelEntries
            .map(
              ([ch, count]) =>
                `<div class="channel-row"><span class="channel-name">${esc(ch)}</span><span class="channel-count">${count}</span></div>`,
            )
            .join('');
    channelsCard = `<div class="metric-card">
      <div class="metric-label">Channels</div>
      ${channelHtml}
    </div>`;
  }

  // Busiest rooms (owner-only).
  let busiestCard;
  if (snap.busiest_rooms !== null) {
    const rows =
      snap.busiest_rooms.length === 0
        ? '<div class="metric-sub">No activity</div>'
        : snap.busiest_rooms
            .map(
              (r: any) =>
                `<div class="channel-row"><span class="channel-name">#${esc(r.id)}</span><span class="channel-count">${r.count} msgs</span></div>`,
            )
            .join('');
    busiestCard = `<div class="metric-card">
      <div class="metric-label">Busiest rooms (24h)</div>
      ${rows}
    </div>`;
  } else {
    busiestCard = '';
  }

  // Both halves are owner-only, so a restricted caller gets no row at all
  // rather than an empty grid.
  const breakdownRow =
    channelsCard || busiestCard ? `<div class="metrics-grid two-col">${channelsCard}${busiestCard}</div>` : '';

  el!.innerHTML = topRow + systemCards + breakdownRow;
  // Wire the clickable cards here rather than inline onclick= — inline handlers
  // force these functions global and break under a stricter CSP.
  const details: Record<string, () => Promise<void>> = { agents: showAgentsDetail, messages: showMessagesDetail, containers: showContainersDetail };
  el!.querySelectorAll('[data-detail]').forEach((card) => {
    card.addEventListener('click', details[(card as HTMLElement).dataset.detail ?? '']);
  });
}

// ── Dashboard detail panels ───────────────────────────────────────────────


export function hideDetail() {
  $('#dash-detail')!.hidden = true;
}

export async function showMessagesDetail() {
  // Aggregate recent messages across rooms — same approach as v1.
  const rooms = await authFetch('/api/rooms')
    .then((r: any) => r.json())
    .catch(() => []);
  const since = Date.now() - 86400000;
  const perRoom = await Promise.all(
    rooms.map((room: any) =>
      authFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`)
        .then((r: any) => r.json())
        .then((msgs) => msgs.filter((m: any) => m.created_at > since).map((m: any) => ({ ...m, roomId: room.id })))
        .catch(() => []),
    ),
  );
  const all = perRoom
    .flat()
    .sort((a: any, b: any) => b.created_at - a.created_at)
    .slice(0, 50);
  if (all.length === 0) {
    showDetail('Messages (24h)', '<div class="metric-sub">No messages in the last 24 hours</div>');
    return;
  }
  const rows = all
    .map((m: any) => {
      const time = new Date(m.created_at).toLocaleTimeString();
      const icon = m.sender_type === 'agent' ? lucide('bot') : lucide('user');
      return `<tr>
      <td>${esc(time)}</td>
      <td style="color:${roomColor(m.roomId)}">#${esc(m.roomId)}</td>
      <td>${icon} ${esc(m.sender)}</td>
      <td class="msg-content">${esc(String(m.content || '').slice(0, 100))}</td>
    </tr>`;
    })
    .join('');
  showDetail(
    'Messages (24h)',
    `<table class="detail-table">
      <thead><tr><th>Time</th><th>Room</th><th>Sender</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

export async function showContainersDetail() {
  showDetail(
    'Active containers',
    `<div class="metric-sub">Run <code>docker ps --filter name=nanoclaw-</code> on the host to see container details. The number on the card reflects what was running at the moment of the last refresh.</div>`,
  );
}

export function closeOverflowMenu() {
  const menu = $('#overflow-menu');
  if (!menu) return;
  menu.hidden = true;
  $('#overflow-btn')?.setAttribute('aria-expanded', 'false');
}

export function closeTopDetailAside() {
  const layers: Array<[string, () => void]> = [
    ['members-panel', () => { $('#members-panel')!.hidden = true; }],
    ['route-detail', closeRouteDetail],
    ['model-detail', closeModelDetail],
    ['agent-detail', closeAgentDetail],
    ['mcp-detail', closeMcpDetail],
  ];
  for (const [id, close] of layers) {
    const el = document.getElementById(id);
    if (el && !el.hidden) {
      close();
      return true;
    }
  }
  return false;
}

export function openHelp() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  closeMcpDetail();
  hideOtherFullViews('help');
  helpActive.value = true;
  $('#chat')!.hidden = true;
  $('#help')!.hidden = false;
  $('#app')!.classList.add('in-dashboard');
  $('#app')!.classList.remove('in-room');
  openView('help', teardownHelp);
}
export function teardownHelp() {
  helpActive.value = false;
  $('#chat')!.hidden = false;
  $('#help')!.hidden = true;
  $('#app')!.classList.remove('in-dashboard');
}
export function toggleHelp() {
  if (helpActive.value) closeView('help');
  else openHelp();
}
