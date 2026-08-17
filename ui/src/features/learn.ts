// ── Learn ────────────────────────────────────────────────────────────────────
// The /learn flow: the nudge, the source picker, the URL and folder modals, and
// the turn-tool bookkeeping that decides when to offer it.
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { showConfirmModal, showInputModal } from './modals.js';
import { putRoomLearning } from './rooms.js';
import { createApp, reactive } from 'vue';
import LearnMenu from './LearnMenu.vue';
import LearnTargetPicker from './LearnTargetPicker.vue';
import { learnAutoKeep, learnAutoTrigger, learnTogglesVisible } from './learn-menu-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideLearnDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface LearnDeps {
  sendCurrentMessage: () => any;
}

const deps = {} as LearnDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideLearnDeps(provided: Partial<LearnDeps>): void {
  Object.assign(deps, provided);
}

export function applyLearningMaster() {
  const learnBtn = document.getElementById('learn-btn');
  if (learnBtn) learnBtn.hidden = !state.learningMasterEnabled;
  if (!state.learningMasterEnabled) hideLearnNudge();
}

export async function loadLearningMaster() {
  try {
    const r = await authFetch('/api/learning/config');
    if (r.ok) {
      const cfg = await r.json();
      state.learningMasterEnabled = cfg.enabled !== false;
    }
  } catch {
    /* keep default (on) */
  }
  applyLearningMaster();
}

let autoLearnWired = false;

