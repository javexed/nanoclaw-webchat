// ── Global listeners ─────────────────────────────────────────────────────────
// Document- and window-level wiring that belongs to no single panel.
//
// At src/ rather than src/core/, deliberately. This is a COMPOSITION module: it
// calls into feature modules (fetchApprovals, switchManageTab) as well as core
// ones (connect, state), so putting it under core/ would make core import
// features and invert the layering the rest of the split maintains. It sits
// beside legacy.js, at the level allowed to know about everything.
//
// ONE EXPORTED FUNCTION PER BLOCK, each called from the line its block
// occupied. Collapsing both into a single wireGlobalListeners() called at the
// first block's position is what I tried first, and the boot-order trace caught
// it: the manage-tab listeners registered ~900 lines earlier than before. The
// listener SET was byte-identical, so the older diff reported nothing. See
// docs/webchat/boot-order-guard.md.
//
// The lightbox and scroll listeners stay in legacy.js for now: they share six
// mutable locals that each need an accessor pair, which is its own slice.

import { $ } from './core/dom.js';
import { state } from './core/state.js';
import { connect, diagnoseConnection } from './core/ws.js';
import { fetchApprovals } from './features/approvals.js';
import { closeView, openView, switchManageTab } from './features/views.js';
import { closeRoomDetail, joinRoom } from './features/rooms.js';
import { closeAgentDetail } from './features/agents.js';
import { closeMcpDetail } from './features/mcp.js';
import { closeModelDetail } from './features/models.js';

/**
 * On returning to a visible tab: reconnect if the socket dropped, otherwise
 * refresh approvals and advance the read marker for the open room.
 */
export function wireVisibilityRefresh(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.ws && state.ws.readyState !== WebSocket.OPEN) {
      connect();
    } else {
      fetchApprovals();
      // Returning to a focused tab with a room open means its messages are now
      // seen — advance the server marker (and sync other devices). The reconnect
      // path already re-joins (which reads) when the socket was actually down.
      // `?.`, not a bare call: this else-branch is reached when the socket is
      // OPEN *or* when state.ws is null (the && above is false either way), so
      // `state.ws.send(...)` threw on every wake with a room open and no socket.
      if (state.currentRoom)
        state.ws?.send(JSON.stringify({ type: 'read', room_id: state.currentRoom, thread_id: state.currentThread }));
    }
  });

  // Network edges. An 'online' edge is the earliest possible reconnect moment —
  // don't sit out a backoff (up to 30s) that started while the radio was off.
  // An 'offline' edge re-diagnoses immediately (no probe needed on that path)
  // so the banner says "offline" instead of a doomed "reconnecting…".
  window.addEventListener('online', () => {
    if (state.ws && state.ws.readyState !== WebSocket.OPEN) {
      state.reconnectDelay = 1000;
      connect();
    }
  });
  window.addEventListener('offline', () => {
    if (state.ws && state.ws.readyState !== WebSocket.OPEN) void diagnoseConnection();
  });

  // Safety-net poll for approvals. WS push + the reconnect/visibilitychange
  // refetches above cover the common cases, but a *foreground* socket can go
  // silently dead (zombie/throttled connection) and drop an `approval` push with
  // no onclose, no reconnect, and no visibility change to trigger a catch-up — so
  // the card would hang until the next unrelated push or a manual refocus. Poll
  // the canonical pending list on a short interval while the tab is visible so a
  // missed approval still surfaces within seconds. Cheap + idempotent
  // (fetchApprovals just re-renders the scoped list); skipped while hidden since
  // the visibilitychange handler already refetches on return to foreground.
}

/**
 * The manage-view tab strip. Static markup, so this binds once at boot.
 */
export function wireManageTabs(): void {
  document.querySelectorAll<HTMLElement>('.manage-tab').forEach((t: any) => {
    t.addEventListener('click', () => switchManageTab(t.dataset.mtab));
  });

  // ── Skills registry tab ─────────────────────────────────────────────────────
  // Browse every skill (shipped + imported), import one from a GitHub folder, and
  // delete imported ones. Assignment to agents stays in the agent detail's Skills
  // panel; this is the catalog.
  // Learning loop: skills the agents proposed, staged for review (keep + wire, or
  // discard). See docs/webchat/design/learning-loop.md.
  // Pending-drafts badge (learning loop): a count on the ⋯ menu so staged drafts
  // aren't invisible until someone happens to open Skills. Non-admins get a 403
  // from the endpoint → count 0 → badge hidden, correct for who can act on them.


  /**
   * Minimal LCS line diff. A revision is only reviewable if you can see what
   * CHANGED — showing the whole new file and asking someone to spot the edit is not
   * review, it's proofreading. Skills are small, so O(m×n) is fine and beats pulling
   * in a diff dependency.
   */
}

