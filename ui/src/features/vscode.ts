// ── VS Code (Settings) ────────────────────────────────────────────────────────
// Every signed-in user: download the runner extension this install serves, and
// connect it with one click. The link carries this origin, the release key, and the sign-in
// settings from Admin → Sign-in, so nobody types a tenant or app id; the
// extension asks before it trusts the link. Hidden until a package is published.
import { apiJson, authFetch } from '../core/api.js';
import { $ } from '../core/dom.js';
import { showToast, toastError } from '../core/toast.js';

let wired = false;

/** The id the extension is published under by default; an install may package its own (central says which). */
const DEFAULT_EXTENSION_ID = 'nanoclaw.vscode';

/** <publisher>.<name>, as central reads it from the published package (runner-extension.ts). */
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * vscode://<extension id>/connect?server=…, with only the settings that are
 * set. An id that is not <publisher>.<name> would change what the URL points
 * at, so it falls back to the default.
 */
export function connectLink(
  origin: string,
  config: Record<string, unknown>,
  extensionId: unknown = DEFAULT_EXTENSION_ID,
): string {
  const id = typeof extensionId === 'string' && EXTENSION_ID.test(extensionId) ? extensionId : DEFAULT_EXTENSION_ID;
  const q = new URLSearchParams({ server: origin });
  for (const k of ['signIn', 'tenantId', 'appIdUri', 'clientId', 'releaseKey']) {
    const v = config[k];
    if (typeof v === 'string' && v) q.set(k, v);
  }
  return `vscode://${id}/connect?${q}`;
}

export async function renderVsCodeSettings(): Promise<void> {
  const section = $('#settings-vscode');
  if (!section) return;
  let published = false;
  try {
    await apiJson('/api/runners/extension');
    published = true;
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

/**
 * Does this person have the extension on a machine that can answer the link?
 * An older build carries a different extension id, so VS Code fails the link
 * with "not found". Central only knows which build each machine last connected
 * with, so this decides whether to add advice, never whether to open the link.
 */
export function hasCurrentExtension(machines: Array<{ runner?: string }>): boolean {
  return machines.some((m) => {
    const v = /(\d+)\.(\d+)\.(\d+)/.exec(m.runner ?? '');
    return v !== null && (Number(v[1]) > 0 || Number(v[2]) >= 13);
  });
}

/** Open the connect link; where the extension may be missing, say what a "not found" means. */
export async function connect(): Promise<void> {
  let machines: Array<{ runner?: string }> = [];
  try {
    machines = ((await apiJson('/api/runners/mine')) as { machines: Array<{ runner?: string }> }).machines;
  } catch {
    machines = [];
  }
  let extensionId: unknown;
  try {
    extensionId = ((await apiJson('/api/runners/extension')) as { id?: unknown }).id;
  } catch {
    extensionId = undefined;
  }
  try {
    const res = await authFetch('/api/runners/client-config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.location.href = connectLink(
      window.location.origin,
      (await res.json()) as Record<string, unknown>,
      extensionId,
    );
  } catch (err) {
    toastError(err, 'Connect failed');
    return;
  }
  if (!hasCurrentExtension(machines))
    showToast(
      'VS Code says "not found"? Install the extension first: 1. Download, then "Install from VSIX" in VS Code.',
      {
        timeout: 15_000,
      },
    );
}
