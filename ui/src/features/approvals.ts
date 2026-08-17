// ── Approvals ────────────────────────────────────────────────────────────────
// The approval cards an agent raises mid-turn ("may I run this?"), their list
// view, the resolve round-trip, and the live events that mutate both. Chosen as
// the next extraction by measurement, not feel: 196 lines with 3 external
// references, the loosest-coupled cluster left in legacy.js.
//
// No injection: after core/state this module reaches back into legacy for
// nothing at all. It is the first extracted feature with no legacy edge.
import { $, lucide, lucideEl, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { createApp } from 'vue';
import ApprovalsList from './ApprovalsList.vue';
import ApprovalCard from './ApprovalCard.vue';
import ApprovalToast from './ApprovalToast.vue';
import { approvalBusy, approvalErrors, approvalRows } from './approvals-state.js';

// Owned here: legacy never touches it. Injecting state one module writes and
// nobody else reads would be pure ceremony.
// Pending approvals (install_packages, add_mcp_server, etc.) surface as an
// inline banner above the active sidebar tab — only when count > 0, so
// users with no pending items see nothing. The banner expands to reveal
// the cards in place; click Approve/Reject directly without leaving the
// current tab. Live arrival also fires a top-right toast.
/**
 * An approval an agent raised mid-turn. The field list comes from the comment
 * that sat on the old `let pendingApprovals = []` plus every property this
 * module actually reads — not from guesswork.
 */
/** One button on an approval card. `label` falls back to `value` when absent. */
export interface ApprovalOption {
  label?: string;
  value: string;
}

export interface Approval {
  questionId: string;
  action?: string;
  title?: string;
  question?: string;
  options?: ApprovalOption[];
  payload?: unknown;
  created_at?: number;
  /** set once resolved, so a late card can render its outcome */
  resolvedBy?: string;
  approvers?: string[];
}

/** The subset of a server message this module inspects. */
export interface ApprovalMessage {
  id?: string;
  approvalId?: string;
  message_type?: string;
  content?: string;
  title?: string;
  question?: string;
  resolvedBy?: string;
}

let pendingApprovals: Approval[] = [];

export function appendApprovalCard(msg: ApprovalMessage, beforeNode?: Node | null) {
  let data: Partial<Approval> = {};
  try {
    data = JSON.parse(msg.content ?? '{}') || {};
  } catch {
    data = {};
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg approval-msg';
  wrap.dataset.questionId = data.questionId || msg.id || '';
  const resolved = msg.message_type === 'approval_resolved' || !!data.resolvedBy;
  const eligible = Array.isArray(data.approvers) && data.approvers.includes(state.myIdentity);
  if (resolved) {
    const who = data.resolvedBy ? ' by ' + (String(data.resolvedBy).split(':').pop() ?? '').split('@')[0] : '';
    const note = document.createElement('div');
    note.className = 'approval-inroom-note resolved';
    note.textContent = `🔒 ${data.title || 'Approval'} — resolved${who}`;
    wrap.appendChild(note);
  } else if (eligible) {
    // Per-message island. This card is INTERACTIVE — its buttons disable while
    // the response is in flight and it grows an inline error when one fails —
    // which is what distinguishes it from the static builders (renderFileBubble,
    // buildThoughtsDisclosure) that stay imperative on purpose.
    const app = createApp(ApprovalCard, {
      approval: {
        questionId: data.questionId || msg.id || '',
        title: data.title,
        payload: data.question,
        options: data.options,
      },
      onRespond: (questionId: string, value: string) => respondToApproval(questionId, value, null),
    });
    app.mount(wrap);
  } else {
    const note = document.createElement('div');
    note.className = 'approval-inroom-note';
    note.textContent = `🔒 ${data.title || 'Approval requested'} — awaiting an admin`;
    wrap.appendChild(note);
  }
  const tb = $('#messages .thinking-bubble');
  const msgs = $('#messages');
  if (!msgs) return;
  if (beforeNode) msgs.insertBefore(wrap, beforeNode);
  else if (tb) msgs.insertBefore(wrap, tb);
  else msgs.appendChild(wrap);
}

function setApprovalsBanner(count: number): void {
  const banner = $<HTMLElement>('#approvals-banner');
  // Defensive: if the cached HTML doesn't include the banner element yet,
  // bail silently. Avoids a throw that would break unrelated WS handling.
  if (!banner) return;
  const countEl = $('#approvals-count');
  const textEl = banner.querySelector('.approvals-banner-text');
  if (!countEl || !textEl) return;
  if (count <= 0) {
    banner.hidden = true;
    banner.classList.remove('expanded');
    const list = $<HTMLElement>('#approval-list');
    if (list) list.hidden = true;
    $('#approvals-banner-toggle')?.setAttribute('aria-expanded', 'false');
    return;
  }
  banner.hidden = false;
  countEl.textContent = String(count);
  // Pluralize the trailing word: "1 approval pending" / "2 approvals pending".
  // The number itself stays inside #approvals-count; we just rewrite the
  // sibling text node around it.
  const noun = count === 1 ? 'approval' : 'approvals';
  // Reset textEl content but keep the count span: rebuild it.
  textEl.innerHTML = '';
  textEl.appendChild(countEl);
  textEl.appendChild(document.createTextNode(` ${noun} pending`));
}

let approvalsApp: ReturnType<typeof createApp> | null = null;

function mountApprovalsList(): void {
  if (approvalsApp) return;
  const host = $('#approval-list');
  if (!host) return;
  approvalsApp = createApp(ApprovalsList, {
    onRespond: (questionId: string, value: string) => respondToApproval(questionId, value, null),
  });
  approvalsApp.mount(host);
}

function renderApprovalsList(): void {
  if ($('#approval-list')) {
    approvalRows.value = [...pendingApprovals];
    mountApprovalsList();
  }
  setApprovalsBanner(pendingApprovals.length);
}

export async function fetchApprovals(): Promise<void> {
  try {
    const r = await authFetch('/api/approvals/pending');
    if (!r.ok) return;
    pendingApprovals = await r.json();
    renderApprovalsList();
  } catch (err: any) {
    console.error('fetchApprovals failed:', err);
  }
}

function showApprovalToast(a: Approval): void {
  const container = $('#approval-toasts');
  if (!container) return;
  // The toast element is the mount HOST: it keeps the class and question id the
  // toast layer and respondToApproval select on, and ApprovalToast supplies its
  // children. One app per toast, unmounted when the toast goes.
  const toast = document.createElement('div');
  toast.className = 'approval-toast';
  toast.dataset.questionId = a.questionId;
  const app = createApp(ApprovalToast, {
    approval: a,
    onRespond: (questionId: string, value: string) => void respondToApproval(questionId, value, toast),
  });
  app.mount(toast);
  container.appendChild(toast);
  // Auto-remove after 30s if the user takes no action — they can still respond
  // via the Approvals tab. Unmount first: removing the node alone would leave
  // the app's effects subscribed to something nobody can see.
  setTimeout(() => {
    if (toast.parentNode) {
      app.unmount();
      toast.remove();
    }
  }, 30_000);
}

// Fired when another admin handled an approval that was fanned out to us.
// Drop the card from local state, re-render the list, and clear any toast.
export function handleApprovalResolvedEvent(msg: ApprovalMessage): void {
  // msg shape: { type: 'approval_resolved', approvalId, resolvedBy }
  const approvalId = msg.approvalId;
  if (!approvalId) return;
  pendingApprovals = pendingApprovals.filter((a: Approval) => a.questionId !== approvalId);
  renderApprovalsList();
  document.querySelectorAll(`.approval-toast[data-question-id="${approvalId}"]`).forEach((el) => el.remove());
  // Flip any in-room card to a resolved note.
  document.querySelectorAll(`.approval-msg[data-question-id="${approvalId}"]`).forEach((el) => {
    const who = msg.resolvedBy ? ' by ' + (String(msg.resolvedBy).split(':').pop() ?? '').split('@')[0] : '';
    el.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'approval-inroom-note resolved';
    note.textContent = `🔒 Approval — resolved${who}`;
    el.appendChild(note);
  });
}

export function handleApprovalEvent(msg: ApprovalMessage & Approval): void {
  // msg shape: { type: 'approval', questionId, title, question, options, ... }
  // We re-fetch the canonical list so we don't drift if multiple events
  // arrive close together; the toast is purely for live visibility.
  showApprovalToast(msg);
  fetchApprovals();
  // Desktop notification when state.settings allow + tab not focused.
  if (
    state.settings?.notifications &&
    document.hidden &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    try {
      new Notification(msg.title || 'Approval requested', { body: msg.question || '' });
    } catch {}
  }
}

export async function respondToApproval(questionId: string, value: string, cardEl?: HTMLElement | null): Promise<void> {
  // Card feedback is STATE now — both the panel list and the in-transcript card
  // are ApprovalCard instances, and disabling their buttons or appending an
  // error to them by hand writes into Vue-owned DOM.
  const setBusy = (on: boolean) => {
    const next = new Set(approvalBusy.value);
    if (on) next.add(questionId);
    else next.delete(questionId);
    approvalBusy.value = next;
  };
  const setError = (msg: string | null) => {
    const next = { ...approvalErrors.value };
    if (msg) next[questionId] = msg;
    else delete next[questionId];
    approvalErrors.value = next;
  };
  setBusy(true);
  setError(null);
  // The TOAST is still built imperatively, so it still gets a DOM write — and
  // is selected as a toast specifically, rather than by question id, which
  // would match the card first.
  const toastEl =
    cardEl ?? document.querySelector<HTMLElement>(`.approval-toast[data-question-id="${questionId}"]`);
  toastEl?.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const r = await authFetch(`/api/approvals/${encodeURIComponent(questionId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ value }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      console.error('Approval respond failed:', r.status, body);
      setBusy(false);
      // Inline error so the user actually sees why nothing happened.
      setError(`Couldn't respond (${r.status}): ${body.error || r.statusText}`);
      toastEl?.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }
    pendingApprovals = pendingApprovals.filter((a: Approval) => a.questionId !== questionId);
    setBusy(false);
    renderApprovalsList();
    // Remove the toast version too if it's currently visible.
    document.querySelectorAll(`.approval-toast[data-question-id="${questionId}"]`).forEach((el) => el.remove());
  } catch (err: any) {
    console.error('Approval respond errored:', err);
    setBusy(false);
    toastEl?.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}


// Banner toggle: expand/collapse the inline approvals list. Guarded with
// an existence check so a stale cached HTML (without the banner element)
// can't kill the rest of the script with a null.addEventListener throw.
const approvalsBannerToggle = $('#approvals-banner-toggle');

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The approvals strip: allow / deny and the expiry affordance.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireApprovalsPanel() at the exact line the
// first block occupied, so execution order is unchanged.

export function wireApprovalsPanel(): void {
  if (approvalsBannerToggle) {
    approvalsBannerToggle.addEventListener('click', () => {
      const banner = $('#approvals-banner');
      const list = $('#approval-list');
      if (!banner || !list) return;
      const expanded = banner.classList.toggle('expanded');
      list.hidden = !expanded;
      approvalsBannerToggle.setAttribute('aria-expanded', String(expanded));
    });
  }
}
