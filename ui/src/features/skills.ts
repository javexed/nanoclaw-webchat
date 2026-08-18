// ── Skills ───────────────────────────────────────────────────────────────────
// The skills surface: catalog and sources, trust tiers, the editor and its
// draft lifecycle, the review / keep / discard flow for agent-proposed drafts,
// the distill action and the suggestion box.
//
// Scoped by measurement. `skill*` alone is 38 functions at 2.0 external
// references per 100 lines; folding in `draft*` and `distill*` — the same
// feature under different nouns — adds 116 lines for NO extra coupling, at 1.8.
//
// skillEditorDraft is OWNED here rather than injected. Legacy reads it exactly
// once, so the dependency runs the sensible way round: the module owns its own
// editor state and exposes a getter, instead of legacy holding it and handing
// down an accessor pair.
import { createApp } from 'vue';
import { loadingRow } from './mcp.js';
import { resetTemplatePick, selectedTemplateRef, stampTemplate } from './agent-templates.js';
import { showConfirmModal } from './modals.js';
import { viewStack } from './views-state.js';
import { selectedRoomId } from './room-list-state.js';
import { roomDetailWiredAgents } from './agent-detail-state.js';
import { selectedAgentId } from './agent-list-state.js';
import AgentSkillsList from './AgentSkillsList.vue';
import { agentSkillRows, agentSkillsEnabled } from './agent-skills-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { closeAgentDetail, fetchAgents } from './agents.js';
import { joinRoom } from './rooms.js';
import { closeView } from './views.js';
import { isLearnUrlToken, pickLearnTarget, promptLearnSource } from './learn.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { UNDO_SECONDS } from '../core/constants.js';
import { state } from '../core/state.js';
import { originBadgeEl } from './origin-badge.js';
import SkillDuplicates from './SkillDuplicates.vue';
import AgentScopedSkills from './AgentScopedSkills.vue';
import SkillSources from './SkillSources.vue';
import SkillsRegistry from './SkillsRegistry.vue';
import SkillDrafts from './SkillDrafts.vue';
import SkillPool from './SkillPool.vue';
import SkillSuggestions from './SkillSuggestions.vue';
import RoomSkills from './RoomSkills.vue';
import SkillDraftCard from './SkillDraftCard.vue';
import SkillEditorModal from './SkillEditorModal.vue';
import {
  agentScopedSkills,
  promotingSkills,
  skillDuplicates,
  skillSections,
  skillSources,
  skillUpdates,
  skillUpdating,
  skillsFilter,
  skillsOpenSections,
  skillsPhase,
  skillDrafts,
  draftUndo,
  draftsReviewing,
  skillPool,
  skillPoolCommunity,
  skillPoolPhase,
  skillPoolQuery,
  skillSuggestions,
  roomSkillRows,
  roomSkillUndo,
  roomSkillsReviewing,
  cardUndo,
  cardReviewing,
} from './skills-panel-state.js';
import { nextKey } from './transcript-state.js';

/**
 * A skill in the catalog. Derived from every property this module reads —
 * fifth type built this way after Approval, ThinkingTurn, Room and Agent.
 * Broad because the catalog merges several sources (built-in, repo, agent
 * -scoped) that carry different subsets.
 */
export interface Skill {
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  source?: string;
  origin?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  branch?: string;
  dir?: string;
  url?: string;
  official?: boolean;
  installed?: boolean;
  hasHistory?: boolean;
  invocations?: number;
  review?: unknown;
  rooms?: unknown[];
  agentId?: string;
  agentGroupId?: string;
  agentName?: string;
}

/** A draft an agent proposed, or one being authored in the editor. */
export interface SkillDraft {
  draftId?: string;
  id?: string;
  kind?: string;
  mode?: string;
  name?: string;
  skillName?: string;
  description?: string;
  body?: string;
  currentBody?: string;
  isPatch?: boolean;
  status?: string;
  targetSkill?: string;
  roomId?: string;
  agentGroupId?: string;
  agentName?: string;
  agents?: unknown[];
}

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideSkillsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface SkillsDeps {
  closeRoomDetail: (...args: any[]) => any;
  closeView: (...args: any[]) => any;
  joinRoom: (...args: any[]) => any;
  openJourney: (...args: any[]) => any;
  openManage: (...args: any[]) => any;
  openView: (...args: any[]) => any;
  openWireToAgentsPicker: (...args: any[]) => any;
  showConfirmModal: (...args: any[]) => any;
  triggerLearn: (...args: any[]) => any;
}

const deps = {} as SkillsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideSkillsDeps(provided: Partial<SkillsDeps>): void {
  Object.assign(deps, provided);
}

/** The in-flight editor draft. Read-only to the outside. */
export function getSkillEditorDraft() {
  return skillEditorDraft;
}

/**
 * Per-card Vue apps, keyed by draft id.
 *
 * Every other island mounts once into a container from index.html. These mount
 * into a wrapper created here and appended to #messages, which the transcript
 * owns — so each card is its own app, and each has to be unmounted when its
 * card is replaced or the transcript is cleared. Nothing else does that, which
 * is exactly why it is tracked rather than left to garbage collection: a live
 * app on a detached node keeps its reactive effects subscribed.
 */
const draftCardApps = new Map<string, ReturnType<typeof createApp>>();

function unmountDraftCard(id: string) {
  const app = draftCardApps.get(id);
  if (!app) return;
  app.unmount();
  draftCardApps.delete(id);
}

/** Called by the transcript when it clears #messages wholesale. */
export function unmountAllDraftCards() {
  for (const id of [...draftCardApps.keys()]) unmountDraftCard(id);
}

export function skillDraftRow(msg?: any): any {
  void refreshDraftBadge();
  let d: any = {};
  try {
    d = JSON.parse(msg.content) || {};
  } catch {
    d = {};
  }
  const id = d.draftId || msg.id;
  const resolved = d.status === 'kept' || d.status === 'discarded';
  const title = d.kind === 'patch' ? `Proposed change to ${d.targetSkill || d.skillName}` : `Proposed skill: ${d.skillName}`;

  if (reviewingDrafts.has(id)) cardReviewing.value = new Set(cardReviewing.value).add(id);
  const props = {
    title,
    resolved,
    status: d.status || '',
    agentName: d.agentName || '',
    desc: d.description || '',
    undoSeconds: UNDO_SECONDS,
    draftId: id,
    onView: () => openSkillDraft(d.draftId),
    onKeep: () =>
      armCardUndo(id, `Keeping ${d.skillName}…`, () =>
        keepSkillDraft({ id: d.draftId, agentGroupId: d.agentGroupId, agentName: d.agentName }, null),
      ),
    onDiscard: () => armCardUndo(id, `Discarding ${d.skillName}…`, () => discardSkillDraft(d.draftId)),
    onUndo: () => clearCardUndo(id),
  };
  // Resolving re-broadcasts the SAME card id. That used to mean replacing the
  // element and unmounting the old card's app; as a row it is keyed by draftId,
  // so the transcript replaces it by identity and there is no app to unmount.
  return { key: nextKey(), kind: 'draft', id, payload: props };
}

function armCardUndo(id: string, label: string, commit: () => unknown) {
  // Measured BEFORE the swap, as armUndo did — after would read the timer. The
  // card is found by draft id now that the caller no longer holds its wrapper.
  const el = $(`#messages .skill-draft-msg[data-draft-id="${id}"] .skill-draft-actions`);
  const w = el ? (el as HTMLElement).getBoundingClientRect().width : 0;
  cardUndo.value = {
    ...cardUndo.value,
    [id]: { label, width: w ? `${w}px` : '', commit: () => { clearCardUndo(id); void commit(); } },
  };
}

function clearCardUndo(id: string) {
  const next = { ...cardUndo.value };
  delete next[id];
  cardUndo.value = next;
}

export async function refreshDraftBadge(known?: any) {
  let n = known;
  if (typeof n !== 'number') {
    try {
      const res = await authFetch('/api/skill-drafts');
      n = res.ok ? ((await res.json()).drafts || []).length : 0;
    } catch {
      n = 0;
    }
  }
  const dot = $('#learn-drafts-dot');
  const pill = $('#learn-drafts-count');
  if (dot) dot.hidden = n === 0;
  if (pill) {
    pill.hidden = n === 0;
    pill.textContent = n > 0 ? String(n) : '';
  }
}

