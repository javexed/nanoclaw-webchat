// ── Agent templates ─────────────────────────────────────────────────────────
//
// A template is an Agent Plugins directory in the install's LOCAL library. It
// carries an agent's persona, skills, MCP servers and recurring tasks — but no
// provider and no secrets — and stamping it produces a configured agent.
//
// The picker only exists when the library has something in it. Most installs
// ship an empty library, and a permanently-empty select is a control that
// teaches the reader nothing; hiding it keeps the create form as short as it
// is today until templates are actually present.
//
// Choosing a template hides Instructions and the drafter, because the template
// supplies the persona and those fields would be silently ignored. That is the
// whole explanation for their absence — which is why there is no hint line
// saying so.
import { $ } from '../core/dom.js';
import { authFetch } from '../core/api.js';
import { showToast } from '../core/toast.js';
import { showConfirmModal } from './modals.js';
import { selectedAgentId } from './agent-list-state.js';

export interface AgentTemplate {
  ref: string;
  name: string;
  description?: string;
  version?: string;
}

/** Empty until loadAgentTemplates() runs; the picker stays hidden while it is. */
let templates: AgentTemplate[] = [];

/** The chosen ref, or null for a blank agent. */
export function selectedTemplateRef(): string | null {
  const sel = $<HTMLSelectElement>('#agent-create-template');
  const v = sel?.value ?? '';
  return v ? v : null;
}

/** Reset the picker to "blank agent" and restore the fields it hides. */
export function resetTemplatePick(): void {
  const sel = $<HTMLSelectElement>('#agent-create-template');
  if (sel) sel.value = '';
  applyTemplatePickVisibility();
}

/**
 * Instructions and the drafter describe a blank agent. With a template chosen
 * they do not apply, so they go away rather than sitting there inert.
 */
function applyTemplatePickVisibility(): void {
  const picked = selectedTemplateRef() !== null;
  const instructions = $('#agent-create-instructions')?.closest('label');
  const drafter = $('#agent-create-draft-prompt')?.closest('.drafter-block');
  if (instructions instanceof HTMLElement) instructions.hidden = picked;
  if (drafter instanceof HTMLElement) drafter.hidden = picked;
}

/**
 * Populate the picker. Owner-only server-side, so a non-owner simply gets no
 * templates and no picker — the same shape as an empty library, which is the
 * honest rendering either way (they cannot stamp one).
 */
export async function loadAgentTemplates(): Promise<void> {
  const wrap = $('#agent-create-template-wrap');
  const sel = $<HTMLSelectElement>('#agent-create-template');
  if (!wrap || !sel) return;
  try {
    const res = await authFetch('/api/templates');
    if (!res.ok) return; // 403 for non-owners: leave the picker hidden
    const body = (await res.json()) as { templates?: AgentTemplate[] };
    templates = Array.isArray(body.templates) ? body.templates : [];
  } catch {
    return; // a listing failure must never block creating a blank agent
  }
  if (!templates.length) {
    wrap.hidden = true;
    return;
  }
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Blank agent';
  sel.appendChild(blank);
  for (const t of templates) {
    const o = document.createElement('option');
    o.value = t.ref;
    o.textContent = t.description ? `${t.name} — ${t.description}` : t.name;
    sel.appendChild(o);
  }
  wrap.hidden = false;
  sel.addEventListener('change', applyTemplatePickVisibility);
  applyTemplatePickVisibility();
}

/**
 * Stamp the chosen template. Returns the server's error string, or null on
 * success. The caller owns the toast, so this stays usable from any form.
 */