/**
 * Service-worker registration and the update banner.
 *
 * Composition-level, like everything else here: it registers the worker, polls
 * for updates, and drives the banner that offers a reload. It touches
 * #update-banner and the login screen, which belong to the app shell rather
 * than to any panel — which is why the ownership heuristic reported it as
 * "auth+files+learn+rooms+voice" and why none of those is right.
 */
export function wireServiceWorker(hasStagedFile: () => boolean): void {
  if ('serviceWorker' in navigator) {
    let swReg: ServiceWorkerRegistration | null = null;
    const checkForUpdate = () => swReg && swReg.update().catch(() => {});
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // reg can be undefined in environments that block service workers
      // (automation, some embedded webviews).
      if (!reg) return;
      swReg = reg;
      // Check immediately, then every 60s. The interval is frozen while the PWA
      // is backgrounded (especially on iOS), so the foreground re-check below is
      // what actually catches a new build on relaunch — without it a stale shell
      // (e.g. a login screen for a retired bearer token) can render and just sit
      // there versions behind.
      reg.update().catch(() => {});
      setInterval(checkForUpdate, 60000);
      // A worker reaching 'installed' while one already controls the page is a
      // staged update. skipWaiting makes it self-activate → controllerchange →
      // tryReload; wire the banner here too so we never wait on that event.
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (nw)
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) tryReload();
          });
      });
    });

    // Reload when a new service worker takes over.
    // Don't yank the user mid-message: if there's text in the input, a staged
    // file, or the tab is currently visible-and-interactive, defer the reload
    // until the next time the tab is hidden. (`visibilitychange` to hidden →
    // user switched away → safe to reload.)
    let refreshing = false;
    let reloadPending = false;
    function safeToReload() {
      const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
      const hasDraft = input && input.value.trim().length > 0;
      // Passed in as a predicate rather than read directly: pendingFiles is
      // legacy.js module state, and legacy.js imports THIS module, so reading it
      // from here would be a cycle. The block only needs to know whether a file
      // is staged, so that is the whole interface.
      const staged = hasStagedFile();
      if (hasDraft || staged) return false;
      // On the login screen there's no in-app work to lose, so reload straight
      // away instead of waiting for the tab to hide — this is exactly the stuck
      // case (a stale PWA showing a retired-token prompt): the fresh build then
      // auto-signs-in via Tailscale. Only hold off if a token is mid-entry.
      const loginScreen = document.getElementById('login-screen');
      const tokenField = document.getElementById('login-token') as HTMLInputElement | null;
      const onLogin = loginScreen && !loginScreen.hidden;
      const typingToken = tokenField && tokenField.value.trim().length > 0;
      if (onLogin && !typingToken) return true;
      return document.hidden;
    }
    function tryReload() {
      if (refreshing) return;
      if (safeToReload()) {
        refreshing = true;
        location.reload();
      } else {
        // Silent deferral was invisible on mobile: the tab is always visible in
        // use, and iOS freezes JS on background so the hidden-tab reload often
        // never fires — clients sat versions behind with no signal. Surface an
        // actionable banner instead; the hidden-tab auto-reload path still runs.
        reloadPending = true;
        showUpdateBanner();
      }
    }
    function showUpdateBanner() {
      if (document.getElementById('update-banner')) return;
      const b = document.createElement('button');
      b.id = 'update-banner';
      b.type = 'button';
      b.className = 'update-banner';
      b.textContent = 'A new version is ready — tap to refresh';
      b.addEventListener('click', () => {
        refreshing = true;
        location.reload();
      });
      document.body.appendChild(b);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (reloadPending) tryReload();
      } else {
        // Foregrounded — the 60s interval was frozen while backgrounded, so this
        // is when a relaunched PWA must re-check for a new build.
        checkForUpdate();
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      tryReload();
    });

    // Navigate to a room when the SW (notification click) asks us to.
    navigator.serviceWorker.addEventListener('message', (e: any) => {
      if (e.data && e.data.type === 'open-room' && e.data.roomId) {
        const agent = state.allAgents.find((b: any) => b.room_id === e.data.roomId);
        joinRoom(e.data.roomId, agent?.name || e.data.roomId);
      }
    });

    // Cold launch from notification (?room=...) — open that room after init.
    const params = new URLSearchParams(location.search);
    const coldRoom = params.get('room');
    if (coldRoom) {
      const tryJoin = () => {
        const agent = state.allAgents.find((b: any) => b.room_id === coldRoom);
        if (state.allAgents.length) joinRoom(coldRoom, agent?.name || coldRoom);
        else setTimeout(tryJoin, 200);
      };
      tryJoin();
    }
  }
}