let draftsApp: ReturnType<typeof createApp> | null = null;

function mountSkillDrafts(): void {
  if (draftsApp) return;
  const host = $('#skill-drafts-list');
  if (!host) return;
  draftsApp = createApp(SkillDrafts, {
    undoSeconds: UNDO_SECONDS,
    onOpen: (id: string) => openSkillDraft(id),
    // The draft is a claim about a conversation — one click back to the
    // evidence beats trusting the description.
    onSource: (roomId: string) => {
      const room = state.lastRoomsList.find((r: any) => r.id === roomId);
      deps.joinRoom(roomId, room ? room.name : roomId);
    },
    onKeep: (r: any) => armDraftUndo(r.id, `Keeping ${r.raw.skillName}…`, () => keepSkillDraft(r.raw, null)),
    onDiscard: (r: any) => armDraftUndo(r.id, `Discarding ${r.raw.skillName}…`, () => discardSkillDraft(r.id)),
    onUndo: (id: string) => clearDraftUndo(id),
  });
  draftsApp.mount(host);
}

function armDraftUndo(id: string, label: string, commit: () => unknown) {
  // Freeze the actions' current width before swapping in the timer, so the row
  // does not jump. armUndo did the same with getBoundingClientRect(); measuring
  // AFTER the swap would read the timer's width and defeat the point.
  const el = document.querySelector(`#skill-drafts-list li[data-draft-id="${CSS.escape(id)}"] .skill-draft-actions`);
  const w = el ? (el as HTMLElement).getBoundingClientRect().width : 0;
  draftUndo.value = {
    ...draftUndo.value,
    [id]: {
      label,
      width: w ? `${w}px` : '',
      commit: () => {
        clearDraftUndo(id);
        void commit();
      },
    },
  };
}

function clearDraftUndo(id: string) {
  const next = { ...draftUndo.value };
  delete next[id];
  draftUndo.value = next;
}

async function renderSkillDrafts() {
  const wrap = $('#skill-drafts');
  if (!wrap || !$('#skill-drafts-list')) return;
  let drafts = [];
  try {
    const res = await authFetch('/api/skill-drafts');
    if (res.ok) drafts = (await res.json()).drafts || [];
  } catch {}
  wrap.hidden = drafts.length === 0;
  void refreshDraftBadge(drafts.length);
  skillDrafts.value = drafts;
  // A re-render mid-review must not resurrect a clickable Keep.
  draftsReviewing.value = new Set(
    [...reviewingDrafts].filter((id): id is string => drafts.some((d: any) => d.id === id)),
  );
  mountSkillDrafts();
}

let skillEditorDraft: any = null;