export async function stampTemplate(ref: string, name: string): Promise<{ error: string | null; report: string[] }> {
  const res = await authFetch('/api/agents/from-template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ ref, ...(name ? { name } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; report?: string[] };
  if (!res.ok) return { error: body.error || res.statusText, report: [] };
  // The reader never silently strips a component: anything it skipped is named
  // here, and the caller surfaces it even though the stamp succeeded.
  return { error: null, report: Array.isArray(body.report) ? body.report : [] };
}

// ── Library management ──────────────────────────────────────────────────────
//
// The library block lives on the Agents tab, next to where agents are created,
// rather than in Settings — the same decomposition the model/skill/MCP blocks
// followed. It hides itself unless there is something to manage or somewhere
// to fetch from, so an install that never touches templates never sees it.

interface TemplateSource {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  official: boolean;
}

let sources: TemplateSource[] = [];

/** Render the library list. Returns how many templates are held locally. */
export async function renderTemplateLibrary(): Promise<number> {
  const wrap = $('#agent-templates');
  const list = $('#agent-templates-list');
  if (!wrap || !list) return 0;

  let held: AgentTemplate[] = [];
  try {
    const res = await authFetch('/api/templates');
    if (!res.ok) {
      wrap.hidden = true; // 403: not an owner — nothing here is actionable
      return 0;
    }
    const body = (await res.json()) as { templates?: AgentTemplate[]; error?: string };
    held = Array.isArray(body.templates) ? body.templates : [];
    if (body.error) showToast(body.error, { kind: 'error' });
  } catch {
    wrap.hidden = true;
    return 0;
  }

  list.innerHTML = '';
  for (const t of held) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = t.version ? `${t.name} ${t.version}` : t.name;
    label.title = t.description ? `${t.ref} — ${t.description}` : t.ref;
    const del = document.createElement('button');
    del.className = 'btn btn-ghost';
    del.type = 'button';
    del.textContent = 'Remove';
    del.addEventListener('click', () => void removeTemplate(t));
    li.append(label, del);
    list.appendChild(li);
  }
  wrap.hidden = false;
  return held.length;
}

/**
 * Removing a library copy does NOT affect agents already stamped from it —
 * their plugin lives in their own directory. It only means the template can no
 * longer be stamped or updated, which is what the confirmation says.
 */
async function removeTemplate(t: AgentTemplate): Promise<void> {
  const ok = await showConfirmModal({
    title: `Remove ${t.name}?`,
    body: 'Agents already created from it keep working. It can no longer be used for new agents.',
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!ok) return;
  const res = await authFetch(`/api/templates?ref=${encodeURIComponent(t.ref)}`, {
    method: 'DELETE',
    headers: { 'X-Webchat-CSRF': '1' },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    showToast('Could not remove: ' + (body.error || res.statusText), { kind: 'error' });
    return;
  }
  showToast(`Removed ${t.name}`, { kind: 'success' });
  await renderTemplateLibrary();
  await loadAgentTemplates();
}

/** Load the source list into the picker. */
async function renderSources(): Promise<void> {
  const sel = $<HTMLSelectElement>('#template-source-select');
  if (!sel) return;
  try {
    const res = await authFetch('/api/template-sources');
    if (!res.ok) return;
    const body = (await res.json()) as { sources?: TemplateSource[] };
    sources = Array.isArray(body.sources) ? body.sources : [];
  } catch {
    return;
  }
  sel.innerHTML = '';
  for (const s of sources) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.official ? s.label : `${s.label} (community)`;
    sel.appendChild(o);
  }
}

/** Browse the selected source and offer each template for fetching. */
async function browseSelectedSource(): Promise<void> {
  const sel = $<HTMLSelectElement>('#template-source-select');
  const list = $('#template-browse-list');
  if (!sel || !list || !sel.value) return;
  list.innerHTML = '';
  const pending = document.createElement('li');
  pending.textContent = 'Loading…';
  list.appendChild(pending);
  try {
    const res = await authFetch(`/api/template-sources/${encodeURIComponent(sel.value)}/browse`);
    const body = (await res.json().catch(() => ({}))) as { templates?: RemoteTemplateRow[]; error?: string };
    if (!res.ok) {
      // Reaching someone else's server is the one step here that can fail for
      // reasons the operator cannot fix locally, so say what happened.
      list.innerHTML = '';
      const err = document.createElement('li');
      err.textContent = body.error || res.statusText;
      list.appendChild(err);
      return;
    }
    const rows = Array.isArray(body.templates) ? body.templates : [];
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No templates in this source';
      list.appendChild(empty);
      return;
    }
    for (const t of rows) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = t.name;
      label.title = t.description ? `${t.ref} — ${t.description}` : t.ref;
      const get = document.createElement('button');
      get.className = 'btn btn-secondary';
      get.type = 'button';
      get.textContent = 'Get';
      get.addEventListener('click', () => void fetchTemplate(sel.value, t, get));
      li.append(label, get);
      list.appendChild(li);
    }
  } catch (err: any) {
    list.innerHTML = '';
    const e = document.createElement('li');
    e.textContent = err?.message || String(err);
    list.appendChild(e);
  }
}

