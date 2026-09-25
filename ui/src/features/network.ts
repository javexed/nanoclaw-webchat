// ── Network ──────────────────────────────────────────────────────────────────
// The install's egress allowlist, which every agent set to Allowlist (the
// default) is held to — runner agents by central's relay, local agents by
// central's egress filter — plus each agent's own hosts on top of it (the
// agent panel's Network section). Owner / global-admin for the install list;
// an agent's admins for its own. The API 403s everyone else.
//
// Below the list, what agents actually tried and were refused, each with one
// click to allow for every agent or for just the one that asked: the lists
// grow from real needs rather than guesses.
import { apiJson, authFetch } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { toastError } from '../core/toast.js';
import { hostListEditor, type HostListEditor } from './hostlist.js';
import { ago, loadAgents, type Agent } from './runners.js';

interface BlockedHost { host: string; port: number; count: number; firstAt: number; lastAt: number; agentGroupIds: string[] }
interface Egress { allowlist: string[]; defaults: string[]; always: string[]; blocked: BlockedHost[] }

/** One-click additions. Organisation-specific hosts belong in the install's own defaults (.env), not here. */
const PRESETS: Record<string, string[]> = {
  npm: ['registry.npmjs.org'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  nuget: ['api.nuget.org'],
  github: ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'],
  msdocs: ['learn.microsoft.com'],
};

const CSRF = { 'X-Webchat-CSRF': '1' };
let data: Egress | null = null;
let agents: Agent[] = [];
let editor: HostListEditor | null = null;

const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

export async function fetchNetwork(): Promise<void> {
  const note = $('#runner-egress-note');
  wire();
  try {
    const res = await authFetch('/api/egress');
    if (res.status === 403) {
      if (note) note.textContent = 'Owners and global admins only.';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as Egress;
    agents = await loadAgents();
    render();
  } catch (err) {
    console.error('Failed to fetch the egress policy:', err);
    if (note) note.textContent = `Could not load: ${(err as Error).message ?? err}`;
  }
}

function render(): void {
  const e = data;
  const note = $('#runner-egress-note');
  const ul = $('#runner-egress-blocked');
  if (!e || !note || !ul) return;
  editor?.set(e.allowlist);
  note.textContent = `Always: ${e.always.join(', ')}, and each agent's model.`;
  if (!e.blocked.length) {
    ul.innerHTML = '<li class="empty">None.</li>';
    return;
  }
  ul.innerHTML = e.blocked
    .map((b) => {
      const target = b.port === 443 || b.port === 80 ? b.host : `${b.host}:${b.port}`;
      const who = b.agentGroupIds.map((id) => esc(agentName(id))).join(', ');
      const only = b.agentGroupIds
        .map(
          (id) =>
            `<button type="button" class="btn btn-secondary btn-sm" data-allow="${esc(target)}" data-agent="${esc(id)}">${esc(agentName(id))} only</button>`,
        )
        .join('');
      return `<li><span class="rb-host" title="${esc(target)}">${esc(target)}</span><span class="rb-meta">${b.count}× · ${esc(ago(b.lastAt))} · ${who}</span><button type="button" class="btn btn-secondary btn-sm" data-allow="${esc(target)}">All agents</button>${only}</li>`;
    })
    .join('');
}

async function saveInstall(list: string[]): Promise<string[] | null> {
  try {
    const r = (await apiJson('/api/egress', { method: 'PUT', headers: CSRF, body: { allowlist: list } })) as {
      allowlist: string[];
      blocked: BlockedHost[];
    };
    if (data) {
      data.allowlist = r.allowlist;
      data.blocked = r.blocked;
      render();
    }
    return r.allowlist;
  } catch (err) {
    toastError(err, 'Could not save the allowlist');
    return null;
  }
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  const root = $<HTMLElement>('#runner-egress-hosts');
  if (root) editor = hostListEditor(root, saveInstall);
  $('#runner-egress-presets')?.addEventListener('click', (e) => {
    const preset = (e.target as HTMLElement).closest<HTMLElement>('[data-preset]')?.dataset.preset;
    if (preset) void editor?.add(PRESETS[preset] ?? []);
  });
  $('#runner-egress-reset')?.addEventListener('click', () => {
    if (data) void editor?.replace(data.defaults);
  });
  $('#runner-egress-blocked')?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-allow]');
    const host = btn?.dataset.allow;
    if (!btn || !host) return;
    btn.disabled = true;
    const agent = btn.dataset.agent;
    if (!agent) {
      await editor?.add([host]);
    } else {
      try {
        const cur = (await apiJson(`/api/agents/${encodeURIComponent(agent)}/egress/hosts`)) as { hosts: string[] };
        if (!cur.hosts.includes(host)) await putAgentHosts(agent, [...cur.hosts, host]);
      } catch (err) {
        toastError(err, `Could not allow ${host}`);
      }
    }
    await fetchNetwork();
  });
}

// ── One agent's own hosts (agent panel → Network) ──────────────────────────────

let agentEditor: HostListEditor | null = null;
let agentShown = '';
let agentMode = 'host-only';
let agentLoaded = false;

async function putAgentHosts(agentId: string, hosts: string[]): Promise<string[]> {
  const r = (await apiJson(`/api/agents/${encodeURIComponent(agentId)}/egress/hosts`, {
    method: 'PUT',
    headers: CSRF,
    body: { hosts },
  })) as { hosts: string[] };
  return r.hosts;
}

/** Only an Allowlist agent uses its own hosts, so only then is the list shown. */
function showAgentHosts(): void {
  const root = $<HTMLElement>('#agent-egress-hosts');
  if (root) root.hidden = !agentLoaded || agentMode !== 'host-only';
}

/** Load an agent's own hosts; hidden when the viewer may not manage them. */
export async function renderAgentEgressHosts(agentId: string, mode: string | undefined): Promise<void> {
  const root = $<HTMLElement>('#agent-egress-hosts');
  if (!root) return;
  agentShown = agentId;
  agentMode = mode || 'host-only';
  agentLoaded = false;
  showAgentHosts();
  if (!agentEditor)
    agentEditor = hostListEditor(
      root,
      async (hosts) => {
        try {
          return await putAgentHosts(agentShown, hosts);
        } catch (err) {
          toastError(err, 'Could not save the hosts');
          return null;
        }
      },
      '',
    );
  try {
    const r = (await apiJson(`/api/agents/${encodeURIComponent(agentId)}/egress/hosts`)) as { hosts: string[] };
    if (agentShown !== agentId) return; // another agent was opened meanwhile
    agentEditor.set(r.hosts);
    agentLoaded = true;
  } catch {
    agentLoaded = false;
  }
  showAgentHosts();
}

/** The agent's mode changed: the list shows only under Allowlist. */
export function setAgentEgressHostsMode(mode: string | undefined): void {
  agentMode = mode || 'host-only';
  showAgentHosts();
}
