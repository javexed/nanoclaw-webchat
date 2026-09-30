// ── Modals, overlays and popovers ────────────────────────────────────────────
// The blocking surfaces: the confirm and input modals, the OAuth mint modal,
// the image lightbox, and the two popovers (handle, @-mention).
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import {
  getMentionMatches,
  getMentionSelectedIndex,
  setMentionMatches,
  setMentionSelectedIndex,
  setMentionStart,
} from './composer.js';
import { lightboxOpen } from './modals-state.js';
import {
  userCredsOauthReturnFocus,
  userCredsOauthSessionId,
  userCredsOauthTarget,
  userCredsProvider,
  userCredsWords,
} from './user-creds-state.js';
import { refreshWizardCredState } from './wizard.js';
import { applySettings } from './settings.js';
import { showToast } from '../core/toast.js';
import { apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { snapshotRoomImages } from './rooms.js';
import { updateUserCredsBanner } from './members.js';
import { createApp, reactive } from 'vue';
import ConfirmInput from './ConfirmInput.vue';
import ConfirmToggle from './ConfirmToggle.vue';
import ConfirmModal from './ConfirmModal.vue';
import MentionPopover from './MentionPopover.vue';
import CodexPairingCode from './CodexPairingCode.vue';
import { codexActive, codexUserCode } from './codex-code-state.js';
import { mentionMatches, mentionSelectedIndex } from './mention-popover-state.js';

/** Supplied by provideModalsDeps in composition-root.ts. `any` marks a signature not
 *  yet typed, not an opt-out of checking. */
export interface ModalsDeps {
  acceptMention: (...args: any[]) => any;
  copyTextToClipboard: (...args: any[]) => any;
  updateHandleCreds: (...args: any[]) => any;
}

const deps = {} as ModalsDeps;

/** Wire the composition-root helpers this module calls. Call once at startup. */
export function provideModalsDeps(provided: Partial<ModalsDeps>): void {
  Object.assign(deps, provided);
}

export function openHandlePopover() {
  const pop = $('#handle-popover');
  const input = $('#handle-input') as HTMLInputElement;
  const status = $('#handle-status');
  if (!pop) return;
  if (input) input.value = state.myHandle || '';
  if (status) {
    status.hidden = true;
    status.textContent = '';
    status.classList.remove('ok', 'err');
  }
  deps.updateHandleCreds();
  pop.hidden = false;
  $('#handle-chip')?.setAttribute('aria-expanded', 'true');
  if (input) input.focus();
}

export function closeHandlePopover() {
  const pop = $('#handle-popover');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  $('#handle-chip')?.setAttribute('aria-expanded', 'false');
}

let lightboxImages: any[] = []; // [{ url, alt }] snapshot taken on open

let lightboxIndex = 0;

let prevBodyOverflow = '';

let lightboxCloseTimer: any = null;

export function applyLightboxTransform() {
  const img = $('#lightbox-img')!;
  img.style.transform = `translate(${lightboxXf.x}px, ${lightboxXf.y}px) scale(${lightboxXf.scale})`;
}

export function resetLightboxTransform() {
  lightboxXf.scale = 1;
  lightboxXf.x = 0;
  lightboxXf.y = 0;
  applyLightboxTransform();
}

function setLightboxImage(idx?: any) {
  if (idx < 0 || idx >= lightboxImages.length) return;
  lightboxIndex = idx;
  const { url, alt } = lightboxImages[idx];
  const img = $('#lightbox-img')! as HTMLElement;
  const spinner = $('#lightbox-spinner')!;
  resetLightboxTransform();
  spinner.hidden = false;
  img.style.visibility = 'hidden';
  // Assign via property (not addEventListener) so each new load cleanly
  // replaces the previous handler — rapid next/next doesn't stack callbacks.
  img.onload = img.onerror = () => {
    spinner.hidden = true;
    img.style.visibility = '';
  };
  (img as HTMLImageElement).src = url;
  (img as HTMLImageElement).alt = alt;
  // Download href tracks the current image. Filename derived from URL tail.
  const dl = $('#lightbox-download')! as HTMLElement;
  (dl as HTMLAnchorElement).href = url;
  try {
    const tail = new URL(url, location.href).pathname.split('/').pop();
    if (tail) dl.setAttribute('download', tail);
  } catch {
    dl.setAttribute('download', '');
  }
  // Toggle prev/next visibility
  $('#lightbox-prev')!.hidden = idx <= 0;
  $('#lightbox-next')!.hidden = idx >= lightboxImages.length - 1;
}

export function openLightbox(url?: any, alt?: any) {
  // If a previous close is still mid-fade, cancel its pending hide so we
  // don't slam the freshly-opened lightbox closed 150ms from now.
  if (lightboxCloseTimer) {
    clearTimeout(lightboxCloseTimer);
    lightboxCloseTimer = null;
  }
  lightboxImages = snapshotRoomImages();
  // Find which image was clicked. Match by URL; fall back to a 1-entry list.
  let idx = lightboxImages.findIndex((it) => it.url === url);
  if (idx === -1) {
    lightboxImages = [{ url, alt: alt || '' }];
    idx = 0;
  }
  const overlay = $('#lightbox')!;
  overlay.classList.remove('closing');
  overlay.hidden = false;
  lightboxOpen.value = true;
  prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  setLightboxImage(idx);
  history.pushState({ lightbox: true }, '');
  // Defer focus so the dialog is on-screen before focus moves
  requestAnimationFrame(() => $('#lightbox-close')!.focus());
}

export function closeLightbox(fromPopstate = false) {
  if (!lightboxOpen.value) return;
  const overlay = $('#lightbox')!;
  lightboxOpen.value = false;
  overlay.classList.add('closing');
  document.body.style.overflow = prevBodyOverflow;
  lightboxCloseTimer = setTimeout(() => {
    lightboxCloseTimer = null;
    overlay.hidden = true;
    overlay.classList.remove('closing');
    $<HTMLImageElement>('#lightbox-img')!.src = '';
    $('#lightbox-img')!.style.transform = '';
    $('#lightbox-img')!.style.visibility = '';
  }, 150);
  if (!fromPopstate && history.state && history.state.lightbox) {
    history.back();
  }
}

export function navigateLightbox(delta?: any) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= lightboxImages.length) return;
  setLightboxImage(next);
}