export async function renderAutoLearnSetting() {
  const section = document.getElementById('settings-autolearn');
  if (!section) return;
  let cfg: any = null;
  try {
    const r = await authFetch('/api/learning/config');
    if (r.ok) cfg = await r.json();
  } catch {
    cfg = null;
  }
  if (!cfg || !cfg.canEdit) {
    section.hidden = true; // non-owner: no master control surface
    return;
  }
  section.hidden = false;
  state.learningMasterEnabled = cfg.enabled !== false;
  document.querySelectorAll('#autolearn-mode .setting-option').forEach((b: any) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.value === (state.learningMasterEnabled ? 'on' : 'off'));
  });
  // Classifier picker — only meaningful while learning is on.
  const clfGroup = document.getElementById('autolearn-classifier-group');
  const clfSelect = document.getElementById('autolearn-classifier-select') as HTMLSelectElement | null;
  if (clfGroup) clfGroup.hidden = !state.learningMasterEnabled;
  if (state.learningMasterEnabled && clfSelect && clfSelect.options.length <= 1) {
    try {
      const models = await (await authFetch('/api/models')).json();
      clfSelect.innerHTML = '<option value="">None — busy-turn heuristic</option>';
      for (const m of models) {
        if ((m.kind !== 'ollama' && m.kind !== 'openai-compatible') || !m.endpoint) continue;
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.model_id})`;
        clfSelect.appendChild(opt);
      }
    } catch {
      /* leave the None option */
    }
  }
  if (clfSelect) clfSelect.value = cfg.classifierModelId || '';
  if (autoLearnWired) return;
  autoLearnWired = true;
  document.querySelectorAll('#autolearn-mode .setting-option').forEach((b: any) => {
    b.addEventListener('click', async () => {
      const on = (b as HTMLElement).dataset.value === 'on';
      const r = await authFetch('/api/learning/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
        return;
      }
      state.learningMasterEnabled = on;
      document.querySelectorAll('#autolearn-mode .setting-option')
        .forEach((x: any) => x.classList.toggle('active', x === b));
      applyLearningMaster();
      if (clfGroup) clfGroup.hidden = !on;
      showToast(on
        ? 'Auto-learn on — takes effect as each agent restarts'
        : 'Auto-learn off for the whole workspace — takes effect as each agent restarts');
    });
  });
  clfSelect?.addEventListener('change', async () => {
    const value = clfSelect.value || null;
    const r = await authFetch('/api/learning/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classifierModelId: value }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
      renderAutoLearnSetting();
      return;
    }
    showToast(value
      ? 'Classifier set — decides skill-worthy turns (applies as agents restart)'
      : 'Classifier off — back to the busy-turn heuristic', { kind: 'success' });
  });
}

export async function pickLearnTarget() {
  let agents: any[] = [];
  try {
    agents = await apiJson('/api/agents');
  } catch (err) {
    toastError(err, 'Could not load agents');
    return null;
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    showToast('No agents you administer', { kind: 'error' });
    return null;
  }
  // Rooms per agent (webchat only). /api/agents already returns only the
  // agents the caller administers, so these reads succeed for every entry.
  const roomsByAgent = new Map();
  await Promise.all(
    agents.map(async (a) => {
      try {
        const r = await authFetch(`/api/agents/${encodeURIComponent(a.id)}/rooms`);
        roomsByAgent.set(a.id, r.ok ? await r.json() : []);
      } catch {
        roomsByAgent.set(a.id, []);
      }
    }),
  );
  const firstWithRoom = agents.find((a: any) => (roomsByAgent.get(a.id) || []).length > 0);
  if (!firstWithRoom) {
    showToast('No agent has a room — wire one to a room first', { kind: 'error' });
    return null;
  }
  const body = document.createElement('div');
  body.className = 'learn-target-picker';
  const s = reactive({
    agents,
    roomsByAgent,
    initialAgent: firstWithRoom.id,
    agentEl: null as HTMLSelectElement | null,
    roomEl: null as HTMLSelectElement | null,
  });
  const app = createApp(LearnTargetPicker);
  app.provide('learnTarget', s);
  app.mount(body);
  const ok = await showConfirmModal({ title: 'Learn with which agent?', body, confirmLabel: 'Learn' });
  // Read both selects BEFORE unmounting — the nodes go with the app.
  const picked = s.agentEl?.value ?? firstWithRoom.id;
  const roomValue = s.roomEl?.value;
  app.unmount();
  if (!ok) return null;
  const rooms = roomsByAgent.get(picked) || [];
  const room = rooms.length > 1 ? rooms.find((r: any) => r.id === roomValue) : rooms[0];
  return room || null;
}

export function triggerLearn(command = '/learn') {
  const input = ($('#message-input')) as HTMLInputElement;
  if (!input || (input as HTMLInputElement).disabled || !state.currentRoom) return;
  hideLearnNudge();
  input.value = command;
  deps.sendCurrentMessage();
}

function learnSourceFirstToken(value?: any) {
  return value.trim().split(/\s+/)[0] || '';
}

export function isLearnUrlToken(tok?: any) {
  if (!/^https?:\/\/\S+$/i.test(tok)) return false;
  try {
    new URL(tok);
    return true;
  } catch {
    return false;
  }
}

function isLearnPathToken(tok?: any) {
  return tok === '~' || tok === '.' || tok === '..' || /^(\/|\.\/|\.\.\/|~\/)/.test(tok);
}

export async function promptLearnSource({ title, placeholder, check, invalid }: any) {
  const v = await showInputModal({
    title,
    placeholder,
    confirmLabel: 'Learn',
    validate: (val: any) => (val && check(learnSourceFirstToken(val)) ? null : invalid),
  });
  return v; // trimmed source (+ optional focus), or null on cancel
}

export function showLearnNudge() {
  if (!state.learningMasterEnabled) return;
  const n = $('#learn-nudge');
  if (n) n.hidden = false;
}

export function hideLearnNudge() {
  const n = $('#learn-nudge');
  if (n) n.hidden = true;
}

let learnMenuApp: ReturnType<typeof createApp> | null = null;

function mountLearnMenu(): void {
  if (learnMenuApp) return;
  const host = $('#learn-menu');
  if (!host) return;
  learnMenuApp = createApp(LearnMenu, {
    onSession: () => {
      closeLearnMenu();
      triggerLearn();
    },
    // Source-directed learning: one input (source first, optional focus text
    // after), composed into `/learn <value>` — the same message the user could
    // type; the container-side classifier does the rest.
    onLink: async () => {
      closeLearnMenu();
      const v = await promptLearnSource({
        title: 'Learn from a link',
        placeholder: 'https://…',
        check: isLearnUrlToken,
        invalid: 'Start with a full link (http:// or https://)',
      });
      if (v) triggerLearn('/learn ' + v);
    },
    onFolder: async () => {
      closeLearnMenu();
      const v = await promptLearnSource({
        title: 'Learn from a folder',
        placeholder: '/workspace/…',
        check: isLearnPathToken,
        invalid: 'Start with a path (/, ./ or ~/)',
      });
      if (v) triggerLearn('/learn ' + v);
    },
    // Optimistic ONLY on success — the row flips after the write returns true,
    // exactly as the imperative handler did.
    onAutoTrigger: async (on: boolean) => {
      if (await putRoomLearning({ autoTrigger: on })) learnAutoTrigger.value = on;
    },
    onAutoKeep: async (on: boolean) => {
      if (await putRoomLearning({ autoKeep: on })) learnAutoKeep.value = on;
    },
  });
  learnMenuApp.mount(host);
}

export async function toggleLearnMenu() {
  const menu = $('#learn-menu');
  if (!menu) return;
  if (!menu.hidden) {
    closeLearnMenu();
    return;
  }
  if (!state.currentRoom) return;

  // ONE pair of toggles, scoped to THIS room — the room layer overrides the
  // wired agents' defaults, so many agents never means many switches.
  let cfg: any = null;
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/learning`);
    if (res.ok) cfg = await res.json();
  } catch {
    /* room without learning surface (no wired agents) — trigger row only */
  }
  learnTogglesVisible.value = !!(cfg && cfg.canManage && state.learningMasterEnabled);
  learnAutoTrigger.value = !!cfg?.autoTrigger;
  learnAutoKeep.value = !!cfg?.autoKeep;
  mountLearnMenu();
  menu.hidden = false;
  $('#learn-btn')?.setAttribute('aria-expanded', 'true');
}

