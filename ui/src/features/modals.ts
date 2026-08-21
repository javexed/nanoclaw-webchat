// ── Modals, overlays and popovers ────────────────────────────────────────────
// The blocking surfaces: the confirm and input modals, the OAuth mint modal,
// the image lightbox, and the two popovers (handle, @-mention).
//
// First extraction of phase 3 — the per-panel split of the wiring layer — and
// the first module born as TypeScript rather than converted. Modals go first
// because showConfirmModal is called from nearly every other panel: extracting
// it now means the panels that follow IMPORT it instead of being handed it
// through provide*Deps.
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import {
  getMentionMatches,
  getMentionSelectedIndex,
  getMentionStart,
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
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
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

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideModalsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface ModalsDeps {
  acceptMention: (...args: any[]) => any;
  copyTextToClipboard: (...args: any[]) => any;
  getUserCredsOauthStatus: () => any;
  getUserCredsWords: (a0?: any) => any;
  updateHandleCreds: (...args: any[]) => any;
}

const deps = {} as ModalsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
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

export function blockingOverlayOpen() {
  // The floor's desk popover is class-keyed, not id-keyed — without this the
  // boot Esc handler closes the whole floor view instead of just the popover.
  if (document.querySelector('.floor-popover')) return true;
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

  const poll = async () => {
    const r = await authFetch('/api/user-credentials/grok/status');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  };
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

  try {
    const r = await authFetch('/api/user-credentials/grok/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ roomId: state.currentRoom }),
    });
    const started = await r.json();
    if (!r.ok) throw new Error(started.error || r.statusText);

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
    const r = await authFetch(startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify(isWorkspace ? {} : { roomId: state.currentRoom }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
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
      // The pairing-code line is an island now. Only the hidden flag stays
      // here — it is a decision about the whole Codex step, not the line.
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
  // body+fixed: iOS shifts the visual viewport when the on-screen keyboard
  // opens while fixed elements stay pinned to the layout viewport, which
  // painted the popover off-screen on iPhone PWAs. In-layout anchoring rides
  // with the input under every keyboard state, with no JS positioning math.
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
  if (codexCodeApp) return;
  const host = $('#user-creds-oauth-codex-code');
  if (!host) return;
  codexCodeApp = createApp(CodexPairingCode, {
    onCopy: (code: string) => deps.copyTextToClipboard(code),
  });
  codexCodeApp.mount(host);
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

export async function inspectAndConfirmImport(importBody?: any, displayName?: any, community?: any) {
  let insp: any = null;
  try {
    const res = await authFetch('/api/skills/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...importBody, official: !community }),
    });
    if (res.ok) insp = await res.json();
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

export async function confirmWithToggle({ title, toggleLabel, note, confirmLabel }: any) {
  const el = document.createElement('div');
  const s = reactive({ toggleLabel, note, el: null as HTMLInputElement | null });
  const app = createApp(ConfirmToggle);
  app.provide('confirmToggle', s);
  app.mount(el);
  const ok = await showConfirmModal({ title, body: el, confirmLabel });
  const checked = !!s.el?.checked; // read before unmounting — the node goes with it
  app.unmount();
  return { ok, checked };
}

// ── Panel wiring ─────────────────────────────────────────────────────────────
// Shared modal chrome: backdrop dismissal, escape handling and the lightbox.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireModalsPanel() at the exact line the
// first block occupied, so execution order is unchanged.

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

  // Personal credentials panel (Settings → My credentials). "patchset C" (b5fc2ab)
  // shipped the openSettings() call below and the #settings-my-credentials markup,
  // but NOT this renderer — so opening Settings threw `ReferenceError:
  // renderMyCredentials is not defined`, which aborted the whole modal open. Until
  // the panel is fully wired (against /api/user-credentials/credential), keep it
  // hidden rather than crash Settings.
  // Settings modal open/close

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

  // ── Settings → Features → Read aloud (one-click Kokoro install) ─────────────
  // Owner-only endpoint; non-owners still see the block (hidden install row —
  // the per-device toggle works for everyone via Web Speech). Same install-row
  // + progress-log pattern as Auto routing; the health-check phase covers the
  // ~330MB first-boot model download, and the final step activates the .env
  // flags in-process, so no host restart.
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
  // ── View router ────────────────────────────────────────────────────────────
  // Overlay surfaces (dashboard, permissions, …) stacked above the base
  // rooms/chat view. Opening a surface pushes a history entry so the OS/browser
  // back gesture closes it instead of exiting the PWA; the popstate handler below
  // unwinds the stack. Programmatic closes (X buttons, in-app back) go through
  // closeView() so the stack and history stay in sync.
}

// ── Lightbox ─────────────────────────────────────────────────────────────────
// Pinch-zoom and drag-to-pan state for the image lightbox, owned here rather
// than injected. This module already exports openLightbox, closeLightbox and
// applyLightboxTransform, and was reaching the transform through
// lightboxXf at five sites — the state sat in legacy.js only because
// that is where it was declared, not because anything else read it. Owning it
// deletes the accessor on both sides.
//
// State and the element lookup are module scope; only the LISTENERS are
// deferred into wireLightbox(), which legacy calls from the line the listeners
// occupied — NOT from the line the state was declared on. Anchoring on the
// declaration registered them ~84 lines early, ahead of window:popstate and
// document:keydown. The listener SET was identical either way; only the
// boot-order trace saw it (docs/webchat/boot-order-guard.md).

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

// ── Panel wiring ───────────────────────────────────────────────────────────
// Blocks whose SUBJECT element this module already owns. The ownership census
// reported them as multi-owner, which was the union of every id they touch
// rather than what they are for.

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
      const r = await authFetch(finishUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      userCredsOauthSessionId.value = null;
      if (isWorkspace) {
        showToast(`Workspace default ${isCodex ? 'ChatGPT' : 'Claude'} subscription connected.`, { kind: 'success' });
        modal.hidden = true;
        // Refresh the wizard engine list (controls swap to the ✓ connected card
        // + chip). The default login lives only in the wizard now.
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

/**
 * The OAuth modal's status line. It writes #user-creds-oauth-status, which is
 * this modal's own markup — it sat in members.ts and was handed back through a
 * bridge entry, which is the shape of a function filed under the wrong owner.
 */
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