// True when a modal / popover / menu is open that should consume Escape before a
// full-screen view does. These each have their own ESC handler (bubble phase);
// the view-close handler below runs in the CAPTURE phase, so it sees the overlay
// still open and yields to it — one Escape closes exactly one layer.
export function blockingOverlayOpen() {
  // `.modal-overlay` covers the settings, user-creds, and (dynamically mounted)
  // confirm modals; the rest are listed explicitly. Visible = present and not
  // [hidden].
  if (document.querySelector('.modal-overlay:not([hidden])')) return true;
  const others = [
    'model-picker',
    'lightbox',
    'members-overlay',
    'handle-popover',
    'overflow-menu',
    'search-results',
    'learn-menu',
  ];
  return others.some((id) => {
    const el = document.getElementById(id);
    return el && !el.hidden;
  });
}

/**
 * Member Grok device login.
 *
 * Two polls, not one: the first waits for the CLI to print a URL and code, the
 * second waits for the member to approve on whatever device they opened it on.
 * `grokMintToken` is the cancellation signal — reopening or closing the modal
 * bumps it, and any in-flight loop notices and stops rather than writing into
 * a dialog that has moved on.
 */
let grokMintToken = 0;

export function cancelGrokMint(): void {
  grokMintToken++;
}

async function openGrokMintModal(modal: HTMLElement): Promise<void> {
  const token = ++grokMintToken;
  const alive = () => token === grokMintToken && !modal.hidden;
  const status = (msg: string, kind = '') => userCredsOauthStatus(msg, kind);

  const title = $('#user-creds-oauth-title');
  if (title) title.textContent = 'Connect to Grok';
  $('#user-creds-oauth-step2')!.hidden = true;
  $('#user-creds-oauth-submit')!.hidden = true; // nothing to submit — approval is detected
  $('#user-creds-oauth-spinner')!.hidden = false;
  const code = $('#user-creds-oauth-code') as HTMLInputElement | null;
  if (code) code.hidden = true;
  const codeLabel = $('#user-creds-oauth-code-label');
  if (codeLabel) codeLabel.hidden = true;
  userCredsOauthReturnFocus.value = document.activeElement as HTMLElement | null;
  modal.hidden = false;
  $('#user-creds-oauth-close')?.focus();
  status('Starting sign-in…');

  const poll = () => apiJson('/api/user-credentials/grok/status');
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

  try {
    const started = await apiJson('/api/user-credentials/grok/start', {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
      body: { roomId: state.currentRoom },
    });

    // Phase 1 — wait for the URL and code.
    let d = started;
    for (let i = 0; alive() && !d.verificationUrl && d.outcome !== 'error' && i < 40; i++) {
      await wait(750);
      if (!alive()) return;
      d = await poll();
    }
    if (!alive()) return;
    if (d.outcome === 'error') throw new Error(d.error || 'Sign-in failed.');
    if (!d.verificationUrl) throw new Error('Timed out waiting for the sign-in link.');

    const link = $('#user-creds-oauth-link') as HTMLAnchorElement | null;
    if (link) {
      link.href = d.verificationUrl;
      link.textContent = 'Open Grok sign-in ↗';
    }
    // Reuse the Codex pairing-code island — same job, same shape.
    codexActive.value = true;
    codexUserCode.value = d.userCode || '';
    const codexCode = $('#user-creds-oauth-codex-code');
    if (codexCode) codexCode.hidden = false;
    mountCodexCode();
    $('#user-creds-oauth-spinner')!.hidden = true;
    $('#user-creds-oauth-step2')!.hidden = false;
    status('Open the link and approve — this page finishes on its own.');
    link?.focus();

    // Phase 2 — wait for approval. The status route stores the credential the
    // moment it sees a completed login, so arriving here means it is saved.
    while (alive() && d.outcome === 'pending') {
      await wait(2000);
      if (!alive()) return;
      d = await poll();
    }
    if (!alive()) return;
    if (d.outcome !== 'complete') throw new Error(d.error || 'Sign-in was not completed.');

    grokMintToken++; // this flow is done; nothing else should still be polling
    codexActive.value = false;
    showToast('Connected your Grok subscription.', { kind: 'success' });
    modal.hidden = true;
    await updateUserCredsBanner(state.currentRoom);
  } catch (err) {
    if (!alive()) return;
    $('#user-creds-oauth-spinner')!.hidden = true;
    status((err as any)?.message || 'Could not start sign-in.', 'error');
  }
}

