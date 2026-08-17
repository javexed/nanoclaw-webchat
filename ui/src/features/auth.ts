// ── Auth & onboarding ────────────────────────────────────────────────────────
// The login screen, the bearer-token path, and the first-run onboarding gate
// that decides whether the wizard opens.
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { bearerConfirmTimer } from './settings-state.js';
import { permsCreateChannelTouched } from './perms-list-state.js';
import { showToast, toastError } from '../core/toast.js';
import { apiJson, authFetch, getAuthToken, setAuthToken } from '../core/api.js';
import { state } from '../core/state.js';
import { connect } from '../core/ws.js';
import { loadLearningMaster } from './learn.js';
import { rememberServerAuthHint } from './members.js';
import { enableWebPush, renderAccessSettings } from './settings.js';
import { initSttFeature, loadTtsConfig } from './voice.js';
import { maybeAutoOpenWizard } from './wizard.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideAuthDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface AuthDeps {
  permsRefreshCreateUI: () => any;
}

const deps = {} as AuthDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideAuthDeps(provided: Partial<AuthDeps>): void {
  Object.assign(deps, provided);
}

export async function checkAuth() {
  // Localhost doesn't need auth
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'ok';
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers = getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {};
      const res = await fetch('/api/auth/check', { headers: headers as HeadersInit, cache: 'no-store' });
      if (res.ok) return 'ok';
      // A real verdict from the server — stop retrying, show the login screen.
      if (res.status === 401 || res.status === 403) return 'unauthenticated';
      // Anything else (502 while the host restarts, other 5xx) is worth a retry.
    } catch {
      // Network error — retry.
    }
    if (!navigator.onLine) break; // no point spinning with no network
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return 'unreachable';
}

export async function reprobeAuthWhenOnline() {
  if (!navigator.onLine) {
    await new Promise((r) => window.addEventListener('online', r, { once: true }));
  }
  const verdict = await checkAuth();
  if (verdict !== 'unauthenticated') return; // 'ok', or still unreachable — leave the banner to it
  $('#login-screen')!.hidden = false;
  $('#app')!.hidden = true;
  void applyLoginHint();
}

export function enterAuthedApp() {
  $('#login-screen')!.hidden = true;
  $('#app')!.hidden = false;
  connect();
  // Cache the server's auth mode so the connection-lost banner can suggest
  // Tailscale later, even if the network drops (authed users skip the login
  // screen where applyLoginHint would otherwise cache it).
  void cacheAuthHint();
  // Auto-subscribe to push if the user has already granted permission.
  // Browsers require a user gesture for `Notification.requestPermission()`,
  // so a fresh install will still need one flip of the Settings toggle to
  // trigger the prompt — but after that, every reload re-subscribes silently.
  if (state.settings?.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    enableWebPush();
  }
  // First-run: owner/global-admin sees the setup wizard once until finished.
  void maybeAutoOpenWizard();
  // Nudge to retire the shared bearer token once a stronger identity is live.
  void maybeSuggestBearerRetire();
  // Voice dictation: reveal the mic when the server has an STT backend.
  void initSttFeature();
  // Learning master: gate the 🎓 controls workspace-wide.
  void loadLearningMaster();
  // Probe whether server-backed TTS is available so agent bubbles can offer a
  // play control (falls back to the browser's Web Speech voices when off).
  void loadTtsConfig();
}

let bearerRetireWired = false;

async function maybeSuggestBearerRetire() {
  const banner = $('#bearer-retire-banner');
  if (!banner) return;
  if (localStorage.getItem('nanoclaw-bearer-retire-dismissed') === '1') return;
  let info: any = null;
  try {
    const r = await authFetch('/api/webchat/auth'); // owner/global-admin only (403 otherwise)
    if (r.ok) info = await r.json();
  } catch {
    info = null;
  }
  // Only when the token is still live, an alternative can authenticate, AND this
  // very session is non-bearer — otherwise the retire endpoint would refuse it.
  if (!info || !info.bearerActive || !info.canDisableBearer || info.sessionSource === 'bearer') return;

  if (!bearerRetireWired) {
    bearerRetireWired = true;
    $('#bearer-retire-disable')?.addEventListener('click', () => retireBearerFromBanner());
    $('#bearer-retire-dismiss')?.addEventListener('click', () => {
      localStorage.setItem('nanoclaw-bearer-retire-dismissed', '1');
      banner.hidden = true;
    });
  }
  banner.hidden = false;
}