// ── App-shell wiring ─────────────────────────────────────────────────────────
// Blocks whose SUBJECT element belongs to the shell rather than to any panel:
// #messages, #message-input, #mobile-back.
//
// The ownership census labelled these "multi-owner" — one showed as
// agents+approvals+composer+rooms+skills+thinking+transcript+ws — but that is
// the union of every id a block touches, not its owner. #messages is referenced
// by eight modules because eight modules render INTO it; the container itself is
// nobody's. Attributing by the block's subject separates a genuinely shared
// element from an incidental reference.
//
// Only the three shell blocks with no legacy-local dependencies are here. The
// other four (#overflow-btn, #detail-overlay, and two more on #message-input)
// each need two or three symbols that are still legacy module state — those
// want an accessor design of their own, not a twelve-parameter function.

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * Code-block Wrap/Copy used to be delegated from #messages: one click handler
 * that found the button, wrote its label and toggled its classes. CodeToolbar
 * owns both buttons and both pieces of feedback now, so there is nothing left
 * to delegate — see features/CodeToolbar.vue.
 */

/** Mobile back affordance: leaves the in-room layout. */
export function wireMobileBack(): void {
  $('#mobile-back')?.addEventListener('click', () => {
    $('#app')?.classList.remove('in-room');
  });
}

/** Composer paste: long text becomes an attachment; files fall through
 * to the drop handler. */