// ── UserCreds OAuth: connect a Claude subscription token ────────────────────────
// Browser-mint OAuth: no terminal. Opening the form starts a server-side mint
// (a throwaway container runs `claude setup-token`), surfaces the sign-in URL,
// takes the pasted code, and onboards the resulting token per-member.
export async function openOauthMintModal(target?: any) {
  userCredsOauthTarget.value = target;
  const modal = $('#user-creds-oauth-modal');
  if (!modal) return;
  const isWorkspace = target.startsWith('workspace');
  // Grok is a device flow with no code to paste back and no "finish" call: the
  // server polls the CLI and the browser polls the server. It gets its own path
  // rather than a third arm on every isCodex ternary below.
  if (!isWorkspace && userCredsProvider.value === 'grok') return openGrokMintModal(modal);
  const isCodex = target === 'workspace-codex' || (!isWorkspace && userCredsProvider.value === 'codex');
  const title = $('#user-creds-oauth-title');
  if (title)
    title.textContent = isWorkspace
      ? `Connect ${isCodex ? 'ChatGPT' : 'Claude'} (workspace default)`
      : `Connect to ${userCredsWords(userCredsProvider.value).name}`;
  $('#user-creds-oauth-step2')!.hidden = true;
  $('#user-creds-oauth-submit')!.hidden = true;
  $('#user-creds-oauth-spinner')!.hidden = false; // spinner while the mint warms up
  const code = $('#user-creds-oauth-code') as HTMLInputElement;
  if (code) code.value = '';
  const codexCode = $('#user-creds-oauth-codex-code');
  userCredsOauthReturnFocus.value = document.activeElement as HTMLElement | null; // restore focus here on close
  modal.hidden = false;
  $('#user-creds-oauth-close')?.focus(); // move focus into the dialog
  userCredsOauthStatus('Preparing sign-in…', '');
  try {
    const startUrl = isWorkspace
      ? isCodex
        ? '/api/workspace-credential/codex/start'
        : '/api/workspace-credential/oauth/start'
      : isCodex
        ? '/api/user-credentials/codex/start'
        : '/api/user-credentials/oauth/start';
    const data = await apiJson(startUrl, {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
      body: isWorkspace ? {} : { roomId: state.currentRoom },
    });
    userCredsOauthSessionId.value = data.sessionId;
    const link = $('#user-creds-oauth-link') as HTMLElement;
    if (link) {
      (link as HTMLAnchorElement).href = data.url;
      link.textContent = isWorkspace
        ? `Open ${isCodex ? 'ChatGPT' : 'Claude'} sign-in ↗`
        : `Open ${userCredsWords(userCredsProvider.value).name} sign-in ↗`;
    }
    // Claude: paste a code back. Codex: enter a pairing code at the site, then approve.
    if (code) code.hidden = isCodex;
    const codeLabel = $('#user-creds-oauth-code-label');
    if (codeLabel) codeLabel.hidden = isCodex;
    if (codexCode) {
      codexCode.hidden = !isCodex;
      // The pairing-code line is an island; only the hidden flag stays here —
      // it is a decision about the whole Codex step, not the line.
      codexActive.value = isCodex;
      codexUserCode.value = isCodex ? data.userCode || '' : '';
      mountCodexCode();
    }
    const submit = $('#user-creds-oauth-submit');
    if (submit) submit.textContent = isCodex ? 'I’ve approved — connect' : 'Connect';
    $('#user-creds-oauth-spinner')!.hidden = true;
    $('#user-creds-oauth-step2')!.hidden = false;
    $('#user-creds-oauth-submit')!.hidden = false;
    userCredsOauthStatus(isCodex ? 'Open the link, enter the code, and approve — then click connect.' : '', '');
    $('#user-creds-oauth-link')!.focus();
  } catch (err) {
    $('#user-creds-oauth-spinner')!.hidden = true;
    userCredsOauthStatus((err as any)?.message || 'Could not start sign-in.', 'error');
  }
}

