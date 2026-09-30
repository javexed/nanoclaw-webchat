// ── Global listeners ─────────────────────────────────────────────────────────
// Document- and window-level wiring that belongs to no single panel. In src/, not
// core/: it calls into features, and core must not import features.
// ONE EXPORTED FUNCTION PER BLOCK, each called from its own place in boot order;
// merging them reorders listener registration (docs/webchat/boot-order-guard.md).

import { $ } from './core/dom.js';
import { state } from './core/state.js';
import { connect, diagnoseConnection } from './core/ws.js';
import { fetchApprovals } from './features/approvals.js';
import { closeView, openView, switchManageTab } from './features/views.js';
import { closeRoomDetail, joinRoom } from './features/rooms.js';
import { closeAgentDetail } from './features/agents.js';
import { closeMcpDetail } from './features/mcp.js';
import { closeModelDetail } from './features/models.js';
import { refreshPlatformTokenIfHinted } from './core/platform-token.js';

/**
 * On returning to a visible tab: reconnect if the socket dropped, otherwise
 * refresh approvals and advance the read marker for the open room.
 */
export function wireVisibilityRefresh(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // If the server said our platform token had gone stale, renew it now — before
    // the first action of this session goes out on the weaker fallback path.
    refreshPlatformTokenIfHinted();
    if (state.ws && state.ws.readyState !== WebSocket.OPEN) {
      connect();
    } else {
      fetchApprovals();
      // Returning to a focused tab with a room open means its messages are now
      // seen — advance the server marker (and sync other devices). The reconnect
      // path already re-joins (which reads) when the socket was actually down.
      // `?.`: this branch is also reached when state.ws is null.
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
}

/**
 * The manage-view tab strip. Static markup, so this binds once at boot.
 */
export function wireManageTabs(): void {
  document.querySelectorAll<HTMLElement>('.manage-tab').forEach((t: any) => {
    t.addEventListener('click', () => switchManageTab(t.dataset.mtab));
  });
}

/** Service-worker registration, update polling and the reload banner (app-shell, not any panel). */
export function wireServiceWorker(hasStagedFile: () => boolean): void {
  if ('serviceWorker' in navigator) {
    let swReg: ServiceWorkerRegistration | null = null;
    const checkForUpdate = () => swReg && swReg.update().catch(() => {});
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // reg can be undefined in environments that block service workers
      // (automation, some embedded webviews).
      if (!reg) return;
      swReg = reg;
      // Check now, then every 60s. The interval freezes while the PWA is
      // backgrounded (iOS), so the foreground re-check below catches relaunches.
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
      // A predicate, not an import: composition-root.ts imports this module.
      const staged = hasStagedFile();
      if (hasDraft || staged) return false;
      // On the login screen there's no work to lose (unless a token is mid-entry),
      // and a stale shell there would otherwise sit versions behind.
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
        // Mobile tabs are visible whenever used, and iOS freezes JS in the
        // background, so the hidden-tab reload may never fire: offer a banner too.
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
// Blocks whose subject element belongs to the shell rather than to any panel:
// #messages, #message-input, #mobile-back.

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

/** Mobile back affordance: leaves the in-room layout. */
export function wireMobileBack(): void {
  $('#mobile-back')?.addEventListener('click', () => {
    $('#app')?.classList.remove('in-room');
  });
}

/** Composer paste: multi-line text is wrapped in a code fence so it renders verbatim
 * (no Markdown or mention decoration); files fall through to the document listener. */
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

// ── Detail-panel backdrop (mobile-only via CSS) ─────────────────────────────
// Drawer view-stack state, mirrored from panel `.hidden` by the observer below.
// Module scope so full-view openers can close a drawer and wait for its router
// teardown; views.ts reads it through deps relayed by composition-root.ts.
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
    // The detail panels sit inside #chat, which mobile CSS hides unless
    // `#app.in-room`; `detail-open` keeps #chat displayed while a panel is open,
    // or the backdrop dims the screen over an invisible panel.
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
