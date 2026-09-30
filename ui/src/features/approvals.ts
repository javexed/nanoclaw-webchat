// ── Approvals ────────────────────────────────────────────────────────────────
// The approval cards an agent raises mid-turn ("may I run this?"), their list
// view, the resolve round-trip, and the live events that mutate both. Needs no
// injected deps from the composition root.
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { state } from '../core/state.js';
import '../core/toast.js';
import { authFetch } from '../core/api.js';
import { createApp } from 'vue';
import ApprovalsList from './ApprovalsList.vue';
import ApprovalToast from './ApprovalToast.vue';
import { approvalBusy, approvalErrors, approvalRows } from './approvals-state.js';

/** One button on an approval card. `label` falls back to `value` when absent. */
export interface ApprovalOption {
  label?: string;
  value: string;
}

/** An approval an agent raised mid-turn: every field this module reads. */
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

// Owned here: nothing else reads or writes it.
let pendingApprovals: Approval[] = [];

// Pending approvals (install_packages, add_mcp_server, etc.) surface as an
// inline banner above the active sidebar tab — only when count > 0, so
// users with no pending items see nothing. The banner expands to reveal
// the cards in place; click Approve/Reject directly without leaving the
// current tab. Live arrival also fires a top-right toast.
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
  // Pluralize the trailing word; the number stays inside #approvals-count.
  const noun = count === 1 ? 'approval' : 'approvals';
  // Reset textEl content but keep the count span: rebuild it.
  textEl.innerHTML = '';
  textEl.appendChild(countEl);
  textEl.appendChild(document.createTextNode(` ${noun} pending`));
}

let approvalsApp: ReturnType<typeof createApp> | null = null;

function mountApprovalsList(): void {
  approvalsApp ??= mountIsland('#approval-list', () =>
    createApp(ApprovalsList, {
      onRespond: (questionId: string, value: string) => respondToApproval(questionId, value, null),
    }),
  );
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
  // Re-fetch the canonical list so close-together events cannot drift it; the
  // toast is purely for live visibility.
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
  // Card feedback is state: both the panel and the in-transcript card are
  // ApprovalCard instances, whose DOM Vue owns.
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
  // The toast is built imperatively, so it gets a DOM write — selected as a
  // toast specifically, since the bare question id would match the card first.
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

// Banner toggle. Null-checked so a stale cached HTML without the banner cannot
// throw and kill the rest of boot.
const approvalsBannerToggle = $('#approvals-banner-toggle');

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The approvals banner's expand/collapse toggle.
// Called from composition-root.ts at its place in boot order rather than run at module scope (check-boot-order.sh).

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