/**
 * Promise-based confirmation modal. Resolves true on confirm, false on
 * cancel / backdrop / Escape. `body` may be a string or an HTMLElement (use an
 * element when the message contains user-supplied text, so it stays escaped).
 * `destructive` styles the confirm button as a delete action and focuses
 * Cancel by default.
 */
// `extraActions` (optional): buttons rendered between Cancel and the primary
// Confirm, each `{ label, value, className? }`. Clicking one resolves the promise
// with its `value` (Confirm still resolves `true`, Cancel/Escape `false`), so a
// caller can offer more than a yes/no without a bespoke modal.
// `beforeConfirm` (optional): runs on every confirm attempt (button or Enter);
// returning false keeps the modal open — the inline-validation hook.
export function showConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  extraActions = [],
  beforeConfirm = null,
}: any) {
  return new Promise((resolve) => {
    // Per-instance, like the skill editor: the overlay is created here and the
    // app mounts INTO it, keeping the structure overlay > modal.
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-overlay';
    document.body.appendChild(overlay);

    let settled = false;
    let app: ReturnType<typeof createApp> | null = null;
    const close = (result?: any) => {
      if (settled) return;
      settled = true;
      // Unmount before removing: the component drops its document-level keydown
      // listener in onUnmounted, and removing the node alone would leave it
      // bound to a dialog nobody can see.
      app?.unmount();
      app = null;
      overlay.remove();
      resolve(result);
    };
    const confirm = () => {
      if (beforeConfirm && beforeConfirm() === false) return;
      close(true);
    };

    app = createApp(ConfirmModal, {
      title,
      body,
      confirmLabel,
      cancelLabel,
      destructive: !!destructive,
      extraActions,
      onPick: close,
      onConfirm: confirm,
    });
    app.mount(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
  });
}

/** Single-line text prompt in the app's modal chrome — replaces native prompt()
 * (unstylable, ESC-inconsistent, blocked in some PWA contexts). Returns the
 * trimmed value, or null on cancel/empty.
 * `validate(trimmedValue)` (optional): return an error string to keep the modal
 * open with that message inline (DESIGN §5 — field validation is inline text),
 * or null/undefined to accept. */
export async function showInputModal({
  title,
  placeholder = '',
  value = '',
  confirmLabel = 'Create',
  validate = null,
}: any) {
  const wrap = document.createElement('div');
  // Per-call state, injected rather than passed as root props: root props are
  // read once at createApp, and a module ref would let two open modals collide.
  const s = reactive({
    placeholder,
    initial: value,
    validate,
    error: '',
    invalid: false,
    el: null as HTMLInputElement | null,
  });
  const app = createApp(ConfirmInput);
  app.provide('confirmInput', s);
  app.mount(wrap);
  let beforeConfirm: any = null;
  if (validate) {
    beforeConfirm = () => {
      const msg = validate((s.el?.value ?? '').trim());
      if (!msg) return true;
      s.error = msg;
      s.invalid = true;
      s.el?.focus();
      return false;
    };
  }
  const done = showConfirmModal({ title, body: wrap, confirmLabel, beforeConfirm });
  s.el?.focus(); // after showConfirmModal's own focus call, so the input wins
  const ok = await done;
  const out = ok ? (s.el?.value ?? '').trim() || null : null;
  // Unmount, don't just drop the reference: showConfirmModal removes the
  // overlay that contains this wrapper, and an app whose host is detached is
  // still mounted.
  app.unmount();
  return out;
}

let mentionPopover: any = null;

function ensureMentionPopover() {
  if (mentionPopover) return mentionPopover;
  const el = document.createElement('div');
  el.id = 'mention-popover';
  el.className = 'mention-popover';
  el.hidden = true;
  // Anchor INSIDE the composer (absolute, bottom:100% — see CSS), not
  // body+fixed: iOS keeps fixed elements on the layout viewport while the
  // keyboard shifts the visual one, painting the popover off-screen.
  $('#message-form')!.appendChild(el);
  mentionPopover = el;
  return el;
}

export function dismissMentionPopover() {
  setMentionStart(-1);
  setMentionMatches([]);
  if (mentionPopover) mentionPopover.hidden = true;
}

let codexCodeApp: ReturnType<typeof createApp> | null = null;

function mountCodexCode(): void {
  codexCodeApp ??= mountIsland('#user-creds-oauth-codex-code', () =>
    createApp(CodexPairingCode, {
      onCopy: (code: string) => deps.copyTextToClipboard(code),
    }),
  );
}

let mentionApp: ReturnType<typeof createApp> | null = null;

export function renderMentionPopover(input?: any) {
  const el = ensureMentionPopover();
  if (getMentionMatches().length === 0) {
    el.hidden = true;
    return;
  }
  mentionMatches.value = getMentionMatches();
  mentionSelectedIndex.value = getMentionSelectedIndex();
  if (!mentionApp) {
    mentionApp = createApp(MentionPopover, {
      onPick: (i: number) => {
        setMentionSelectedIndex(i);
        deps.acceptMention(input);
      },
    });
    mentionApp.mount(el);
  }
  // Placement is pure CSS (absolute above the composer) — nothing to compute.
  el.hidden = false;
}

// The pre-import gate: fetch the skill's contents (nothing is written) and show
// what's inside — files, scripts, size, external links, lint findings — before
// the user commits. Falls back to a text-only confirm if inspection fails, so a
// GitHub hiccup can't brick importing.
export async function inspectAndConfirmImport(importBody?: any, displayName?: any, community?: any) {
  let insp: any = null;
  try {
    insp = await apiJson('/api/skills/inspect', { method: 'POST', body: { ...importBody, official: !community } });
  } catch {}
  if (!insp) {
    return showConfirmModal({
      title: `Import ${displayName}?`,
      body: community
        ? 'This is a community skill — its instructions and scripts will run in your agents. Review it first.'
        : undefined,
      confirmLabel: 'Import',
      destructive: !!community,
    });
  }
  const el = document.createElement('div');
  const line = (text?: any, cls?: any) => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = text;
    el.appendChild(d);
  };
  const kb = Math.max(1, Math.round(insp.totalBytes / 1024));
  line(
    `${insp.files} file${insp.files === 1 ? '' : 's'} · ${kb} KB · SKILL.md ≈ ${insp.skillMdTokens.toLocaleString()} tokens of agent context`,
  );
  line(
    insp.scripts.length
      ? `Scripts: ${insp.scripts.slice(0, 5).join(', ')}${insp.scripts.length > 5 ? ` +${insp.scripts.length - 5} more` : ''}`
      : 'No scripts — instructions only',
  );
  if (insp.externalHosts.length) line(`Links out to: ${insp.externalHosts.slice(0, 6).join(', ')}`);
  for (const w of insp.warnings) line(`⚠ ${w}`, 'import-warning');
  if (community)
    line('Community skill — unvetted. Its instructions and any scripts run in your agents.', 'import-note');
  return showConfirmModal({
    title: `Import ${displayName}?`,
    body: el,
    confirmLabel: 'Import',
    destructive: !!community || insp.warnings.length > 0,
  });
}