async function retireBearerFromBanner() {
  const banner = $('#bearer-retire-banner');
  const btn = ($('#bearer-retire-disable')!) as HTMLInputElement;
  if (btn) (btn as HTMLInputElement).disabled = true;
  try {
    const r = await authFetch('/api/webchat/auth/bearer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ active: false }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      showToast('Bearer token disabled — access is via Tailscale/SSO', { kind: 'success' });
      localStorage.setItem('nanoclaw-bearer-retire-dismissed', '1');
      if (banner) banner.hidden = true;
    } else {
      showToast(data.error || 'Could not disable the bearer token', { kind: 'error', timeout: 8000 });
    }
  } catch {
    showToast('Connection failed', { kind: 'error' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cacheAuthHint() {
  try {
    const r = await fetch('/api/auth/info');
    if (r.ok) rememberServerAuthHint((await r.json()).methods);
  } catch {}
}

export async function applyLoginHint() {
  let info;
  try {
    const r = await fetch('/api/auth/info');
    if (!r.ok) return;
    info = await r.json();
  } catch {
    return;
  }
  const subtitle = $('.login-subtitle')!;
  subtitle.hidden = false; // default visible; a branch below may hide it
  const m = info.methods || {};
  rememberServerAuthHint(m);

  // Hide the token entry path when the server has no bearer method
  // configured — a tailscale-only or proxy-only deployment shouldn't show
  // a token field that can never work.
  if (!m.bearer) {
    $('#login-form')!.hidden = true;
  }

  if (m.tailscale && info.tailscaleHealthy) {
    // The common case: tailscale is set up on the server; the user just
    // needs Tailscale running on the device they're reading this on.
    subtitle.textContent =
      'Tailscale should sign you in automatically — make sure it’s running on this device, then refresh.';
  } else if (m.tailscale && !info.tailscaleHealthy) {
    // The rare case: server-side Tailscale is actually down — no prose, the token
    // box speaks for itself.
    subtitle.hidden = true;
  } else if (m.proxy && !m.bearer) {
    subtitle.innerHTML =
      "Couldn't sign you in — your reverse proxy didn't pass an identity through. " +
      'Try refreshing, or ask whoever sent you the link.';
  } else if (m.bearer) {
    subtitle.textContent = 'Enter the access token you were given below.';
  } else {
    subtitle.textContent = "This server isn't ready to sign anyone in yet. Whoever installed it needs to finish setup.";
    $('#login-form')!.hidden = true;
  }
}

export async function toggleBearerToken(wantActive?: any) {
  const btn = ($('#access-bearer-btn')!) as HTMLInputElement;
  const hint = $('#access-bearer-hint')!;
  // Two-step confirm for the destructive direction (disabling auth).
  if (!wantActive && btn.dataset.confirming !== '1') {
    btn.dataset.confirming = '1';
    const restore = btn.textContent;
    btn.textContent = 'Click again to disable';
    bearerConfirmTimer.value = setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = restore;
    }, 4000);
    return;
  }
  clearTimeout(bearerConfirmTimer.value ?? undefined);
  btn.dataset.confirming = '';
  (btn as HTMLInputElement).disabled = true;
  try {
    const r = await authFetch('/api/webchat/auth/bearer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ active: wantActive }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showToast(data.error || 'Could not change the bearer setting', { kind: 'error', timeout: 8000 });
      if (data.error) {
        hint.hidden = false;
        hint.textContent = data.error;
      }
    } else {
      showToast(wantActive ? 'Bearer token re-enabled' : 'Bearer token disabled — access is via Tailscale/SSO', {
        kind: 'success',
      });
    }
  } catch {
    showToast('Connection failed', { kind: 'error' });
  } finally {
    btn.disabled = false;
    renderAccessSettings();
  }
}

let serverAuthMethods: any = null;

export async function ensureServerAuthMethods() {
  if (serverAuthMethods) return serverAuthMethods;
  try {
    const r = await fetch('/api/auth/info');
    if (r.ok) serverAuthMethods = (await r.json()).methods || null;
  } catch {}
  return serverAuthMethods;
}

export function applyCreateAuthDefault() {
  const m = serverAuthMethods || {};
  // Don't clobber a prefix the admin picked by hand (the change listener marks
  // it touched); this only steers the untouched default.
  if (!permsCreateChannelTouched.value) {
    $<HTMLInputElement>('#perms-create-channel')!.value = m.tailscale ? 'webchat:tailscale' : 'webchat';
  }
  const hint = $('#perms-create-method-hint')!;
  if (m.tailscale) {
    hint.textContent = 'This install signs people in via Tailscale — they appear as webchat:tailscale:<email>.';
  } else if (m.proxy) {
    hint.textContent =
      'This install signs people in via SSO / reverse proxy (e.g. Entra ID) — they appear as webchat:<email>.';
  } else if (m.bearer) {
    hint.textContent =
      'This install uses a shared bearer token — per-user ids only differ when a proxy or Tailscale also fronts it.';
  } else {
    hint.textContent = '';
  }
  deps.permsRefreshCreateUI();
}


// ── Panel wiring ─────────────────────────────────────────────────────────────
// The sign-in surface: the login form submit, its error line and the token field.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireAuthPanel() at the exact line the
// first block occupied, so execution order is unchanged.

/** The login form's only error surface — guarded once instead of at four sites. */
function showLoginError(message: string): void {
  const el = $('#login-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

export function wireAuthPanel(): void {
  const tokenInput = $<HTMLInputElement>('#login-token');
  $<HTMLFormElement>('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = tokenInput?.value.trim() ?? '';
    if (!token) return;
    // Test the token
    try {
      const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        setAuthToken(token);
        sessionStorage.setItem('nanoclaw-token', token);
        enterAuthedApp();
      } else {
        showLoginError('Invalid token');
      }
    } catch {
      showLoginError('Connection failed');
    }
  });




}
