// ── Runners ──────────────────────────────────────────────────────────────────
// Paired developer machines (the VS Code extension) and the agents placed on
// them. Same master/detail shape as Models: a selectable row list in the pane,
// a detail aside with the machine's facts, its placed agents and the two
// admin actions. Owner / global-admin surface — the API 403s everyone else.
//
// Plain DOM on purpose: the pane must work before any Vue island mounts, and
// the row/detail markup reuses the Models and agent-MCP class names so it
// inherits their styling rather than carrying its own.
import { apiJson, authFetch } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';
import { closeAgentDetail } from './agents.js';
import { closeMcpDetail } from './mcp.js';
import { showConfirmModal } from './modals.js';
import { closeModelDetail } from './models.js';
import { closeRoomDetail } from './rooms.js';

type MachineStatus = 'pending' | 'approved' | 'revoked';
interface Machine {
  fingerprint: string;
  user_id: string;
  hostname: string;
  os: string;
  arch: string;
  runner_version: string;
  status: MachineStatus;
  approved_by: string | null;
  last_seen: number;
}
interface Placement { agent_group_id: string; fingerprint: string; created_by: string }
interface Connected { fingerprint: string; connectedAt: number }
type ImagePolicy = 'machine' | 'pull' | 'build';
interface ImageSource { policy: ImagePolicy; ref: string | null; pin: string | null }
export interface Agent { id: string; name?: string }
interface PublishedExtension { version: string; sha256: string; size: number; publishedAt: string }
interface ClientConfig { signIn?: 'microsoft' | 'network'; tenantId?: string; appIdUri?: string; clientId?: string }
interface ClientSettings { defaults: Required<ClientConfig>; overrides: ClientConfig }
interface RunnersPayload { enabled: boolean; runners: Connected[]; machines: Machine[]; placements: Placement[]; imageSource?: ImageSource; extension?: PublishedExtension | null; client?: ClientSettings }


let data: RunnersPayload | null = null;
let agents: Agent[] = [];
let selectedFp: string | null = null;
let wired = false;

const CSRF = { 'X-Webchat-CSRF': '1' };
const who = (id: string) => id.replace(/^webchat:/, '');
const short = (fp: string) => fp.slice(0, 12);
export const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/** Agent names for display; an empty list when they cannot be read. */
export async function loadAgents(): Promise<Agent[]> {
  try {
    const a = await apiJson('/api/agents');
    return Array.isArray(a) ? a : Array.isArray(a?.agents) ? a.agents : [];
  } catch {
    return [];
  }
}
const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