/** Confirm modal with one switch option — the modal twin of .setting-toggle
 * (DESIGN.md §2b: binary choices are switches, never raw checkboxes). */
export async function confirmWithToggle({ title, toggleLabel, toggleLabels, note, confirmLabel }: any) {
  const el = document.createElement('div');
  const labels: string[] = toggleLabels ?? [toggleLabel];
  const s = reactive({ labels, note, els: [] as (HTMLInputElement | null)[] });
  const app = createApp(ConfirmToggle);
  app.provide('confirmToggle', s);
  app.mount(el);
  const ok = await showConfirmModal({ title, body: el, confirmLabel });
  const checks = labels.map((_, i) => !!s.els[i]?.checked); // read before unmounting — the nodes go with it
  app.unmount();
  return { ok, checked: checks[0], checks };
}

// ── Panel wiring ─────────────────────────────────────────────────────────────
// Shared modal chrome: backdrop dismissal, escape handling and the lightbox.
// Called from composition-root.ts at its place in boot order rather than run at module scope (check-boot-order.sh).

export function wireModalsPanel(): void {
  $<HTMLButtonElement>('#handle-chip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#handle-popover');
    if (pop && pop.hidden) openHandlePopover();
    else closeHandlePopover();
  });
  $<HTMLButtonElement>('#handle-popover-close')?.addEventListener('click', closeHandlePopover);
  // Click outside the popover (and not on the chip) closes it.
  document.addEventListener('click', (e) => {
    const pop = $('#handle-popover');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target as Node | null) || e.target === $<HTMLButtonElement>('#handle-chip')) return;
    closeHandlePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHandlePopover();
  });

  // Apply on load
  applySettings();

  // ── Settings → Features → ⓘ info toggles ────────────────────────────────────
  // Each .feature-info-btn opens/closes the description named by aria-controls.
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('.feature-info-btn');
    if (!btn) return;
    const controls = btn.getAttribute('aria-controls');
    const info = controls ? document.getElementById(controls) : null;
    if (!info) return;
    const open = info.hidden;
    info.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });

  // Image lightbox — opened from file-bubble image clicks. Closes via ×, backdrop tap,
  // ESC, or device back gesture. pushState lets the OS back gesture / Android back
  // button dismiss the viewer instead of leaving the app.
  $<HTMLButtonElement>('#lightbox-close')?.addEventListener('click', () => closeLightbox());
  $<HTMLButtonElement>('#lightbox-prev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateLightbox(-1);
  });
  $<HTMLButtonElement>('#lightbox-next')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateLightbox(1);
  });
  $<HTMLAnchorElement>('#lightbox-download')?.addEventListener('click', (e) => e.stopPropagation());
  $('#lightbox')?.addEventListener('click', (e) => {
    // Backdrop tap closes; tapping the image, toolbar, nav, or spinner does not.
    if (e.target === $('#lightbox')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!lightboxOpen.value) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navigateLightbox(-1);
    else if (e.key === 'ArrowRight') navigateLightbox(1);
  });
}