function openSkillEditorModal({ name, body, editable, badgeText, onSave, actions = [] }: any) {
  // Per-instance, like the draft cards: nothing owns document.body, so the
  // overlay is created here and the app is mounted INTO it. Not into a child —
  // the original structure is overlay > modal, and a wrapper div would break any
  // `.modal-overlay > .modal` rule. Vue replaces the host's children and never
  // the host, so the overlay keeps its own click-outside listener.
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  let app: ReturnType<typeof createApp> | null = null;
  const close = () => {
    // Unmount before removing, so the component's onUnmounted can drop its
    // document-level keydown listener. Removing the node alone would leave that
    // listener attached to a dialog nobody can see.
    app?.unmount();
    app = null;
    overlay.remove();
  };

  app = createApp(SkillEditorModal, {
    name,
    body,
    editable: !!editable,
    badgeText: badgeText || '',
    actions,
    onSave: async (text: string) => {
      try {
        await onSave(text);
      } catch (err) {
        showToast('Save failed: ' + ((err as any)?.message || err), { kind: 'error' });
        throw err; // the component restores its own button
      }
    },
    onClose: close,
  });
  app.mount(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

export async function openScopedSkillEditor(agentId?: any, name?: any) {
  let data = null;
  try {
    data = await apiJson(
      `/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}/content`,
    );
  } catch (err) {
    return showToast('Couldn’t load skill: ' + ((err as any)?.message || err), { kind: 'error' });
  }
  openSkillEditorModal({
    name: data.name,
    body: data.body,
    editable: !!data.editable,
    badgeText: data.editable ? 'learned · editable (this agent)' : 'read-only',
    // Deep-link into Journey pre-filtered to this skill's history.
    actions: [{ label: 'History', onClick: () => deps.openJourney({ agentGroupId: agentId, skill: name }) }],
    onSave: async (content: any) => {
      const out = await apiJson(
        `/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}/content`,
        { method: 'PUT', body: { content } },
      );
      showToast(`Saved ${out.name} — applies on this agent's next spawn`, { kind: 'success' });
      if (selectedAgentId.value) renderAgentSkills(selectedAgentId.value);
    },
  });
}

async function openPoolSkillFromAgent(name?: any) {
  let data = null;
  try {
    data = await apiJson(`/api/skills/${encodeURIComponent(name)}`);
  } catch (err) {
    return showToast('Couldn’t load skill: ' + ((err as any)?.message || err), { kind: 'error' });
  }
  const editable = data.source === 'user';
  openSkillEditorModal({
    name: data.name,
    body: data.content,
    editable,
    badgeText: editable ? 'imported · editable' : 'built-in · read-only',
    onSave: async (content: any) => {
      const out = await apiJson(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: { content } });
      showToast(`Saved ${out.name} — applies on each agent's next spawn`, { kind: 'success' });
    },
  });
}

async function openSkillDraft(id?: any) {
  try {
    const d = await apiJson(`/api/skill-drafts/${encodeURIComponent(id)}`);
    const isPatch = d.kind === 'patch' && d.targetSkill;
    skillEditorDraft = {
      id: d.id,
      name: isPatch ? d.targetSkill : d.skillName,
      isPatch,
      body: d.body,
      currentBody: d.currentBody || '',
      // A revision opens on the DIFF (review first); a brand-new skill opens
      // straight into editing.
      mode: isPatch && d.currentBody ? 'diff' : 'edit',
    };
    // The editor lives inside the Skills view — from a room (in-room card, room
    // settings) that parent is hidden, and filling a hidden editor is a no-op the
    // user reads as "nothing happened". Open the Skills view first; its renderer
    // force-lands on 'browse' synchronously, so the editor flip runs a tick later.
    const draft = skillEditorDraft;
    if ($('#manage')!.hidden || $('#mtab-skills')!.hidden) {
      deps.openManage('skills');
      // renderSkillsRegistry force-lands on 'browse' AND clears draft state via
      // showSkillEditor(false) — so re-arm the draft when the editor flips open.
      setTimeout(() => {
        skillEditorDraft = draft;
        renderDraftEditor();
      }, 200);
    } else {
      renderDraftEditor();
    }
  } catch (err) {
    showToast('Could not open draft: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

export function renderDraftEditor() {
  const d = skillEditorDraft;
  if (!d) return;
  const content = $<HTMLTextAreaElement>('#skill-editor-content')!;
  $<HTMLInputElement>('#skill-editor-name')!.value = d.name;
  $<HTMLInputElement>('#skill-editor-name')!.readOnly = true; // the name is the draft's identity
  const badge = $('#skill-editor-badge')!;
  if (badge) {
    badge.hidden = false;
    badge.className = 'skill-badge';
    badge.textContent = d.isPatch ? `proposed revision of ${d.name}` : 'proposed skill';
  }
  const modeBtn = $('#skill-editor-mode');
  if (d.mode === 'diff') {
    content.value = lineDiff(d.currentBody, d.body);
    content.readOnly = true;
    $('#skill-editor-save')!.hidden = true;
    if (modeBtn) {
      modeBtn.hidden = false;
      modeBtn.textContent = 'Edit';
    }
  } else {
    content.value = d.body;
    content.readOnly = false;
    $('#skill-editor-save')!.hidden = false;
    if (modeBtn) {
      // The diff view only exists when there's a current version to diff against.
      modeBtn.hidden = !(d.isPatch && d.currentBody);
      modeBtn.textContent = 'View diff';
    }
  }
  showSkillEditor(true);
}

const reviewingDrafts = new Set();

export function draftKeepButton(draftId?: any) {
  return document.querySelector(`button[data-draft-id="${CSS.escape(draftId)}"]`);
}

function markDraftReviewing(btn?: any, reviewing?: any) {
  if (!btn) return;
  btn.disabled = reviewing;
  btn.textContent = reviewing ? 'Reviewing…' : 'Keep';
}

export function handleSkillDraftReview(msg?: any) {
  reviewingDrafts.delete(msg.draftId);
  const d = { id: msg.draftId, skillName: msg.skillName, agentGroupId: msg.agentGroupId, agentName: msg.agentName };
  if (msg.outcome === 'kept') {
    showToast(
      msg.updated
        ? `Updated ${msg.name || d.skillName} — wired to ${d.agentName}`
        : `Kept ${msg.name || d.skillName} — wired to ${d.agentName}`,
      { kind: 'success' },
    );
    void refreshDraftBadge();
    renderSkillsRegistry();
    return;
  }
  markDraftReviewing(draftKeepButton(msg.draftId), false);
  if (msg.outcome === 'overlaps' && Array.isArray(msg.overlaps) && msg.overlaps.length) {
    void showOverlapChoice(d, msg.overlaps);
    return;
  }
  toastError(new Error(msg.error || 'Review failed'), 'Keep failed');
}

export async function keepSkillDraft(d?: any, btn?: any, force?: any, updateTarget?: any) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = updateTarget ? 'Updating…' : 'Keeping…';
  }
  try {
    const qs = updateTarget ? `?updateTarget=${encodeURIComponent(updateTarget)}` : force ? '?force=1' : '';
    const res = await authFetch(`/api/skill-drafts/${encodeURIComponent(d.id)}/keep${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentGroupId: d.agentGroupId }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 202 && body.queued) {
      reviewingDrafts.add(d.id);
      markDraftReviewing(btn, true);
      return;
    }
    if (!res.ok) throw new Error(body.error || res.statusText);
    showToast(
      body.updated ? `Updated ${body.name} — wired to ${d.agentName}` : `Kept ${body.name} — wired to ${d.agentName}`,
      { kind: 'success' },
    );
    void refreshDraftBadge();
    renderSkillsRegistry();
  } catch (err) {
    toastError(err, 'Keep failed');
    markDraftReviewing(btn, false);
  }
}

export async function discardSkillDraft(id?: any) {
  try {
    await apiJson(`/api/skill-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    void refreshDraftBadge();
    renderSkillDrafts();
  } catch (err) {
    showToast('Discard failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

async function renderSkillDuplicates() {
  const wrap = $('#skill-duplicates');
  const list = $('#skill-duplicates-list')!;
  if (!wrap || !list) return;
  let dups = [];
  try {
    const res = await authFetch('/api/skills/duplicates');
    if (res.ok) dups = (await res.json()).duplicates || [];
  } catch {}
  wrap.hidden = dups.length === 0;
  skillDuplicates.value = dups;
  mountSkillDuplicates();
}

let skillDuplicatesApp: ReturnType<typeof createApp> | null = null;

function mountSkillDuplicates(): void {
  if (skillDuplicatesApp) return;
  const host = $('#skill-duplicates-list');
  if (!host) return;
  skillDuplicatesApp = createApp(SkillDuplicates, { onPromote: (name: string) => void promoteSkill(name) });
  skillDuplicatesApp.mount(host);
}

/**
 * The disable-on-click that used to live on the button element. Keyed by name
 * in a pending set, because the row is a vnode now and there is no element to
 * hold — but the guard itself matters: without it a double-click promotes twice.
 */
async function promoteSkill(name: string) {
  const ok = await deps.showConfirmModal({
    title: `Promote ${name} to the shared pool?`,
    body: `The newest copy serves every agent; each agent's own copy moves to its archive.`,
    confirmLabel: 'Promote',
  });
  if (!ok) return;
  promotingSkills.value.add(name);
  try {
    await apiJson('/api/skills/promote', { method: 'POST', body: { name } });
    showToast(`${name} promoted — shared with all agents`, { kind: 'success' });
    renderSkillsRegistry();
  } catch (err) {
    showToast('Promote failed: ' + ((err as any)?.message || err), { kind: 'error' });
  } finally {
    // The imperative version re-enabled only on failure — on success the row was
    // about to be replaced by renderSkillsRegistry. Clearing unconditionally is
    // equivalent and does not depend on that replacement happening.
    promotingSkills.value.delete(name);
  }
}

function skillsSectionOpen(key?: any) {
  const v = localStorage.getItem('skillsSectionOpen:' + key);
  return v === null ? key === 'pool' : v === '1';
}

function setSkillsSectionOpen(key?: any, open?: any) {
  localStorage.setItem('skillsSectionOpen:' + key, open ? '1' : '0');
}

function skillsFilterQuery() {
  return ($<HTMLInputElement>('#skills-filter')?.value || '').trim().toLowerCase();
}



let registryApp: ReturnType<typeof createApp> | null = null;

function mountSkillsRegistry(): void {
  if (registryApp) return;
  const host = $('#skills-list');
  if (!host) return;
  registryApp = createApp(SkillsRegistry, {
    // Click the row to open the SKILL.md viewer/editor (user skills editable).
    // Scoped rows open the agent's own copy via the scoped content endpoint.
    onOpen: (r: any) => (r.source === 'scoped' ? openScopedSkillEditor(r.agentGroupId, r.name) : openSkillEditor(r.name)),
    onToggleSection: (key: string) => {
      if (skillsFilter.value) return; // an active filter owns expansion
      const next = new Set(skillsOpenSections.value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      skillsOpenSections.value = next;
      setSkillsSectionOpen(key, next.has(key));
    },
    onDelete: (r: any) =>
      r.source === 'scoped'
        ? removeAgentScopedSkill(r.agentGroupId, r.name, null, renderSkillsRegistry)
        : deleteSkill(r.name),
    // 'View history': jump to Journey pre-filtered to this skill.
    onHistory: (r: any) => deps.openJourney({ agentGroupId: r.agentGroupId, agentName: r.agentName, skill: r.name }),
    onUpdate: (name: string) => void updateSkillFromSource(name),
  });
  registryApp.mount(host);
}

async function updateSkillFromSource(name: string) {
  const ok = await deps.showConfirmModal({
    title: `Update ${name}?`,
    body: 'Re-imports from its source at the latest commit. The current version is kept in history.',
    confirmLabel: 'Update',
  });
  if (!ok) return;
  skillUpdating.value = new Set(skillUpdating.value).add(name);
  try {
    const body = await apiJson(`/api/skills/${encodeURIComponent(name)}/update`, { method: 'POST' });
    showToast(`Updated ${name}`, { kind: 'success' });
    for (const w of body.warnings || []) showToast(`⚠ ${w}`, { kind: 'error' });
    renderSkillsRegistry();
  } catch (err) {
    showToast('Update failed: ' + ((err as any)?.message || err), { kind: 'error' });
  } finally {
    const next = new Set(skillUpdating.value);
    next.delete(name);
    skillUpdating.value = next;
  }
}

/**
 * Re-apply the filter. The island derives visibility from skillsFilter, so this
 * only has to copy the box's value in — the DOM walk applySkillsSections did is
 * gone with it.
 */
export function applySkillsSections() {
  skillsFilter.value = skillsFilterQuery();
}

/**
 * Which skills have newer commits upstream. Was markSkillUpdates(), which
 * queried already-rendered rows and injected a button into each — an async pass
 * reaching into rendered DOM, which is precisely what an island forbids.
 */
async function loadSkillUpdates() {
  let updates = [];
  try {
    const res = await authFetch('/api/skills/updates');
    if (res.ok) updates = (await res.json()).updates || [];
  } catch {}
  const map: Record<string, boolean> = {};
  for (const u of updates) if (u.hasUpdate) map[u.name] = true;
  skillUpdates.value = map;
}

export async function renderSkillsRegistry() {
  if (!$('#skills-list')) return;
  showSkillEditor(false); // always land on the browse view
  renderSkillDrafts();
  void renderSkillDuplicates();
  // 'Add from link…' rides the learning loop (it sends /learn into a room), so
  // it follows the same master gate as the composer 🎓. The page itself is
  // already admin-gated, and the picker only offers agents the caller admins.
  const learnLink = $('#skills-learn-link');
  if (learnLink) learnLink.hidden = !state.learningMasterEnabled;
  skillsPhase.value = 'loading';
  mountSkillsRegistry();
  let skills = [];
  try {
    const res = await authFetch('/api/skills');
    if (res.ok) skills = (await res.json()).skills || [];
  } catch (err) {
    console.error('Failed to load skills:', err);
  }
  const filterEl = $('#skills-filter');
  if (!skills.length) {
    if (filterEl) filterEl.hidden = true;
    skillSections.value = [];
    skillsPhase.value = 'empty';
    return;
  }
  if (filterEl) filterEl.hidden = false;
  // Partition into sections: the shared pool, then one section per agent
  // holding scoped skills, sorted by agent name.
  const pool: any[] = [];
  const byAgent = new Map<string, any>();
  for (const s of skills) {
    if (s.source === 'scoped') {
      let g = byAgent.get(s.agentGroupId);
      if (!g) byAgent.set(s.agentGroupId, (g = { name: s.agentName || '', rooms: s.rooms || [], skills: [] }));
      g.skills.push(s);
    } else pool.push(s);
  }
  const shape = (s: any): any => ({
    key: (s.source === 'scoped' ? s.agentGroupId + ':' : '') + s.name,
    name: s.name ?? '',
    desc: s.description || '',
    // Provenance: shipped skills are "built-in"; imported ones show their
    // origin; legacy imports with no recorded origin fall back to "imported".
    // Scoped skills get a scope pill instead — the room's name when the agent
    // serves exactly one room, otherwise the agent's name (a room name would be
    // ambiguous, a count says nothing) — plus their origin badge when recorded.
    badge:
      s.source === 'scoped'
        ? { kind: 'scope', text: s.rooms && s.rooms.length === 1 ? s.rooms[0].name : s.agentName }
        : s.source === 'shipped'
          ? { kind: 'shipped', text: 'built-in' }
          : s.origin && s.origin.label
            ? { kind: 'origin', origin: s.origin }
            : { kind: 'imported', text: 'imported' },
    extraOrigin: s.source === 'scoped' && s.origin && s.origin.label ? s.origin : null,
    source: s.source,
    agentGroupId: s.agentGroupId,
    agentName: s.agentName,
    search: (s.name + ' ' + (s.description || '')).toLowerCase(),
  });
  const sections: any[] = [];
  if (pool.length) sections.push({ key: 'pool', label: 'Workspace', roomName: null, rows: pool.map(shape) });
  for (const [gid, g] of [...byAgent].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    sections.push({
      key: gid,
      label: g.name,
      roomName: g.rooms.length === 1 ? g.rooms[0].name : null,
      rows: g.skills.map(shape),
    });
  }
  skillSections.value = sections;
  skillsOpenSections.value = new Set(sections.filter((x) => skillsSectionOpen(x.key)).map((x) => x.key));
  skillsPhase.value = 'ready';
  applySkillsSections();
  void loadSkillUpdates();
}



const SKILL_TEMPLATE = `---
name: my-skill
description: One line saying what this skill is for and when to use it.
---

# My Skill

Instructions the agent follows when this skill applies.
`;

function showSkillsView(view?: any) {
  $('#skills-browse')!.hidden = view !== 'browse';
  $('#skills-add')!.hidden = view !== 'add';
  $('#skills-editor')!.hidden = view !== 'editor';
}

function resetSkillEditorState() {
  skillEditorDraft = null;
  const m = $('#skill-editor-mode');
  if (m) m.hidden = true;
}

let skillEditorClosing = false;

export function showSkillEditor(show?: any) {
  if (show) {
    skillEditorClosing = false;
    showSkillsView('editor');
    // Register the editor as a router view so ONE back gesture (or the in-app
    // Back button) returns to the skills list, and a second leaves Manage —
    // instead of the gesture skipping the un-tracked editor and closing Manage
    // outright, which read as "back does nothing, then closes".
    if (!viewStack.some((v: any) => v.name === 'skill-editor')) {
      deps.openView('skill-editor', () => {
        skillEditorClosing = false;
        resetSkillEditorState();
        showSkillsView('browse');
      });
    }
    return;
  }
  // Programmatic close drives through the router so history and the view stack
  // stay in sync — a bare showSkillsView would strand the pushed history entry
  // and make the next back gesture a dead press.
  if (viewStack.some((v: any) => v.name === 'skill-editor')) {
    if (!skillEditorClosing) {
      skillEditorClosing = true;
      deps.closeView('skill-editor');
    }
    return;
  }
  // No registered view (e.g. a fresh browse render) → plain reset.
  resetSkillEditorState();
  showSkillsView('browse');
}

function skillsLoadingRow(label?: any) {
  // Thin alias over loadingRow() — DESIGN.md §5 wants ONE wait primitive, so every
  // fetching list shows the same ring rather than growing its own variant.
  return loadingRow(label);
}

let skillTrust = 'official';

let poolSeq = 0;

export async function openSkillsAdd() {
  showSkillsView('add');
  $<HTMLInputElement>('#skill-discover-search')!.value = '';
  await setSkillTrust('official');
}

export async function setSkillTrust(mode?: any) {
  skillTrust = mode;
  const official = mode === 'official';
  $('#skills-trust-official')!.classList.toggle('active', official);
  $('#skills-trust-official')!.setAttribute('aria-selected', String(official));
  $('#skills-trust-community')!.classList.toggle('active', !official);
  $('#skills-trust-community')!.setAttribute('aria-selected', String(!official));
  const search = ($('#skill-discover-search')!) as HTMLInputElement;
  search.hidden = official;
  if (official) search.value = '';
  $('#skills-catalog-warn')!.hidden = official; // community warning is persistent
  await renderSkillPool();
}

let poolApp: ReturnType<typeof createApp> | null = null;

function mountSkillPool(): void {
  if (poolApp) return;
  const host = $('#skills-catalog-list');
  if (!host) return;
  poolApp = createApp(SkillPool, {
    onAdd: (s: any) =>
      deps.openWireToAgentsPicker({ ...s.ref, origin: s.origin }, s.name, { community: skillPoolCommunity.value }),
  });
  poolApp.mount(host);
}

export async function renderSkillPool() {
  if (!$('#skills-catalog-list')) return;
  const tier = skillTrust;
  const community = tier === 'community';
  const q = community ? $<HTMLInputElement>('#skill-discover-search')!.value.trim() : '';
  const seq = ++poolSeq;
  skillPoolCommunity.value = community;
  skillPoolQuery.value = q;
  skillPoolPhase.value = 'loading';
  mountSkillPool();
  let data = null;
  try {
    const res = await authFetch(`/api/skills/catalog?tier=${tier}&q=${encodeURIComponent(q)}`);
    if (res.ok) data = await res.json();
  } catch {}
  if (seq !== poolSeq) return; // superseded by a newer tier switch / keystroke
  if (!data) {
    skillPool.value = [];
    skillPoolPhase.value = 'error';
    return;
  }
  const skills = data.skills || [];
  skillPool.value = skills;
  skillPoolPhase.value = skills.length ? 'ready' : 'empty';
}

export async function openSkillEditor(name?: any) {
  skillEditorDraft = null;
  const modeBtn = $('#skill-editor-mode');
  if (modeBtn) modeBtn.hidden = true;
  const nameInput = $<HTMLInputElement>('#skill-editor-name')!;
  const content = $<HTMLTextAreaElement>('#skill-editor-content')!;
  const badge = $('#skill-editor-badge')!;
  const save = $('#skill-editor-save')!;
  if (name) {
    let data = null;
    try {
      const res = await authFetch(`/api/skills/${encodeURIComponent(name)}`);
      if (res.ok) data = await res.json();
    } catch {}
    if (!data) return showToast('Couldn’t load skill', { kind: 'error' });
    nameInput.value = data.name;
    nameInput.readOnly = true;
    content.value = data.content;
    const editable = data.source === 'user';
    content.readOnly = !editable;
    save.hidden = !editable;
    badge.hidden = false;
    badge.className = 'skill-badge skill-badge-' + data.source;
    badge.textContent = editable ? 'imported — editable' : 'built-in — read-only';
  } else {
    nameInput.value = '';
    nameInput.readOnly = false;
    content.value = SKILL_TEMPLATE;
    content.readOnly = false;
    save.hidden = false;
    badge.hidden = true;
  }
  showSkillEditor(true);
  (name ? content : nameInput).focus();
}

export async function saveSkillEditor() {
  // A draft saves to the draft, not to an installed skill.
  if (skillEditorDraft) {
    const d = skillEditorDraft;
    const body = d.mode === 'edit' ? $<HTMLInputElement>('#skill-editor-content')!.value : d.body;
    const save = ($('#skill-editor-save')!) as HTMLInputElement;
    save.disabled = true;
    try {
      await apiJson(`/api/skill-drafts/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { body } });
      d.body = body;
      showToast('Draft updated — Keep applies this version', { kind: 'success' });
      renderSkillDrafts();
      void renderRoomSkills();
    } catch (err: any) {
      showToast('Save failed: ' + ((err as any)?.message || err), { kind: 'error' });
    } finally {
      save.disabled = false;
    }
    return;
  }
  const name = $<HTMLInputElement>('#skill-editor-name')!.value.trim();
  const content = $<HTMLInputElement>('#skill-editor-content')!.value;
  if (!name) return showToast('Give the skill a name', { kind: 'error' });
  const save = ($('#skill-editor-save')!) as HTMLInputElement;
  save.disabled = true;
  try {
    const body = await apiJson(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: { content } });
    showToast(`Saved ${body.name} — applies on each agent's next spawn`, { kind: 'success' });
    showSkillEditor(false);
    await renderSkillsRegistry();
  } catch (err) {
    showToast('Save failed: ' + ((err as any)?.message || err), { kind: 'error' });
  } finally {
    save.disabled = false;
  }
}

let skillSourcesApp: ReturnType<typeof createApp> | null = null;

function mountSkillSources(): void {
  if (skillSourcesApp) return;
  const host = $('#skill-sources-list');
  if (!host) return;
  skillSourcesApp = createApp(SkillSources, {
    onEdit: (r: any) => {
      const s = r.raw;
      $<HTMLInputElement>('#skill-source-url')!.value =
        `https://github.com/${s.owner}/${s.repo}/tree/${s.branch}/${s.dir}`;
      const save = $('#skill-source-save')!;
      save.textContent = 'Save';
      save.dataset.editId = s.id;
    },
    onRemove: async (r: any) => {
      const ok = await deps.showConfirmModal({
        title: `Remove ${r.origin.label}?`,
        body: 'The collection disappears from the Skills catalog. Already-imported skills are unaffected.',
        confirmLabel: 'Remove',
        destructive: true,
      });
      if (!ok) return;
      try {
        await apiJson(`/api/skills/sources/${encodeURIComponent(r.raw.id)}`, { method: 'DELETE' });
        renderSkillSources();
      } catch (err) {
        showToast('Remove failed: ' + ((err as any)?.message || err), { kind: 'error' });
      }
    },
    onToggleBuiltin: (r: any) => toggleBuiltinSource(r.raw.id, r.disabled),
  });
  skillSourcesApp.mount(host);
}

/** The catalog's sources — rendered on the Skills TAB, beside what they feed. */
export async function renderSkillSources() {
  const section = $('#skill-sources');
  if (!section) return;
  section.hidden = !state.isOwnerView;
  if (!state.isOwnerView) return;
  let sources = [];
  let builtins = [];
  try {
    const res = await authFetch('/api/skills/sources');
    if (res.ok) {
      const b = await res.json();
      sources = b.sources || [];
      builtins = b.builtins || [];
    }
  } catch {}
  skillSources.value = [
    ...sources.map((s: any) => ({
      key: 'src:' + s.id,
      kind: 'source' as const,
      // Official collections drop the "(official)"/"(community)" suffix from
      // their label — the badge already carries that distinction visually.
      origin: s.official
        ? {
            label: s.label.replace(/\s*\((?:official|community)\)\s*$/i, ''),
            url: `https://github.com/${s.owner}/${s.repo}`,
            official: true,
          }
        : { label: `${s.owner}/${s.repo}`, url: `https://github.com/${s.owner}/${s.repo}`, official: false },
      meta: s.dir ? `${s.dir} · ${s.branch}` : `whole repo · ${s.branch}`,
      disabled: false,
      raw: s,
    })),
    // Built-in sources (the marketplace) — nothing to edit, but removable from
    // the pool (a reversible toggle, since there's no URL to re-paste).
    ...builtins.map((bi: any) => ({
      key: 'bi:' + bi.id,
      kind: 'builtin' as const,
      origin: { label: bi.label, url: bi.url, official: false },
      meta: bi.disabled
        ? 'Built-in marketplace — removed from the pool'
        : 'Built-in marketplace — pooled into Community',
      disabled: !!bi.disabled,
      raw: bi,
    })),
  ];
  mountSkillSources();
}

export function importSkill() {
  const input = ($('#skill-import-url')!) as HTMLInputElement;
  const url = (input.value || '').trim();
  if (!url) return;
  const label = url.replace(/^https?:\/\/github\.com\//, '').replace(/\/tree\/.*$/, '');
  input.value = '';
  deps.openWireToAgentsPicker({ url }, label || 'skill', { community: true });
}

async function deleteSkill(name?: any) {
  const ok = await deps.showConfirmModal({
    title: `Delete ${name}?`,
    body: 'Removes this imported skill. Agents that use it lose it on their next spawn.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  try {
    await apiJson(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast(`Deleted ${name}`, { kind: 'success' });
    await renderSkillsRegistry();
  } catch (err) {
    showToast('Delete failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

let agentSkillsApp: ReturnType<typeof createApp> | null = null;
let currentAgentSkillsId: any = null;

function mountAgentSkillsList(): void {
  if (agentSkillsApp) return;
  const host = $('#agent-skills-list');
  if (!host) return;
  agentSkillsApp = createApp(AgentSkillsList, {
    onView: (name: string) => openPoolSkillFromAgent(name),
    onDirty: () => {
      const saveBtn = $<HTMLInputElement>('#agent-skills-save');
      if (saveBtn) saveBtn.disabled = false;
    },
  });
  agentSkillsApp.mount(host);
}

export async function renderAgentSkills(agentId?: any): Promise<void> {
  currentAgentSkillsId = agentId;
  const saveBtn = $<HTMLInputElement>('#agent-skills-save');
  let data: any = { available: [], enabled: [] };
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/skills`);
    if (res.ok) data = await res.json();
  } catch (err) {
    console.error('Failed to load skills:', err);
  }
  const enabled = new Set<string>(data.enabled || []);
  const scoped = (data as any).scoped || [];
  const count = $('#agent-skills-count');
  if (count) count.textContent = enabled.size + scoped.length ? String(enabled.size + scoped.length) : '';
  if (saveBtn) saveBtn.disabled = true;
  renderAgentScopedSkills(agentId, scoped);
  agentSkillsEnabled.value = enabled;
  agentSkillRows.value = data.available || [];
  mountAgentSkillsList();
  if (saveBtn) saveBtn.onclick = () => saveAgentSkills(currentAgentSkillsId);
}


function renderAgentScopedSkills(agentId?: any, scoped?: any) {
  const list = $('#agent-scoped-list')!;
  const addBtn = $('#agent-scoped-add');
  const urlInput = $('#agent-scoped-url');
  if (!list) return;
  scopedSkillsAgentId = agentId;
  agentScopedSkills.value = scoped ?? [];
  mountAgentScopedSkills();
  if (addBtn) addBtn.onclick = () => importAgentScopedSkill(agentId, addBtn, urlInput);
}

let agentScopedApp: ReturnType<typeof createApp> | null = null;
/**
 * Whose scoped skills are mounted. Read by the callbacks rather than captured:
 * the app is created once and the agent panel is reopened for other agents.
 */
let scopedSkillsAgentId: any = null;

function mountAgentScopedSkills(): void {
  if (agentScopedApp) return;
  const host = $('#agent-scoped-list');
  if (!host) return;
  agentScopedApp = createApp(AgentScopedSkills, {
    // Click the info to view/edit this agent's own copy of the skill.
    onOpen: (name: string) => openScopedSkillEditor(scopedSkillsAgentId, name),
    onRemove: (name: string, el: HTMLElement) => removeAgentScopedSkill(scopedSkillsAgentId, name, el),
  });
  agentScopedApp.mount(host);
}

async function importAgentScopedSkill(agentId?: any, btn?: any, urlInput?: any) {
  const url = (urlInput?.value || '').trim();
  if (!url) return showToast('Paste a GitHub repo or folder URL', { kind: 'error' });
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const body = await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/import`, {
      method: 'POST',
      body: { url },
    });
    showToast(`Wired ${body.name} to this agent — applies on its next turn`, { kind: 'success' });
    if (urlInput) urlInput.value = '';
    renderAgentSkills(agentId);
  } catch (err) {
    showToast('Import failed: ' + ((err as any)?.message || err), { kind: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

async function removeAgentScopedSkill(agentId?: any, name?: any, btn?: any, onDone?: any) {
  if (!(await deps.showConfirmModal({ title: `Remove ${name}?`, body: 'Unwires it from this agent.', confirmLabel: 'Remove', destructive: true }))) return;
  btn.disabled = true;
  try {
    await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    showToast(`Removed ${name}`, { kind: 'success' });
    if (onDone) onDone();
    else renderAgentSkills(agentId);
  } catch (err) {
    showToast('Remove failed: ' + ((err as any)?.message || err), { kind: 'error' });
    btn.disabled = false;
  }
}

async function saveAgentSkills(agentId?: any) {
  const saveBtn = ($('#agent-skills-save')) as HTMLInputElement;
  const skills = [...document.querySelectorAll('#agent-skills-list .agent-skill-toggle')]
    .filter((t) => (t as HTMLInputElement).checked)
    .map((t) => (t as HTMLElement).dataset.skill);
  if (saveBtn) saveBtn.disabled = true;
  try {
    const body = await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
      method: 'PUT',
      body: { skills },
    });
    showToast(body.restarted ? 'Skills saved — agent restarting' : 'Skills saved (applies on next message)', {
      kind: 'success',
    });
    await renderAgentSkills(agentId);
  } catch (err) {
    showToast('Couldn’t save skills: ' + ((err as any)?.message || err), { kind: 'error' });
    if (saveBtn) saveBtn.disabled = false;
  }
}

let suggestTimer: any = null;

let suggestSeq = 0;

export function scheduleSkillSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(refreshSkillSuggestions, 700);
}

let suggestApp: ReturnType<typeof createApp> | null = null;

function mountSkillSuggestions(): void {
  if (suggestApp) return;
  const host = $('#agent-create-skills-list');
  if (!host) return;
  suggestApp = createApp(SkillSuggestions);
  suggestApp.mount(host);
}

async function refreshSkillSuggestions() {
  const text = [$<HTMLInputElement>('#agent-create-draft-prompt')!.value, $<HTMLInputElement>('#agent-create-name')!.value, $<HTMLInputElement>('#agent-create-instructions')!.value]
    .join(' ')
    .trim();
  const block = $('#agent-create-skills')!;
  if (text.length < 12) {
    block.hidden = true;
    return;
  }
  const seq = ++suggestSeq;
  let suggestions = [];
  try {
    const res = await authFetch(`/api/skills/suggest?text=${encodeURIComponent(text.slice(0, 2000))}`);
    if (res.ok) suggestions = (await res.json()).suggestions || [];
  } catch {}
  if (seq !== suggestSeq) return; // a newer request superseded this one
  if (!suggestions.length) {
    skillSuggestions.value = [];
    block.hidden = true;
    return;
  }
  skillSuggestions.value = suggestions;
  mountSkillSuggestions();
  block.hidden = false;
}

const DRAFTER_TARGETS = {
  'agent-create': {
    prompt: '#agent-create-draft-prompt',
    name: '#agent-create-name',
    instructions: '#agent-create-instructions',
  },
  'room-create': {
    prompt: '#room-create-draft-prompt',
    name: '#room-create-new-name',
    instructions: '#room-create-new-instructions',
  },
  'room-add-agent': {
    prompt: '#room-add-agent-draft-prompt',
    name: '#room-add-agent-new-name',
    instructions: '#room-add-agent-new-instructions',
  },
} as Record<string, any>;

export async function draftFor(btn?: any) {
  const targetKey = btn.dataset.drafterTarget;
  const target = DRAFTER_TARGETS[targetKey];
  if (!target) return;
  const promptEl = $(target.prompt);
  const nameEl = ($(target.name)) as HTMLInputElement;
  const instructionsEl = ($(target.instructions)) as HTMLInputElement;
  const prompt = ((promptEl as HTMLInputElement | null)?.value || '').trim();
  if (!prompt) {
    showToast('Type a description first, e.g. "An agent that helps me draft replies to emails".', { kind: 'error' });
    return;
  }
  const original = btn.innerHTML;
  btn.disabled = true;
  // The wait shows the one spinner primitive (DESIGN.md §5), not a static
  // sparkles icon which reads as frozen. innerHTML save/restore (not
  // wizardBusy's textContent) because this button carries an SVG icon.
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Drafting…';
  try {
    const res = await authFetch('/api/agents/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast('Drafter failed: ' + (body.error || res.statusText), { kind: 'error' });
      return;
    }
    if (nameEl) nameEl.value = body.name || '';
    if (instructionsEl) instructionsEl.value = body.instructions || '';
    nameEl?.focus();
    nameEl?.select();
  } catch (err) {
    showToast('Drafter failed: ' + (err as any)?.message, { kind: 'error' });
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

let roomSkillsApp: ReturnType<typeof createApp> | null = null;

function mountRoomSkills(): void {
  if (roomSkillsApp) return;
  const host = $('#room-skills-list');
  if (!host) return;
  roomSkillsApp = createApp(RoomSkills, {
    undoSeconds: UNDO_SECONDS,
    onView: (id: string) => openSkillDraft(id),
    onKeep: (r: any) =>
      armRoomSkillUndo(r.id, `Keeping ${r.skillName}…`, async () => {
        await keepSkillDraft({ id: r.id, agentGroupId: r.agentGroupId, agentName: r.agentName }, null);
        void renderRoomSkills();
      }),
    onDiscard: (r: any) =>
      armRoomSkillUndo(r.id, `Discarding ${r.skillName}…`, async () => {
        await discardSkillDraft(r.id);
        void renderRoomSkills();
      }),
    onUndo: (id: string) => clearRoomSkillUndo(id),
    onRevert: async (r: any) => {
      const ok = await deps.showConfirmModal({
        title: `Revert ${r.name}?`,
        body: 'Back to the previous revision. The current version stays in history — a revert can itself be reverted.',
        confirmLabel: 'Revert',
      });
      if (!ok) return;
      try {
        const res = await authFetch(
          `/api/agents/${encodeURIComponent(r.agentId)}/skills/scoped/${encodeURIComponent(r.name)}/revert`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
        showToast(`Reverted ${r.name}`);
        void renderRoomSkills();
      } catch (err) {
        toastError(err, 'Could not revert');
      }
    },
    onRemove: async (r: any) => {
      // DESIGN.md §5: no native confirm() — destructive actions use the modal.
      const ok = await deps.showConfirmModal({
        title: `Remove ${r.name}?`,
        body: `It will no longer be available to ${r.agentLabel}.`,
        confirmLabel: 'Remove',
        destructive: true,
      });
      if (!ok) return;
      try {
        const res = await authFetch(
          `/api/agents/${encodeURIComponent(r.agentId)}/skills/scoped/${encodeURIComponent(r.name)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
        showToast(`Removed ${r.name}`);
        void renderRoomSkills();
      } catch (err) {
        toastError(err, 'Failed to remove skill');
      }
    },
    onRestore: async (r: any) => {
      try {
        const res = await authFetch(
          `/api/agents/${encodeURIComponent(r.agentId)}/skills/archived/${encodeURIComponent(r.name)}/restore`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
        showToast(`Restored ${r.name}`);
        void renderRoomSkills();
      } catch (err) {
        toastError(err, 'Could not restore');
      }
    },
  });
  roomSkillsApp.mount(host);
}

function armRoomSkillUndo(id: string, label: string, commit: () => unknown) {
  // Measured BEFORE the swap, like armUndo did — after would read the timer.
  const el = document.querySelector(`#room-skills-list li[data-draft-id="${CSS.escape(id)}"] .room-skill-actions`)
    ?? document.querySelector(`#room-skills-list .room-skill-actions`);
  const w = el ? (el as HTMLElement).getBoundingClientRect().width : 0;
  roomSkillUndo.value = {
    ...roomSkillUndo.value,
    [id]: { label, width: w ? `${w}px` : '', commit: () => { clearRoomSkillUndo(id); void commit(); } },
  };
}

function clearRoomSkillUndo(id: string) {
  const next = { ...roomSkillUndo.value };
  delete next[id];
  roomSkillUndo.value = next;
}

export async function renderRoomSkills() {
  const section = $('#room-skills-section');
  if (!section || !$('#room-skills-list')) return;
  const count = $('#room-skills-count')!;
  const agents = roomDetailWiredAgents.value.slice();
  if (agents.length === 0) {
    section.hidden = true;
    return;
  }
  const ids = new Set(agents.map((a: any) => a.id));
  const nameOf = (id?: any) => agents.find((a: any) => a.id === id)?.name || 'agent';

  let drafts = [];
  let learned: any[] = [];
  let archived: any[] = [];
  try {
    const [draftRes, ...skillRes] = await Promise.all([
      authFetch('/api/skill-drafts'),
      ...agents.map((a: any) => authFetch(`/api/agents/${encodeURIComponent(a.id)}/skills`)),
    ]);
    drafts = ((await draftRes.json()).drafts || []).filter((d: any) => ids.has(d.agentGroupId));
    const perAgent = await Promise.all(skillRes.map((r) => r.json().catch(() => ({}))));
    perAgent.forEach((payload, i) => {
      for (const s of payload.scoped || []) learned.push({ ...s, agentId: agents[i].id });
      for (const s of payload.archived || []) archived.push({ ...s, agentId: agents[i].id });
    });
  } catch (err) {
    console.error('Failed to load room skills:', err);
    section.hidden = true;
    return;
  }

  // The section stays even when empty — it carries the "Distill a skill" trigger,
  // and a room that has learned nothing yet is exactly where you'd want to press it.
  section.hidden = false;
  count.textContent = drafts.length + learned.length ? String(drafts.length + learned.length) : '';
  renderDistillButton(agents);
  roomSkillsReviewing.value = new Set(
    [...reviewingDrafts].filter((id): id is string => drafts.some((d: any) => d.id === id)),
  );
  // Proposals first — they're the ones asking for a decision. Then what's wired.
  // Then the curator's archive: dim, restorable, never deleted.
  roomSkillRows.value = [
    ...drafts.map((d: any) => ({
      kind: 'proposed',
      key: 'd:' + d.id,
      id: d.id,
      skillName: d.skillName,
      agentGroupId: d.agentGroupId,
      agentName: d.agentName,
      name: d.kind === 'patch' ? `Change to ${d.targetSkill || d.skillName}` : d.skillName,
      origin: { label: `proposed · ${d.agentName || nameOf(d.agentGroupId)}`, official: false },
      desc: d.description || '',
      keepTitle: `Wire to ${d.agentName || nameOf(d.agentGroupId)}`,
    })),
    ...learned.map((s: any) => ({
      kind: 'learned',
      key: 'l:' + s.agentId + ':' + s.name,
      name: s.name ?? '',
      origin: s.origin || null,
      // The agent's name only when the room has more than one — with a single
      // agent it is noise on every row.
      who: agents.length > 1 ? nameOf(s.agentId) : '',
      uses: s.invocations > 0 ? `used ${s.invocations}×` : '',
      hasHistory: !!s.hasHistory,
      agentId: s.agentId,
      agentLabel: nameOf(s.agentId),
      removeTitle: `Remove from ${nameOf(s.agentId)}`,
    })),
    ...archived.map((s: any) => ({
      kind: 'archived',
      key: 'a:' + s.agentId + ':' + s.name,
      name: s.name ?? '',
      agentId: s.agentId,
    })),
  ];
  mountRoomSkills();
}

function renderDistillButton(agents?: any) {
  const host = $('#room-skills-section .form-label-row');
  const existing = $('#room-distill-btn');
  if (existing) existing.remove();
  if (!host || !agents.length || selectedRoomId.value !== state.currentRoom) return;
  const btn = document.createElement('button');
  btn.id = 'room-distill-btn';
  btn.type = 'button';
  btn.className = 'btn btn-secondary';
  btn.textContent = 'Distill a skill…';
  btn.title = 'Review this session and draft a skill if it taught something worth keeping';
  btn.addEventListener('click', () => {
    deps.closeRoomDetail(); // get out of the way — the answer arrives in the room
    deps.triggerLearn();
  });
  host.appendChild(btn);
}


// ── Panel wiring ─────────────────────────────────────────────────────────────
// The listener registrations that used to sit at legacy.js module scope. They
// are a FUNCTION, not module-scope code here, on purpose: legacy.js runs its
// blocks in source order around initApp(), so moving this to another module's
// top level would silently re-order it against everything else. legacy calls
// wireSkillsPanel() at the exact line the first block occupied, which keeps the
// order identical and makes the change reviewable as a move.
//
// When the skills panel becomes a Vue island this function is what disappears:
// the listeners become template bindings and the timers become refs.

let poolSearchTimer: ReturnType<typeof setTimeout> | undefined;
let skillsFilterTimer: ReturnType<typeof setTimeout> | undefined;

export function wireSkillsPanel(): void {
  $<HTMLButtonElement>('#skill-editor-mode')?.addEventListener('click', () => {
    const d = getSkillEditorDraft();
    if (!d) return;
    if (d.mode === 'edit') {
      // Leaving edit mode: carry the edits into the diff, don't lose them.
      const ta = $<HTMLTextAreaElement>('#skill-editor-content');
      if (ta) d.body = ta.value;
      d.mode = 'diff';
    } else {
      d.mode = 'edit';
    }
    renderDraftEditor();
  });
  $<HTMLButtonElement>('#skill-add-btn')?.addEventListener('click', openSkillsAdd);
  $<HTMLInputElement>('#skill-discover-search')?.addEventListener('input', () => {
    clearTimeout(poolSearchTimer);
    poolSearchTimer = setTimeout(() => renderSkillPool(), 400);
  });
  $<HTMLButtonElement>('#skills-add-back')?.addEventListener('click', () => renderSkillsRegistry()); // re-render → lands on browse with fresh list
  $<HTMLInputElement>('#skills-filter')?.addEventListener('input', () => {
    clearTimeout(skillsFilterTimer);
    skillsFilterTimer = setTimeout(applySkillsSections, 100);
  });
  $<HTMLButtonElement>('#skills-trust-official')?.addEventListener('click', () => setSkillTrust('official'));
  $<HTMLButtonElement>('#skills-trust-community')?.addEventListener('click', () => setSkillTrust('community'));
  $<HTMLButtonElement>('#skills-learn-link')?.addEventListener('click', async () => {
    const v = await promptLearnSource({
      title: 'Learn from a link',
      placeholder: 'https://…',
      check: isLearnUrlToken,
      invalid: 'Start with a full link (http:// or https://)',
    });
    if (!v) return;
    const room = await pickLearnTarget();
    if (!room) return;
    closeView('manage'); // unwind the Skills view's history entry before the room takes over
    joinRoom(room.id, room.name);
    // Sent by the 'history' handler once the room's transcript is in — sending
    // now would lose the optimistic bubble to the history render.
    state.pendingSendAfterJoin = '/learn ' + v;
  });
  const sourceSaveBtn = $<HTMLButtonElement>('#skill-source-save');
  const sourceUrlInput = $<HTMLInputElement>('#skill-source-url');
  sourceSaveBtn?.addEventListener('click', async () => {
    const save = sourceSaveBtn;
    const url = sourceUrlInput?.value.trim() ?? '';
    if (!url) return showToast('Paste a GitHub repo or folder URL', { kind: 'error' });
    // No label to type — a new collection's id is derived from what it pulls in
    // (owner-repo[-dir]); the server names it owner/repo. Editing keeps the id.
    const folder = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
    const root = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    const slug = folder ? `${folder[1]}-${folder[2]}-${folder[4]}` : root ? `${root[1]}-${root[2]}` : '';
    const derivedId = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    const id = save.dataset.editId || derivedId;
    if (!id) return showToast('Expected a GitHub repo or folder URL', { kind: 'error' });
    save.disabled = true;
    try {
      const body = await apiJson(`/api/skills/sources/${encodeURIComponent(id)}`, { method: 'PUT', body: { url } });
      showToast(`Added ${body.source?.label || 'collection'}`, { kind: 'success' });
      if (sourceUrlInput) sourceUrlInput.value = '';
      save.textContent = 'Add';
      delete save.dataset.editId;
      renderSkillSources(); // the pool refetches on next open, picking up the new collection
    } catch (err: any) {
      showToast('Save failed: ' + (err?.message || err), { kind: 'error' });
    } finally {
      save.disabled = false;
    }
  });
  $<HTMLButtonElement>('#skill-new-btn')?.addEventListener('click', () => openSkillEditor(null));
  $<HTMLButtonElement>('#skill-editor-cancel')?.addEventListener('click', () => showSkillEditor(false));
  $<HTMLButtonElement>('#skill-editor-save')?.addEventListener('click', saveSkillEditor);
  $<HTMLButtonElement>('#skill-import-btn')?.addEventListener('click', importSkill);
  $<HTMLInputElement>('#skill-import-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      importSkill();
    }
  });
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// The skills registry list and its filter controls.
//
// One function per GROUP of blocks, each called from the line its group
// started on. Blocks with an executing statement between them cannot share a
// function: a single call at the first block moves the later ones ahead of
// whatever ran in between, which the boot-order trace catches.

export function wireSkillsRegistry(): void {
  $<HTMLFormElement>('#agent-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = ($<HTMLInputElement>('#agent-create-name')?.value ?? '').trim();
    if (!name) return;
    const instructions = ($<HTMLTextAreaElement>('#agent-create-instructions')?.value ?? '');

    // A template stamps the whole agent — persona, skills, MCP servers, paused
    // tasks — so it takes a different endpoint and ignores Instructions (whose
    // field is hidden while a template is picked). Suggested-skill imports
    // below are skipped too: the template owns the agent's skill set.
    const templateRef = selectedTemplateRef();
    if (templateRef) {
      try {
        const { error, report } = await stampTemplate(templateRef, name);
        if (error) {
          showToast('Failed to stamp template: ' + error, { kind: 'error' });
          return;
        }
        // Nothing is silently stripped: a skipped skill or unsupported
        // transport is named, and the agent still exists without it.
        for (const line of report) showToast(line, { kind: 'info' });
        showToast(`Created ${name} from ${templateRef}`, { kind: 'success' });
        resetTemplatePick();
        await fetchAgents();
        closeAgentDetail();
      } catch (err: any) {
        showToast('Failed to stamp template: ' + (err?.message || err), { kind: 'error' });
      }
      return;
    }

    try {
      const res = await authFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, instructions: instructions || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast('Failed to create agent: ' + (err.error || res.statusText), { kind: 'error' });
        return;
      }
      // Import any checked suggested skills — new agents default to "all skills",
      // so imports attach automatically on the agent's first spawn.
      const checked = [...document.querySelectorAll<HTMLElement>('#agent-create-skills-list .agent-create-skill-check:checked')];
      if (checked.length) showToast(`Adding ${checked.length} suggested skill(s)…`, { kind: 'info' });
      for (const c of checked) {
        try {
          await apiJson('/api/skills/import', { method: 'POST', body: { url: c.dataset.url } });
          showToast(`Added skill ${c.dataset.name}`, { kind: 'success' });
        } catch (err: any) {
          showToast(`Skill ${c.dataset.name} failed: ` + (err?.message || err), { kind: 'error' });
        }
      }
      const skillsWrap = $('#agent-create-skills');
      const skillsList = $('#agent-create-skills-list');
      if (skillsWrap) skillsWrap.hidden = true;
      if (skillsList) skillsList.innerHTML = '';
      await fetchAgents();
      closeAgentDetail();
    } catch (err: any) {
      showToast('Failed to create agent: ' + err.message, { kind: 'error' });
    }
  });
}

// Overlap review outcome: the server found existing skills/drafts that cover
// the same ground. Offer to update one of them (apply this draft over it),
// keep this as a new skill anyway, or discard the draft. Only 'scoped'/'pool'
// skills are updatable — a 'pending-draft' overlap is another draft, not a
// skill to patch. A global modal, so it reaches the user even if they
// navigated away while the review ran.
export async function showOverlapChoice(d: any, overlaps: any) {
  const el = document.createElement('div');
  for (const o of overlaps) {
    const row = document.createElement('div');
    row.className = 'import-warning';
    row.textContent = `⚠ ${o.name} (${o.source === 'pending-draft' ? 'pending draft' : o.source}) — ${o.reason}`;
    el.appendChild(row);
  }
  const updatable = overlaps.filter((o: any) => o.source !== 'pending-draft');
  // Adaptive primary: a single existing skill → "Update <name>" is the
  // recommended action; otherwise the primary stays "Keep as new".
  let confirmLabel;
  let confirmDecision;
  const extras = [];
  if (updatable.length === 1) {
    confirmLabel = `Update ${updatable[0].name}`;
    confirmDecision = { action: 'update', target: updatable[0].name };
    extras.push({ label: 'Keep as new', value: { action: 'keep-new' }, className: 'btn btn-secondary' });
  } else {
    confirmLabel = 'Keep as new';
    confirmDecision = { action: 'keep-new' };
    for (const o of updatable.slice(0, 3))
      extras.push({ label: `Update ${o.name}`, value: { action: 'update', target: o.name }, className: 'btn btn-secondary' });
  }
  extras.push({ label: 'Discard draft', value: { action: 'discard' }, className: 'btn btn-danger' });
  const choice = (await showConfirmModal({
    title: `Overlaps with ${overlaps.length === 1 ? overlaps[0].name : overlaps.length + ' existing skills'}`,
    body: el,
    confirmLabel,
    extraActions: extras,
  })) as any;
  const decision = choice === true ? confirmDecision : choice || { action: 'cancel' };
  // force / updateTarget skip the server-side review, so these re-drives
  // resolve synchronously through the same keepSkillDraft.
  if (decision.action === 'update') return keepSkillDraft(d, draftKeepButton(d.id), false, decision.target);
  if (decision.action === 'keep-new') return keepSkillDraft(d, draftKeepButton(d.id), true);
  if (decision.action === 'discard') {
    await discardSkillDraft(d.id);
    showToast(`Discarded ${d.skillName || 'draft'}`, { kind: 'success' });
  }
}

export function lineDiff(oldText: any, newText: any) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push('  ' + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push('- ' + a[i++]);
    } else {
      out.push('+ ' + b[j++]);
    }
  }
  while (i < m) out.push('- ' + a[i++]);
  while (j < n) out.push('+ ' + b[j++]);
  return out.join('\n');
}

// Enable/disable a built-in source (the marketplace). DELETE switches it off,
// PUT switches it back on — reversible, so no destructive confirm.
export async function toggleBuiltinSource(id: string, wasDisabled: any) {
  try {
    const res = await authFetch(`/api/skills/sources/${encodeURIComponent(id)}`, {
      method: wasDisabled ? 'PUT' : 'DELETE',
      ...(wasDisabled ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    showToast(wasDisabled ? 'Marketplace added back to the pool' : 'Marketplace removed from the pool', { kind: 'success' });
    renderSkillSources();
  } catch (err) {
    showToast('Failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}