export async function fetchRunners(): Promise<void> {
  const list = $('#runner-list');
  if (!list) return;
  wire();
  const note = $('#runner-list-note');
  try {
    const res = await authFetch('/api/runners');
    if (res.status === 403) {
      list.innerHTML = '';
      if (note) { note.textContent = 'Owners and global admins only.'; note.hidden = false; }
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as RunnersPayload;
    agents = await loadAgents();
    if (note) {
      note.hidden = data.enabled;
      if (!data.enabled) note.textContent = 'Runner endpoint off (WEBCHAT_RUNNER_ENABLED).';
    }
    renderList();
    renderImageSource();
    renderExtension();
    if (selectedFp) renderDetail();
  } catch (err) {
    console.error('Failed to fetch runners:', err);
    list.innerHTML = '';
    if (note) { note.textContent = `Load failed: ${(err as Error).message ?? err}`; note.hidden = false; }
  }
}

function live(fp: string): boolean {
  return !!data?.runners.some((r) => r.fingerprint === fp);
}
function placedOn(fp: string): Placement[] {
  return data?.placements.filter((p) => p.fingerprint === fp) ?? [];
}

/**
 * Install-wide image source. Binding on every paired machine: 'pull'/'build'
 * override each laptop's own setting, 'machine' hands the choice back — which
 * the note under the form says out loud, because a control that overrides
 * someone else's setting should admit it.
 */
function renderImageSource(): void {
  const src = data?.imageSource;
  const select = $<HTMLSelectElement>('#runner-image-policy');
  const input = $<HTMLInputElement>('#runner-image-ref');
  const note = $('#runner-image-note');
  if (!src || !select || !input || !note) return;
  // Don't yank the control out from under someone mid-edit.
  if (document.activeElement !== select && document.activeElement !== input) {
    select.value = src.policy;
    input.value = src.ref ?? '';
  }
  input.placeholder = 'Image reference (optional)';
  input.disabled = select.value === 'build';
  note.textContent = '';
}

/**
 * The runner package this install serves. Paired machines are offered it on
 * their next keepalive, so publishing here reaches every developer without a
 * file changing hands — which is also why only an admin may do it.
 */
function renderExtension(): void {
  const box = $('#runner-ext-current');
  if (!box) return;
  const e = data?.extension;
  box.textContent = e
    ? `${e.version} · ${(e.size / 1024).toFixed(0)} KB · ${ago(Date.parse(e.publishedAt))}`
    : 'None published.';
}

function renderList(): void {
  const list = $('#runner-list');
  if (!list || !data) return;
  if (data.machines.length === 0) {
    list.innerHTML = '<li style="cursor:default;opacity:.6">No machines.</li>';
    return;
  }
  list.innerHTML = data.machines
    .map((m) => {
      const n = placedOn(m.fingerprint).length;
      const on = live(m.fingerprint);
      return `
      <li data-fp="${esc(m.fingerprint)}" role="button" tabindex="0"${m.fingerprint === selectedFp ? ' class="active"' : ''}>
        <span class="model-kind-badge kind-${m.status}">${m.status}</span>
        <span class="model-row-name"><span class="runner-dot${on ? ' on' : ''}" title="${on ? 'connected now' : 'offline'}"></span>${esc(m.hostname || short(m.fingerprint))}</span>
        <span class="model-row-host">${esc(who(m.user_id))} · ${esc(m.os)}/${esc(m.arch)}${on ? '' : ` · seen ${ago(m.last_seen)}`}</span>
        ${n > 0 ? `<span class="model-row-uses">${n}×</span>` : ''}
      </li>`;
    })
    .join('');
}

export function openRunnerDetail(fp: string): void {
  selectedFp = fp;
  closeAgentDetail();
  closeRoomDetail();
  closeMcpDetail();
  closeModelDetail();
  renderList();
  renderDetail();
  const aside = $('#runner-detail');
  if (aside) aside.hidden = false;
}

export function closeRunnerDetail(): void {
  selectedFp = null;
  const aside = $('#runner-detail');
  if (aside) aside.hidden = true;
  if (data) renderList();
}

function renderDetail(): void {
  const m = data?.machines.find((x) => x.fingerprint === selectedFp);
  if (!m) { closeRunnerDetail(); return; }
  const badge = $('#runner-detail-badge');
  if (badge) { badge.className = `model-kind-badge kind-${m.status}`; badge.textContent = m.status; }
  const title = $('#runner-detail-title');
  if (title) title.textContent = m.hostname || short(m.fingerprint);
  const on = live(m.fingerprint);
  const facts = $('#runner-detail-facts');
  if (facts) {
    facts.textContent =
      `${who(m.user_id)} · ${m.os}/${m.arch} · ${m.runner_version || 'runner'} · ` +
      `${on ? 'online' : ago(m.last_seen)}` +
      '';
  }
  const pending = $('#runner-detail-pending');
  if (pending) pending.hidden = m.status !== 'pending';

  const approved = m.status === 'approved';
  const section = $('#runner-placed-section');
  if (section) section.hidden = !approved;
  const approve = $('#runner-approve-actions');
  if (approve) approve.hidden = approved;
  const danger = $('#runner-danger');
  if (danger) danger.hidden = !approved;
  if (!approved) return;

  const placed = placedOn(m.fingerprint);
  const ul = $('#runner-placed-list');
  if (ul) {
    ul.innerHTML = placed
      .map(
        (p) => `
      <li class="agent-mcp-row">
        <div class="agent-mcp-info">
          <span class="agent-mcp-name">${esc(agentName(p.agent_group_id))}</span>
          <span class="agent-mcp-meta">placed by ${esc(who(p.created_by))}</span>
        </div>
        <button type="button" class="agent-mcp-remove" data-unplace="${esc(p.agent_group_id)}" aria-label="Remove ${esc(agentName(p.agent_group_id))} from this machine">
          <svg class="icon" aria-hidden="true"><use href="#i-x"></use></svg>
        </button>
      </li>`,
      )
      .join('');
  }
  const empty = $('#runner-placed-empty');
  if (empty) empty.hidden = placed.length > 0;
  // An agent group lives on one machine at a time: offer only unplaced groups.
  const taken = new Set(data!.placements.map((p) => p.agent_group_id));
  const options = agents.filter((a) => !taken.has(a.id));
  const select = $<HTMLSelectElement>('#runner-place-select');
  const btn = $<HTMLButtonElement>('#runner-place-btn');
  if (select) {
    select.innerHTML =
      `<option value="">${options.length ? 'Place agent…' : 'All placed'}</option>` +
      options.map((a) => `<option value="${esc(a.id)}">${esc(a.name ?? a.id)}</option>`).join('');
    select.disabled = options.length === 0;
  }
  if (btn) btn.disabled = options.length === 0;
}

async function act(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`${what} failed`, err);
    toastError(err, `${what} failed`);
  }
  await fetchRunners();
}