// ── Lightbox ─────────────────────────────────────────────────────────────────
// State is module scope; only the listeners are deferred into wireLightbox(),
// whose call site in composition-root.ts fixes their boot order relative to
// popstate and keydown (docs/webchat/boot-order-guard.md).

// Transform state for pinch-zoom + pan.
const lightboxXf = { scale: 1, x: 0, y: 0 };

const lightboxGesture = {
  startScale: 1,
  startDist: 0,
  startX: 0,
  startY: 0,
  startTouchX: 0,
  startTouchY: 0,
  mode: null as 'pinch' | 'pan' | null,
};

// Pinch-zoom + drag-to-pan on the image. Native pinch-zoom on a fixed-position
// overlay doesn't work reliably on iOS Safari, so we handle touches ourselves.
function getTouchDist(touches: TouchList): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

const lightboxImg = $('#lightbox-img');

/** Pinch-zoom and pan gestures on the lightbox image. */
export function wireLightbox(): void {
  if (!lightboxImg) return;
  lightboxImg.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        lightboxGesture.mode = 'pinch';
        lightboxGesture.startScale = lightboxXf.scale;
        lightboxGesture.startDist = getTouchDist(e.touches);
        lightboxGesture.startX = lightboxXf.x;
        lightboxGesture.startY = lightboxXf.y;
        lightboxImg.classList.add('dragging');
      } else if (e.touches.length === 1 && lightboxXf.scale > 1) {
        e.preventDefault();
        lightboxGesture.mode = 'pan';
        lightboxGesture.startTouchX = e.touches[0].clientX;
        lightboxGesture.startTouchY = e.touches[0].clientY;
        lightboxGesture.startX = lightboxXf.x;
        lightboxGesture.startY = lightboxXf.y;
        lightboxImg.classList.add('dragging');
      }
    },
    { passive: false },
  );
  lightboxImg.addEventListener(
    'touchmove',
    (e) => {
      if (lightboxGesture.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e.touches);
        const ratio = dist / lightboxGesture.startDist;
        lightboxXf.scale = Math.max(0.5, Math.min(4, lightboxGesture.startScale * ratio));
        applyLightboxTransform();
      } else if (lightboxGesture.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        lightboxXf.x = lightboxGesture.startX + (e.touches[0].clientX - lightboxGesture.startTouchX);
        lightboxXf.y = lightboxGesture.startY + (e.touches[0].clientY - lightboxGesture.startTouchY);
        applyLightboxTransform();
      }
    },
    { passive: false },
  );
  lightboxImg.addEventListener('touchend', () => {
    lightboxGesture.mode = null;
    lightboxImg.classList.remove('dragging');
    // Snap back to 1x and centered if user zoomed out below ~identity.
    if (lightboxXf.scale < 1.05) resetLightboxTransform();
  });
}

