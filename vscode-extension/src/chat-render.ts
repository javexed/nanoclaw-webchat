// Pure pieces of the chat view — no vscode import, so they are unit-tested
// directly: the agent's activity line, the card for a file message, and the
// URL an authenticated call to central goes to.
import { escapeHtml } from './markdown.js';

export interface FileMeta {
  url: string;
  filename: string;
  mime: string;
  size: number;
}

/**
 * One line for the working indicator, from central's `chat.status` frame
 * (the PWA's thinking bubble). Null means "hide it": the turn is over.
 */
export function statusLine(event: string, text: string | null, detail: string | null): string | null {
  const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (event) {
    case 'start':
      return 'Working…';
    case 'tool': {
      const what = text ? clip(text, 40) : 'a tool';
      return detail ? `${what}: ${clip(detail.replace(/\s+/g, ' '))}` : `Running ${what}…`;
    }
    case 'progress':
    case 'reasoning':
      return text ? clip(text.replace(/\s+/g, ' ')) : 'Working…';
    case 'stalled':
      return 'The agent has gone quiet — it may be stuck.';
    case 'done':
      return null;
    default:
      return text ? clip(text) : 'Working…';
  }
}

export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A file message: name, size, and Open / Save buttons the webview wires by message id. */
export function fileCard(id: string, meta: FileMeta | null | undefined): string {
  if (!meta || typeof meta.url !== 'string' || typeof meta.filename !== 'string') {
    return '<p><em>[file unavailable]</em></p>';
  }
  const icon = meta.mime?.startsWith('image/') ? '🖼' : '📎';
  return (
    `<div class="filecard"><span class="fname" title="${escapeHtml(meta.mime || '')}">${icon} ${escapeHtml(meta.filename)}</span>` +
    `<span class="fsize">${escapeHtml(humanSize(meta.size))}</span>` +
    `<button class="secondary" data-file="open" data-id="${escapeHtml(id)}">Open</button>` +
    `<button class="secondary" data-file="save" data-id="${escapeHtml(id)}">Save…</button></div>`
  );
}

/**
 * An absolute URL on central for an API path it handed us (`/api/files/…`).
 * Only same-origin paths are accepted: a message cannot steer the bearer token
 * to another host.
 */
export function apiUrl(serverUrl: string, apiPath: string): string {
  if (!apiPath.startsWith('/api/') || apiPath.includes('..') || /^\/\//.test(apiPath)) {
    throw new Error(`refusing a non-API path: ${apiPath.slice(0, 80)}`);
  }
  const u = new URL(serverUrl);
  const q = apiPath.indexOf('?');
  u.pathname = q >= 0 ? apiPath.slice(0, q) : apiPath;
  u.search = q >= 0 ? apiPath.slice(q) : '';
  u.hash = '';
  return u.toString();
}

/** Where central takes an upload for a room (server.ts RE_UPLOAD) — the PWA's own endpoint. */
export function uploadPath(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/upload`;
}

/** A filename safe to create on the developer's disk (cache or save dialog default). */
export function safeLocalName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 180) || 'file';
}