function wire(): void {
  if (wired) return;
  wired = true;
  const list = $('#runner-list');
  list?.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-fp]');
    if (li?.dataset.fp) openRunnerDetail(li.dataset.fp);
  });
  list?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-fp]');
    if (li?.dataset.fp) { e.preventDefault(); openRunnerDetail(li.dataset.fp); }
  });
  $('#runner-image-policy')?.addEventListener('change', () => renderImageSource());
  $('#runner-image-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const policy = $<HTMLSelectElement>('#runner-image-policy')?.value as ImagePolicy;
    const ref = $<HTMLInputElement>('#runner-image-ref')?.value.trim() ?? '';
    void act(
      () => apiJson('/api/runners/image-source', { method: 'PUT', headers: CSRF, body: { policy, ref } }),
      'Save image source',
    );
  });
  $('#runner-ext-file')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = ''; // let the same file be chosen again after a failure
    if (!/^nanoclaw-\d+\.\d+\.\d+.*\.vsix$/.test(file.name)) {
      showToast(`Expected a package named nanoclaw-<version>.vsix, not ${file.name}`, { kind: 'error' });
      return;
    }
    void act(async () => {
      const res = await authFetch('/api/runners/extension', {
        method: 'POST',
        headers: { ...CSRF, 'X-NanoClaw-Filename': file.name, 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      return res.json();
    }, `Publish ${file.name}`);
  });
  $('#runner-detail-close')?.addEventListener('click', () => closeRunnerDetail());
  $('#runner-approve-btn')?.addEventListener('click', () => {
    const fp = selectedFp;
    if (!fp) return;
    void act(() => apiJson(`/api/runners/machines/${encodeURIComponent(fp)}/approve`, { method: 'POST', headers: CSRF }), 'Approve');
  });
  $('#runner-revoke-btn')?.addEventListener('click', () => {
    if (!selectedFp) return;
    const fp = selectedFp;
    const m = data?.machines.find((x) => x.fingerprint === fp);
    void (async () => {
      const ok = await showConfirmModal({
        title: `Revoke ${m?.hostname ?? 'this machine'}?`,
        body: 'Its sessions stop and it must be approved again to come back.',
        confirmLabel: 'Revoke',
        destructive: true,
      });
      if (!ok) return;
      await act(() => apiJson(`/api/runners/machines/${encodeURIComponent(fp)}/revoke`, { method: 'POST', headers: CSRF }), 'Revoke');
    })();
  });
  $('#runner-place-btn')?.addEventListener('click', () => {
    const select = $<HTMLSelectElement>('#runner-place-select');
    const agent = select?.value;
    if (!selectedFp || !agent) return;
    void act(
      () => apiJson(`/api/runners/placements/${encodeURIComponent(agent)}`, { method: 'PUT', headers: CSRF, body: { fingerprint: selectedFp } }),
      'Place',
    );
  });
  $('#runner-placed-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unplace]');
    if (!btn) return;
    const ag = btn.dataset.unplace!;
    void act(() => apiJson(`/api/runners/placements/${encodeURIComponent(ag)}`, { method: 'DELETE', headers: CSRF }), 'Remove placement');
  });
}
