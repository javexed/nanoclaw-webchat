/**
 * Which requests may reach the webchat server at all, before any auth runs.
 *
 * Host: a page on another site can re-point its own domain at this server
 * (DNS rebinding) and then talk to it as same-origin. On a localhost or
 * tailnet install that inherits ambient identity, so the Host header must
 * name this server: an IP literal, a loopback name, this machine's name, its
 * Tailscale name, WEBCHAT_PUBLIC_URL's host, or WEBCHAT_ALLOWED_HOSTS
 * (comma-separated; `*` turns the check off). A request through the
 * configured trusted proxy is accepted as it is: its Host is the proxy's own.
 *
 * Origin: a browser WebSocket carries the page's Origin, and a cross-site
 * page must not open one with the visitor's ambient identity. Clients that
 * are not browsers (the VS Code extension) send none.
 */
import type { IncomingMessage } from 'http';
import net from 'net';
import os from 'os';

import { viaTrustedProxy } from './auth.js';
import { getTailscaleServeState } from './tailscale-serve.js';

const TAILNET_REFRESH_MS = 10 * 60_000;
let tailnet: { names: string[]; at: number } | null = null;
let tailnetLoading: Promise<void> | null = null;

function loadTailnetNames(): Promise<void> {
  tailnetLoading ??= getTailscaleServeState()
    .then((s) => {
      const host = s.url ? new URL(s.url).hostname.toLowerCase() : '';
      tailnet = { names: host ? [host, host.split('.')[0]] : [], at: Date.now() };
    })
    .catch(() => {
      tailnet = { names: [], at: Date.now() };
    })
    .finally(() => {
      tailnetLoading = null;
    });
  return tailnetLoading;
}

const listed = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** The Host header's name is one of this server's. */
export async function hostAllowed(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const extra = listed(env.WEBCHAT_ALLOWED_HOSTS);
  if (extra.includes('*') || viaTrustedProxy(req)) return true;
  const host = hostnameOf(String(req.headers.host ?? ''));
  if (!host) return false;
  if (net.isIP(host)) return true; // rebinding needs a name the attacker controls
  const machine = os.hostname().toLowerCase();
  const fixed = ['localhost', machine, `${machine}.local`, ...extra];
  const pub = (env.WEBCHAT_PUBLIC_URL || '').trim();
  if (pub) {
    try {
      fixed.push(new URL(pub).hostname.toLowerCase());
    } catch {
      /* malformed; ignored */
    }
  }
  if (fixed.includes(host) || host.endsWith('.localhost')) return true;
  if (!tailnet || Date.now() - tailnet.at > TAILNET_REFRESH_MS) await loadTailnetNames();
  return tailnet?.names.includes(host) ?? false;
}

/** No Origin (not a browser), or one whose host is the host the request was sent to. */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const forwarded = String(req.headers['x-forwarded-host'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return originHost === String(req.headers.host ?? '').toLowerCase() || (!!forwarded && originHost === forwarded);
}

export function __resetRequestGuardForTest(): void {
  tailnet = null;
  tailnetLoading = null;
}
