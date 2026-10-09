// ── An expired sign-in at the front door ─────────────────────────────────
// Behind a sign-in front door (App Service EasyAuth, an identity-aware proxy)
// the session can end while the tab is open. From then on every request is
// redirected to the login page, which fetch and the WebSocket only ever see
// as a network error: the app said the server was unreachable and kept
// reconnecting, and only a hard refresh got anyone back in.
//
// Asking without following redirects tells the two apart: a redirect is the
// front door wanting a sign-in, not a server that is down. Then one forced
// platform-token refresh (it renews what it can); if the session is still
// gone, the banner says so with a way back — and goes there itself when
// nothing would be lost (tab in view, nothing typed, nothing attached).
import { $ } from './dom.js';
import { refreshPlatformToken } from './platform-token.js';

/** Remembered across the sign-in round trip, so a sign-in that does not take cannot loop. */
const AUTO_KEY = 'nanoclaw-reauth-at';
const AUTO_EVERY_MS = 2 * 60_000;

let shown = false;
let draftPending: () => boolean = () => false;

/** What else counts as unsent work besides the message box (attachments). */
export function provideDraftCheck(fn: () => boolean): void {
  draftPending = fn;
}

/** True while the expired-session banner is up: the reconnect loop must not paper over it. */
export function sessionExpiredShown(): boolean {
  return shown;
}

/** The socket is back: the session was fine after all, or the sign-in happened elsewhere. */
export function clearSessionExpired(): void {
  shown = false;
}

/** Does the front door redirect us to a sign-in? Any failure to ask says no: that is the ordinary unreachable path. */
export async function frontDoorWantsSignIn(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/check', { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
    return res.type === 'opaqueredirect';
  } catch {
    return false;
  }
}

/**
 * Check, and handle, an expired front-door session. Returns true when it is
 * expired and the banner (or the sign-in) has taken over.
 */
export async function checkSessionExpired(): Promise<boolean> {
  if (!(await frontDoorWantsSignIn())) return false;
  await refreshPlatformToken(true);
  if (!(await frontDoorWantsSignIn())) return false;
  showSignInAgain();
  return true;
}

/**
 * When the stored time of the last automatic sign-in is junk (a hand-edited or
 * truncated value), Number() gives NaN, and `now - NaN > limit` is false for
 * ever: the tab would never go to the sign-in by itself again. Treat it as never.
 */
export function lastAutoSignIn(stored: string | null): number {
  const n = Number(stored ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Go to the sign-in without a click: only in view, with nothing unsent, and not twice in a row. */
export function autoSignInDue(o: { visible: boolean; draft: boolean; now: number; last: number }): boolean {
  return o.visible && !o.draft && o.now - o.last > AUTO_EVERY_MS;
}

function hasDraft(): boolean {
  const input = $<HTMLTextAreaElement>('#message-input');
  return !!input?.value.trim() || draftPending();
}

function showSignInAgain(): void {
  shown = true;
  const banner = $('#connection-banner');
  if (banner) {
    banner.replaceChildren(document.createTextNode('Your sign-in expired.'));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'banner-action';
    btn.textContent = 'Sign in again';
    btn.addEventListener('click', () => signInAgain());
    banner.appendChild(btn);
    banner.classList.add('visible');
  }
  let last = 0;
  try {
    last = lastAutoSignIn(sessionStorage.getItem(AUTO_KEY));
  } catch {
    /* storage blocked: fall through to the button */
  }
  if (autoSignInDue({ visible: document.visibilityState === 'visible', draft: hasDraft(), now: Date.now(), last }))
    signInAgain();
}

/** A page load reaches the server (sw.js navigate), so the front door can send it to the sign-in. */
function signInAgain(): void {
  try {
    sessionStorage.setItem(AUTO_KEY, String(Date.now()));
  } catch {
    /* fine: the throttle just does not survive */
  }
  location.reload();
}