/** The OAuth mint modal: code submission, spinner and step transitions. */
export function wireUserCredsOauth(): void {
  $<HTMLButtonElement>('#user-creds-oauth-submit')?.addEventListener('click', async () => {
    const isWorkspace = (userCredsOauthTarget.value ?? '').startsWith('workspace');
    const isCodex =
      (userCredsOauthTarget.value ?? '') === 'workspace-codex' || (!isWorkspace && userCredsProvider.value === 'codex');
    const code = ($<HTMLInputElement>('#user-creds-oauth-code')?.value || '').trim();
    if (!userCredsOauthSessionId.value) return;
    if (!isCodex && !code) return; // Claude needs the pasted code; Codex needs none.
    const btn = $<HTMLButtonElement>('#user-creds-oauth-submit');
    const step2 = $('#user-creds-oauth-step2');
    const spinner = $('#user-creds-oauth-spinner');
    const modal = $('#user-creds-oauth-modal');
    if (!btn || !step2 || !spinner || !modal) return;
    btn.disabled = true;
    step2.hidden = true;
    spinner.hidden = false; // spinner while connecting
    const { subWord } = userCredsWords(userCredsProvider.value);
    userCredsOauthStatus('Connecting…', '');
    try {
      const finishUrl = isWorkspace
        ? isCodex
          ? '/api/workspace-credential/codex/finish'
          : '/api/workspace-credential/oauth/code'
        : isCodex
          ? '/api/user-credentials/codex/finish'
          : '/api/user-credentials/oauth/code';
      const body = isWorkspace
        ? isCodex
          ? { sessionId: userCredsOauthSessionId.value }
          : { sessionId: userCredsOauthSessionId.value, code }
        : isCodex
          ? { roomId: state.currentRoom, sessionId: userCredsOauthSessionId.value }
          : { roomId: state.currentRoom, sessionId: userCredsOauthSessionId.value, code };
      await apiJson(finishUrl, { method: 'POST', headers: { 'X-Webchat-CSRF': '1' }, body });
      userCredsOauthSessionId.value = null;
      if (isWorkspace) {
        showToast(`Workspace default ${isCodex ? 'ChatGPT' : 'Claude'} subscription connected.`, { kind: 'success' });
        modal.hidden = true;
        // Refresh the wizard engine list (controls swap to the ✓ connected card
        // + chip). The default login lives only in the wizard.
        refreshWizardCredState();
      } else {
        showToast(`Connected your ${subWord}.`, { kind: 'success' });
        modal.hidden = true;
        await updateUserCredsBanner(state.currentRoom);
      }
    } catch (err: any) {
      spinner.hidden = true;
      step2.hidden = false; // restore so they can retry
      userCredsOauthStatus(err.message || 'Could not connect.', 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/** The OAuth modal's status line (#user-creds-oauth-status). */
export function userCredsOauthStatus(msg?: any, kind?: any) {
  const el = $('#user-creds-oauth-status');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = 'user-creds-oauth-status' + (kind ? ' ' + kind : '');
}
