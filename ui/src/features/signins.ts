// ── Sign-ins (Settings → Sign-ins) ─────────────────────────────────────────
// How YOU sign in, and linking another sign-in to the same account: the
// install's single sign-on (a round trip through the provider), or this device's
// Tailscale identity. The server decides what is offered (can.*) and which
// identity stays the account (the older one); this only shows it.
import { authFetch } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';
import { showConfirmModal } from './modals.js';

interface SignIn {
  id: string;
  kind: 'tailscale' | 'oidc';
  label: string;
  primary: boolean;
}
interface SigninsView {
  person: boolean;
  viaSession: boolean;
  signedInAs: string;
  signIns: SignIn[];
  oidcName: string;
  can: { linkOidc: boolean; linkTailscale: string | null };
}

let wired = false;

export async function renderSignins(): Promise<void> {
  const section = $('#settings-signins');
  if (!section) return;
  let view: SigninsView | null = null;
  try {
    const r = await authFetch('/api/account/sign-ins');
    if (r.ok) view = (await r.json()) as SigninsView;
  } catch {
    view = null;
  }
  section.hidden = !view || !view.person;
  if (!view || !view.person) return;
  wire();

  const list = $('#signins-list')!;
  list.innerHTML = view.signIns
    .map((s) => {
      const here = s.id === view!.signedInAs ? ' · this sign-in' : '';
      const unlink = s.primary
        ? ''
        : `<button class="btn btn-ghost signins-unlink" type="button" data-alias="${esc(s.id)}">Unlink</button>`;
      return `<li class="signins-row"><div class="signins-text"><span class="signins-label" title="${esc(s.label)}">${esc(s.label)}</span><span class="signins-note">${s.kind === 'tailscale' ? 'Tailscale' : esc(view!.oidcName)} · ${s.primary ? 'account' : 'linked'}${here}</span></div>${unlink}</li>`;
    })
    .join('');

  const ms = $<HTMLAnchorElement>('#signins-link-microsoft')!;
  ms.hidden = !view.can.linkOidc;
  ms.textContent = `Link ${view.oidcName}`;
  const ts = $<HTMLButtonElement>('#signins-link-tailscale')!;
  ts.hidden = !view.can.linkTailscale;
  if (view.can.linkTailscale) {
    ts.textContent = `Link Tailscale (${view.can.linkTailscale})`;
    ts.dataset.login = view.can.linkTailscale;
  }
  $('#signins-signout')!.hidden = !view.viaSession;
}

function wire(): void {
  if (wired) return;
  wired = true;
  $('#signins-list')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.signins-unlink');
    if (btn?.dataset.alias) void unlink(btn.dataset.alias);
  });
  $('#signins-link-tailscale')!.addEventListener('click', () => void linkTailscale());
  $('#signins-signout')!.addEventListener('click', () => void signOut());
}

async function linkTailscale(): Promise<void> {
  try {
    const r = await authFetch('/api/account/link/tailscale', { method: 'POST', headers: { 'X-Webchat-CSRF': '1' } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    showToast('Sign-in linked', { kind: 'success' });
  } catch (err) {
    toastError(err, 'Could not link');
  }
  await renderSignins();
}

async function unlink(alias: string): Promise<void> {
  const ok = await showConfirmModal({
    title: 'Unlink this sign-in?',
    body: 'It becomes a separate account again, with none of this account’s roles or secrets.',
    confirmLabel: 'Unlink',
    destructive: true,
  });
  if (!ok) return;
  try {
    const r = await authFetch(`/api/account/links/${encodeURIComponent(alias)}`, {
      method: 'DELETE',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  } catch (err) {
    toastError(err, 'Could not unlink');
  }
  await renderSignins();
}

async function signOut(): Promise<void> {
  try {
    await authFetch('/auth/logout', { method: 'POST', headers: { 'X-Webchat-CSRF': '1' } });
  } finally {
    location.replace('/');
  }
}

/**
 * The provider round trip lands back on /?signin=… or /?signin_error=….
 * Show the outcome, then drop the parameter so a reload does not repeat it.
 */
export function consumeSigninResult(): void {
  const params = new URLSearchParams(location.search);
  const error = params.get('signin_error');
  const done = params.get('signin');
  if (!error && !done) return;
  params.delete('signin_error');
  params.delete('signin');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  if (error) {
    const el = $('#login-error');
    if (el) {
      el.textContent = error;
      el.hidden = false;
    }
    showToast(error, { kind: 'error', timeout: 9000 });
  } else if (done === 'linked') {
    showToast('Sign-in linked', { kind: 'success' });
  }
}