export function wireComposerPaste(): void {
  $('#message-input')?.addEventListener('paste', (e: any) => {
    if (e.clipboardData?.files?.length) return; // images/files handled by the document listener
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.includes('\n')) return; // single-line pastes stay inline
    e.preventDefault();
    // bound directly to the #message-input textarea, so currentTarget is it
    const input = e.currentTarget as HTMLTextAreaElement;
    // Fence must be longer than any backtick run inside so nested ``` survive.
    const longestTicks = (text.match(/`+/g) || []).reduce((m: any, r: any) => Math.max(m, r.length), 0);
    const fence = '`'.repeat(Math.max(3, longestTicks + 1));
    const before = input.value.slice(0, input.selectionStart);
    const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    const body = text.replace(/\n+$/, ''); // trim trailing blank lines inside the block
    const insert = `${lead}${fence}\n${body}\n${fence}\n`;
    // execCommand keeps the native undo stack so Ctrl/Cmd+Z reverts the wrap; fall
    // back to setRangeText only if it genuinely didn't insert (value unchanged).
    const valBefore = input.value;
    document.execCommand('insertText', false, insert);
    if (input.value === valBefore) {
      input.setRangeText(insert, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

// ── Detail-overlay routing ───────────────────────────────────────────────────
// The shared backdrop behind every detail aside, plus the two pieces of state it
// needs: whether a drawer owns the top view-stack entry, and a deferred
// full-view open to run once the drawer's route has popped.
//
// Owned here rather than injected. boot.ts cannot read legacy state — legacy
// imports this module — so the choice was to move the state or to pass three
// callbacks in. The state has no reason to live in legacy: the overlay is the
// only thing that drives it, and views.ts reads it through a deps entry that
// legacy now relays from the accessors below.

// ── Detail-panel backdrop (mobile-only via CSS) ─────────────────────────────
// Shared view-stack state for the detail drawers (mirrored from panel `.hidden`
// by the observer below). Hoisted to module scope so full-view openers can close
// an open drawer and wait for its router teardown before pushing themselves.
let detailRouterOpen = false; // a detail drawer owns the top view-stack entry

let afterDetailClose: (() => void) | null = null; // deferred full-view open, run once the drawer's router teardown completes

export function closeAllDetailDrawers(): void {
  for (const id of ['#agent-detail', '#room-detail', '#model-detail', '#mcp-detail']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
}

/** Whether a detail drawer currently owns the top view-stack entry. */
export function getDetailRouterOpen(): boolean {
  return detailRouterOpen;
}

/** A deferred full-view open, run once the drawer's route has popped. */
export function getAfterDetailClose(): (() => void) | null {
  return afterDetailClose;
}

export function setAfterDetailClose(fn: (() => void) | null): void {
  afterDetailClose = fn;
}

/** The shared detail backdrop: closes whichever drawer is open, and routes back. */
export function wireDetailOverlay(): void {
  const overlay = $('#detail-overlay');
  if (!overlay) return; // index.html older than this build — graceful no-op
  // .filter(Boolean) does not narrow in TS; the predicate form does, and these
  // four panels are static markup so an absent one is a broken index.html.
  const panels = ['#agent-detail', '#room-detail', '#model-detail', '#mcp-detail']
    .map((sel) => $(sel))
    .filter((el): el is HTMLElement => el !== null);
  const app = $('#app');
  const sync = () => {
    const allHidden = panels.every((p: any) => p.hidden);
    overlay.hidden = allHidden;
    // The three detail panels are nested inside <section id="chat">, which
    // mobile CSS hides (`display: none`) unless `#app.in-room`. Without this
    // class the panels stay invisible while the backdrop (a sibling of #chat)
    // dims the screen — looked like a frozen grey UI when opened from a
    // sidebar tab. Toggling `detail-open` keeps #chat displayed for the
    // panel's lifetime.
    if (app) app.classList.toggle('detail-open', !allHidden);
    // Router: a detail pane is an overlay surface, so the OS/browser back
    // gesture closes it (and, when opened over Manage, returns there). Guarded
    // by detailRouterOpen so the teardown's own .hidden writes don't recurse.
    if (!allHidden && !detailRouterOpen) {
      detailRouterOpen = true;
      openView('detail', () => {
        detailRouterOpen = false;
        closeAllDetailDrawers();
        // A full-view open that closed this drawer waits here for the teardown.
        // Defer a tick so its openView/pushState runs after popstate settles.
        const next = afterDetailClose;
        afterDetailClose = null;
        if (next) queueMicrotask(next);
      });
    } else if (allHidden && detailRouterOpen) {
      detailRouterOpen = false;
      closeView('detail');
    }
  };
  const obs = new MutationObserver(sync);
  for (const p of panels) obs.observe(p, { attributes: true, attributeFilter: ['hidden'] });
  sync();
  // Tap on backdrop closes whichever panel(s) are currently open. The close
  // functions each set their own `.hidden = true`, which fires the observer
  // and hides the backdrop on the next tick.
  overlay.addEventListener('click', () => {
    if (!$('#agent-detail')?.hidden) closeAgentDetail();
    if (!$('#room-detail')?.hidden) closeRoomDetail();
    if (!$('#model-detail')?.hidden) closeModelDetail();
    if (!$('#mcp-detail')?.hidden) closeMcpDetail();
  });
}

export function wireSortToggle(
  btnId: string,
  storageKey: string,
  isOn: () => boolean,
  setOn: (v: boolean) => void,
  rerender: () => void,
) {
  const btn = $(btnId);
  if (!btn) return;
  const sync = () => {
    btn!.classList.toggle('active', isOn());
    btn.setAttribute('aria-pressed', isOn() ? 'true' : 'false');
  };
  sync();
  btn!.addEventListener('click', () => {
    setOn(!isOn());
    sessionStorage.setItem(storageKey, isOn() ? '1' : '0');
    sync();
    rerender();
  });
}

export async function clearBadgeCount() {
  try {
    const db: any = await new Promise((resolve, reject) => {
      const r = indexedDB.open('nanoclaw-badge', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('state');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(0, 'count');
      tx.oncomplete = () => resolve();
    });
  } catch {
    /* ignore */
  }
  if ('clearAppBadge' in navigator) {
    try {
      await navigator.clearAppBadge();
    } catch {}
  }
}