interface RemoteTemplateRow {
  ref: string;
  name: string;
  description?: string;
}

async function fetchTemplate(source: string, t: RemoteTemplateRow, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const res = await authFetch('/api/templates/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ source, ref: t.ref }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; report?: string[] };
    if (!res.ok) {
      showToast('Could not get template: ' + (body.error || res.statusText), { kind: 'error' });
      return;
    }
    // Validated on arrival, so anything the reader skipped is known NOW rather
    // than at first stamp.
    for (const line of body.report ?? []) showToast(line, { kind: 'info' });
    showToast(`Added ${t.name}`, { kind: 'success' });
    await renderTemplateLibrary();
    await loadAgentTemplates();
  } finally {
    btn.disabled = false;
  }
}

async function addSource(): Promise<void> {
  const input = $<HTMLInputElement>('#template-source-repo');
  const raw = (input?.value ?? '').trim();
  if (!raw) return;
  // Accept "owner/repo" or a full GitHub URL — both are things people paste.
  const m = raw.match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m) {
    showToast('Enter owner/repo, or a GitHub repo URL', { kind: 'error' });
    return;
  }
  const res = await authFetch('/api/template-sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ owner: m[1], repo: m[2] }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    showToast('Could not add source: ' + (body.error || res.statusText), { kind: 'error' });
    return;
  }
  if (input) input.value = '';
  showToast(`Added ${m[1]}/${m[2]}`, { kind: 'success' });
  await renderSources();
  await browseSelectedSource();
}

/** Wire the library block. Safe to call once at boot. */
export function wireTemplateLibrary(): void {
  const browseBtn = $('#template-browse-btn');
  const browse = $('#template-browse');
  browseBtn?.addEventListener('click', () => {
    if (!browse) return;
    const opening = browse.hidden;
    browse.hidden = !opening;
    if (opening) void renderSources().then(() => browseSelectedSource());
  });
  $('#template-source-select')?.addEventListener('change', () => void browseSelectedSource());
  $('#template-source-add')?.addEventListener('click', () => void addSource());
}

// ── Updating a stamped agent ────────────────────────────────────────────────

interface RestampChange {
  surface: string;
  name: string;
  action: string;
  customized?: boolean;
  note?: string;
}

/**
 * Show the template row for an agent, when it was stamped from one still in
 * the library. Called whenever an agent's detail view opens.
 */
