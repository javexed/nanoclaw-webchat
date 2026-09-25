// ── Sign-in (Admin) ─────────────────────────────────────────────────────────
// Which ways in this install accepts: Tailscale, OIDC (Microsoft or any
// OpenID Connect provider), a trusted proxy, and the access token — each a
// switch. A switch that needs settings reveals its fields; Save applies them.
// Everything applies at once (routes-signin-settings.ts), and the server
// refuses a change that would lock you out, so this page only shows and asks.
import { apiJson, authFetch } from '../core/api.js';
import { $ } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';
import { showConfirmModal } from './modals.js';
import { signinActive } from './views-state.js';
import { closeView, hideOtherFullViews, openFullView, openView } from './views.js';
import { renderHttpsSettings } from './settings.js';

interface SigninView {
  session: string;
  tailscale: { enabled: boolean; healthy: boolean };
  oidc: {
    enabled: boolean;
    provider: 'microsoft' | 'other';
    tenantId: string;
    issuer: string;
    name: string;
    clientId: string;
    secretSet: boolean;
    redirectUri: string;
  };
  proxy: { enabled: boolean; ips: string; auto: boolean; header: string };
  token: { configured: boolean; enabled: boolean };
  vscode: { appIdUri: string; clientId: string; defaultAppIdUri: string };
}

const CSRF = { 'X-Webchat-CSRF': '1' };
let view: SigninView | null = null;
let provider: 'microsoft' | 'other' = 'microsoft';
let wired = false;

const input = (sel: string) => $<HTMLInputElement>(sel)!;
const toggle = (sel: string) => $<HTMLInputElement>(sel)!;

async function load(): Promise<void> {
  try {
    const r = await authFetch('/api/webchat/signin');
    view = r.ok ? ((await r.json()) as SigninView) : null;
  } catch {
    view = null;
  }
  render();
}

function render(): void {
  const v = view;
  if (!v) return;
  toggle('#si-tailscale').checked = v.tailscale.enabled;
  $('#si-tailscale-status')!.textContent = v.tailscale.enabled && !v.tailscale.healthy ? 'not detected' : '';

  toggle('#si-oidc').checked = v.oidc.enabled;
  $('#si-oidc-status')!.textContent = v.oidc.enabled ? v.oidc.name || (v.oidc.provider === 'microsoft' ? 'Microsoft' : 'SSO') : '';
  if (v.oidc.enabled) provider = v.oidc.provider;
  $('#si-oidc-form')!.hidden = !v.oidc.enabled;
  fillOidc();

  toggle('#si-proxy').checked = v.proxy.enabled;
  $('#si-proxy-status')!.textContent = v.proxy.enabled ? (v.proxy.auto ? 'auto' : v.proxy.ips) : '';
  $('#si-proxy-form')!.hidden = !v.proxy.enabled;
  const form = $('#si-proxy-form')!;
  if (!form.contains(document.activeElement)) {
    input('#si-proxy-ips').value = v.proxy.ips;
    input('#si-proxy-header').value = v.proxy.header === 'x-forwarded-user' ? '' : v.proxy.header;
  }

  $('#si-token-row')!.hidden = !v.token.configured;
  toggle('#si-token').checked = v.token.enabled;
}

function fillOidc(): void {
  const v = view;
  if (!v) return;
  const form = $('#si-oidc-form')!;
  document.querySelectorAll<HTMLElement>('#si-oidc-provider .setting-option').forEach((b) => {
    b.classList.toggle('active', b.dataset.value === provider);
  });
  form.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
    el.hidden = el.dataset.for !== provider;
  });
  $('#si-redirect')!.textContent = v.oidc.redirectUri;
  if (form.contains(document.activeElement)) return; // mid-edit
  const same = v.oidc.enabled && v.oidc.provider === provider;
  input('#si-tenant').value = same ? v.oidc.tenantId : '';
  input('#si-issuer').value = same && provider === 'other' ? v.oidc.issuer : '';
  input('#si-name').value = same ? v.oidc.name : '';
  input('#si-client').value = same ? v.oidc.clientId : '';
  input('#si-secret').value = '';
  input('#si-secret').placeholder = same && v.oidc.secretSet ? '••••••••' : 'optional';
  input('#si-appiduri').value = v.vscode.appIdUri;
  input('#si-appiduri').placeholder = v.vscode.defaultAppIdUri || 'api://<client id>';
  input('#si-vscode-client').value = v.vscode.clientId;
}