export function closeLearnMenu() {
  const menu = $('#learn-menu');
  if (menu) menu.hidden = true;
  $('#learn-btn')?.setAttribute('aria-expanded', 'false');
}



// ── Panel wiring ─────────────────────────────────────────────────────────────
// The learn surface: source prompts and the digest controls.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireLearnPanel() at the exact line the
// first block occupied, so execution order is unchanged.

export function wireLearnPanel(): void {
  (() => {
    const more = document.getElementById('composer-more');
    const tools = document.getElementById('composer-tools');
    if (!more || !tools) return;
    const close = () => {
      tools.classList.remove('open');
      more.setAttribute('aria-expanded', 'false');
    };
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !tools.classList.contains('open');
      tools.classList.toggle('open', open);
      more.setAttribute('aria-expanded', String(open));
    });
    // Selecting any tool inside closes the popover (the dialog/menu takes over).
    tools.addEventListener('click', (e) => {
      if ((e.target as Element | null)?.closest('button')) close();
    });
    document.addEventListener('click', (e) => {
      if (tools.classList.contains('open') && !tools.contains(e.target as Node | null) && (e.target as Element | null)?.closest('#composer-more') === null) {
        close();
      }
    });
  })();
  document.addEventListener('click', (e) => {
    const menu = $('#learn-menu');
    if (menu && !menu.hidden && !menu.contains(e.target as Node | null) && (e.target as Element | null)?.closest('#learn-btn') === null) {
      closeLearnMenu();
    }
  });
  // Escape closes the 🎓 popover (bubble phase — the capture-phase view handler
  // yields via blockingOverlayOpen while the menu is open).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !($('#learn-menu')?.hidden ?? true)) closeLearnMenu();
  });
  $<HTMLButtonElement>('#learn-nudge-go')?.addEventListener('click', () => triggerLearn());
  $<HTMLButtonElement>('#learn-nudge-dismiss')?.addEventListener('click', hideLearnNudge);

}
