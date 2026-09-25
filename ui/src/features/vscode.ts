// ── VS Code (Settings) ────────────────────────────────────────────────────────
// Every signed-in user: download the runner extension this install serves, and
// connect it with one click. The link carries this origin plus the sign-in
// settings from Admin → Sign-in, so nobody types a tenant or app id; the
// extension asks before it trusts the link. Hidden until a package is published.
import { authFetch } from '../core/api.js';
import { $ } from '../core/dom.js';
import { toastError } from '../core/toast.js';

let wired = false;

/** vscode://nanoclaw.vscode/connect?server=…, with only the settings that are set. */
export function connectLink(origin: string, config: Record<string, unknown>): string {
  const q = new URLSearchParams({ server: origin });
  for (const k of ['signIn', 'tenantId', 'appIdUri', 'clientId']) {
    const v = config[k];
    if (typeof v === 'string' && v) q.set(k, v);
  }
  return `vscode://nanoclaw.vscode/connect?${q}`;
}

export async function renderVsCodeSettings(): Promise<void> {
  const section = $('#settings-vscode');
  if (!section) return;
  let published = false;
  try {
    published = (await authFetch('/api/runners/extension')).ok;
  } catch {
    published = false;
  }
  section.hidden = !published;
  if (!published || wired) return;
  wired = true;
  $('#vscode-download')?.addEventListener('click', () => void download());
  $('#vscode-connect')?.addEventListener('click', () => void connect());
}

export async function download(): Promise<void> {
  try {
    const res = await authFetch('/api/runners/extension/download');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'nanoclaw.vsix';
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    toastError(err, 'Download failed');
  }
}

export async function connect(): Promise<void> {
  try {
    const res = await authFetch('/api/runners/client-config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.location.href = connectLink(window.location.origin, (await res.json()) as Record<string, unknown>);
  } catch (err) {
    toastError(err, 'Connect failed');
  }
}