/** Send a change; on refusal show why and put the page back as it was. */
async function send(path: string, method: 'PUT' | 'DELETE', body?: unknown): Promise<boolean> {
  try {
    view = (await apiJson(`/api/webchat/signin/${path}`, { method, headers: CSRF, body })) as SigninView;
    render();
    return true;
  } catch (err) {
    toastError(err, 'Not changed');
    render();
    return false;
  }
}

async function turnOff(path: 'oidc' | 'proxy', label: string): Promise<void> {
  const ok = await showConfirmModal({ title: `Turn off ${label}?`, confirmLabel: 'Turn off', destructive: true });
  if (!ok) return render();
  await send(path, 'DELETE');
}

async function saveOidc(): Promise<void> {
  const body: Record<string, unknown> = {
    provider,
    clientId: input('#si-client').value.trim(),
    ...(provider === 'microsoft'
      ? { tenant: input('#si-tenant').value.trim() }
      : { issuer: input('#si-issuer').value.trim(), name: input('#si-name').value.trim() }),
  };
  const secret = input('#si-secret').value.trim();
  if (secret) body.clientSecret = secret;
  (document.activeElement as HTMLElement | null)?.blur();
  if (!(await send('oidc', 'PUT', body))) return;
  if (provider === 'microsoft') {
    const appIdUri = input('#si-appiduri').value.trim();
    const clientId = input('#si-vscode-client').value.trim();
    if (appIdUri !== view?.vscode.appIdUri || clientId !== view?.vscode.clientId) {
      try {
        await apiJson('/api/runners/client-config', { method: 'PUT', headers: CSRF, body: { appIdUri, clientId } });
      } catch (err) {
        toastError(err, 'VS Code settings not saved');
      }
      await load();
    }
  }
  showToast('Saved', { kind: 'success' });
}

function wire(): void {
  if (wired) return;
  wired = true;
  toggle('#si-tailscale').addEventListener('change', (e) => {
    void send('tailscale', 'PUT', { enabled: (e.target as HTMLInputElement).checked });
  });
  toggle('#si-token').addEventListener('change', (e) => {
    void send('token', 'PUT', { enabled: (e.target as HTMLInputElement).checked });
  });
  toggle('#si-oidc').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (!on && view?.oidc.enabled) return void turnOff('oidc', 'OIDC');
    $('#si-oidc-form')!.hidden = !on;
    if (on) input(provider === 'microsoft' ? '#si-tenant' : '#si-issuer').focus();
  });
  toggle('#si-proxy').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (!on && view?.proxy.enabled) return void turnOff('proxy', 'the trusted proxy');
    $('#si-proxy-form')!.hidden = !on;
    if (on) input('#si-proxy-ips').focus();
  });
  $('#si-oidc-provider')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('.setting-option')?.dataset.value;
    if (v !== 'microsoft' && v !== 'other') return;
    provider = v;
    (document.activeElement as HTMLElement | null)?.blur();
    fillOidc();
  });
  $('#si-oidc-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveOidc();
  });
  $('#si-proxy-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    void send('proxy', 'PUT', { ips: input('#si-proxy-ips').value, header: input('#si-proxy-header').value });
  });
  $('#si-redirect-copy')!.addEventListener('click', () => {
    const uri = view?.oidc.redirectUri ?? '';
    void navigator.clipboard?.writeText(uri).then(
      () => showToast('Copied', { kind: 'success' }),
      () => showToast(uri),
    );
  });
}

function openSigninPage(): void {
  openFullView(() => {
    hideOtherFullViews('signin');
    signinActive.value = true;
    $('#chat')!.hidden = true;
    $('#signin-page')!.hidden = false;
    $('#overflow-btn')?.classList.add('active');
    $('#app')!.classList.add('in-dashboard');
    $('#app')!.classList.remove('in-room');
    wire();
    void load();
    void renderHttpsSettings();
    openView('signin', teardownSigninPage);
  });
}

function teardownSigninPage(): void {
  signinActive.value = false;
  $('#chat')!.hidden = false;
  $('#signin-page')!.hidden = true;
  $('#overflow-btn')?.classList.remove('active');
  $('#app')!.classList.remove('in-dashboard');
}

export function toggleSigninPage(): void {
  if (signinActive.value) closeView('signin');
  else openSigninPage();
}