export async function renderAgentTemplateRow(agentId: string): Promise<void> {
  const row = $('#agent-template-row');
  const label = $('#agent-template-name');
  if (!row || !label) return;
  row.hidden = true;
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/template`);
    if (!res.ok) return;
    const body = (await res.json()) as { stamped?: boolean; ref?: string; plugin?: string };
    if (!body.stamped || !body.ref) return;
    label.textContent = `From ${body.ref}`;
    row.hidden = false;
    const btn = $<HTMLButtonElement>('#agent-template-update');
    if (btn) btn.onclick = () => void showUpdatePlan(agentId, body.ref!);
  } catch {
    // No row rather than an error: this is informational, not an action the
    // operator asked for.
  }
}

/**
 * Fetch the dry-run plan and show it. Applying is a separate, explicit yes —
 * and the modal states plainly which files lose local edits, because that is
 * the one consequence the plan exists to surface.
 */
async function showUpdatePlan(agentId: string, ref: string): Promise<void> {
  const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/template`);
  const body = (await res.json().catch(() => ({}))) as {
    changes?: RestampChange[];
    report?: string[];
    error?: string;
  };
  if (!res.ok) {
    showToast(body.error || res.statusText, { kind: 'error' });
    return;
  }
  const changes = body.changes ?? [];
  const changing = changes.filter((c) => c.action !== 'unchanged');
  if (!changing.length) {
    showToast(`${ref} is already up to date`, { kind: 'success' });
    return;
  }
  const customized = changing.filter((c) => c.customized);
  const lines = changing.map(
    (c) => `${c.action} ${c.surface} ${c.name}${c.customized ? '  (local edits lost)' : ''}`,
  );
  const ok = await showConfirmModal({
    title: `Update from ${ref}?`,
    body:
      lines.join('\n') +
      (customized.length
        ? `\n\n${customized.length} file(s) have local edits that applying will discard.`
        : '') +
      '\n\nMemory, chats, wiring and your own MCP servers are not touched.',
    confirmLabel: 'Update',
    destructive: customized.length > 0,
  });
  if (!ok) return;
  const applyRes = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/template/apply`, {
    method: 'POST',
    headers: { 'X-Webchat-CSRF': '1' },
  });
  const applied = (await applyRes.json().catch(() => ({}))) as { error?: string; report?: string[] };
  if (!applyRes.ok) {
    showToast('Update failed: ' + (applied.error || applyRes.statusText), { kind: 'error' });
    return;
  }
  for (const line of applied.report ?? []) showToast(line, { kind: 'info' });
  // The agent restarts as part of applying — skill and MCP changes only take
  // effect in a fresh container.
  showToast(`Updated from ${ref}; the agent restarted`, { kind: 'success' });
}

// ── Saving an agent as a template ───────────────────────────────────────────
//
// Distinct from "Export agent…", which produces a migration tarball carrying
// memory and chats. This produces a shareable BLUEPRINT: persona, skills, MCP
// servers (secrets replaced by a placeholder) and recurring tasks, and nothing
// else. The result lists what came along AND what did not, because the gap
// between "my agent works" and "the template reproduces it" is where an
// afternoon goes.

export function wireAgentTemplateExport(): void {
  $('#agent-export-template-btn')?.addEventListener('click', () => void saveAsTemplate());
}

async function saveAsTemplate(): Promise<void> {
  const id = selectedAgentId.value;
  if (!id) return;
  const suggested = ($<HTMLInputElement>('#agent-name')?.value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = window.prompt('Template name (lowercase letters, digits and dashes)', suggested || 'my-agent');
  if (!name) return;

  const res = await authFetch(`/api/agents/${encodeURIComponent(String(id))}/export-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    ref?: string;
    included?: { skills: string[]; tasks: string[]; mcpServers: string[]; contextFiles: string[]; persona: boolean };
    omitted?: string[];
  };
  if (!res.ok) {
    showToast('Could not save as template: ' + (body.error || res.statusText), { kind: 'error' });
    return;
  }
  const inc = body.included;
  const carried = inc
    ? [
        inc.persona ? 'persona' : null,
        inc.skills.length ? `${inc.skills.length} skill(s)` : null,
        inc.mcpServers.length ? `${inc.mcpServers.length} MCP server(s)` : null,
        inc.tasks.length ? `${inc.tasks.length} task(s)` : null,
        inc.contextFiles.length ? `${inc.contextFiles.length} context file(s)` : null,
      ].filter(Boolean)
    : [];
  // A modal rather than a toast: the omissions are the part worth reading, and
  // a toast is exactly where that would be missed.
  await showConfirmModal({
    title: `Saved as ${body.ref}`,
    body:
      (carried.length ? `Carried: ${carried.join(', ')}.\n\n` : '') +
      (body.omitted?.length ? `Not carried:\n${body.omitted.map((o) => `• ${o}`).join('\n')}` : ''),
    confirmLabel: 'Done',
    cancelLabel: '',
  });
  await renderTemplateLibrary();
  await loadAgentTemplates();
}
