/**
 * NanoClaw's side of the gateway, on 127.0.0.1 only. Caddy asks it about
 * every request to an app (forward_auth, /gateway/check) and fetches the
 * public key apps verify identities with (/.nanoclaw/jwks.json). Every request
 * must carry the gateway secret, so nothing else on the host can mint
 * identities through it.
 *
 * The check answers 200 with the signed identity, or 401/403 with a short
 * text. It never redirects: there is no sign-in flow here (the route's edge
 * signs people in), so there is no return URL to abuse. It reads no body.
 */
import { timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

import { audit } from '../../../audit.js';
import { log } from '../../../log.js';
import type { AppRoute } from '../routes.js';
import { canOpen, type OpenDeps } from './access.js';
import { IDENTITY_TTL_S, jwks, signIdentity } from './keys.js';
import { publishingRoute, type GatewayIdentity, type PublishedApp, type RouteKind } from './publishing.js';

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

function secretOk(req: IncomingMessage, secret: string): boolean {
  const got = Buffer.from(header(req, 'x-nanoclaw-gateway-secret'));
  const want = Buffer.from(secret);
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** Header values are Latin-1; anything outside printable ASCII travels percent-encoded. */
const headerSafe = (v: string): string => (/^[\x20-\x7e]*$/.test(v) ? v : encodeURIComponent(v));

/** The sign-in name apps see: the NanoClaw id without its `webchat:` prefix. */
const signInName = (userId: string): string => userId.replace(/^webchat:(tailscale:)?/, '');

/** What an app is told about the person. */
export function identityHeaders(
  hostname: string,
  kind: RouteKind,
  who: GatewayIdentity,
  now = Date.now(),
): Record<string, string> {
  return {
    'X-NanoClaw-User': headerSafe(signInName(who.userId)),
    'X-NanoClaw-Name': headerSafe(who.displayName),
    'X-NanoClaw-Auth': kind,
    'X-NanoClaw-Identity': signIdentity({ sub: who.userId, name: who.displayName, amr: kind }, hostname, now),
  };
}

// One refusal line per person, app and reason a minute: a page with forty assets must not write forty.
const deniedAt = new Map<string, number>();
function auditDenied(route: AppRoute, who: string, reason: string): void {
  const key = `${route.id}|${who}|${reason}`;
  const now = Date.now();
  if (now - (deniedAt.get(key) ?? 0) < 60_000) return;
  if (deniedAt.size > 5000) deniedAt.clear();
  deniedAt.set(key, now);
  audit({
    type: 'workload-gateway.denied',
    actor: who ? `human:${who}` : undefined,
    effect: 'deny',
    reason,
    detail: { route: route.id, app: route.app, kind: route.kind },
  });
}

export interface InternalDeps extends OpenDeps {
  getRoute(id: string): Promise<AppRoute | null>;
  /** The route is live: its workload runs and its publishing route is on. */
  isLive(route: AppRoute): Promise<boolean>;
  /** Someone was let in (opened.ts records it, throttled). Must not throw. */
  opened?(route: AppRoute): Promise<unknown>;
  /** A request for the route's stack: counts as use, wakes it if asleep (sleep.ts). */
  waking?(route: AppRoute): Promise<'running' | 'starting' | 'failed'>;
}

/** Shown while a sleeping stack starts (sleep.ts); reloads every 3 s. */
const WAKING_PAGE =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Starting</title>' +
  '<p style="font:16px system-ui,sans-serif;margin:3em auto;max-width:20em;text-align:center">Starting…</p>';
/** Shown when a sleeping stack did not start; no reload (the next try is a few minutes later). */
const WAKE_FAILED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Could not start</title>' +
  '<p style="font:16px system-ui,sans-serif;margin:3em auto;max-width:24em;text-align:center">' +
  'This app could not start. The agent that runs it has been told; try again in a few minutes.</p>';

const hostOf = (v: string): string => v.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

async function check(req: IncomingMessage, res: ServerResponse, route: AppRoute, deps: InternalDeps): Promise<void> {
  const kind = publishingRoute(route.kind);
  if (!kind || !(await kind.enabled())) return send(res, 503, 'This app’s publishing route is off.');
  const hostname = await kind.hostnameFor(route.app);
  // Caddy routes by hostname (or, on the port route, by port); a check for another host is not one Caddy makes.
  if (!hostname || hostOf(header(req, 'x-forwarded-host')) !== hostOf(hostname)) return send(res, 404, 'Not found');
  const app: PublishedApp = { id: route.id, app: route.app, hostname, agentGroupId: route.agentGroupId };
  const who = await kind.identify({ headers: req.headers, peer: header(req, 'x-nanoclaw-peer') }, app);
  if (!who) return send(res, 401, 'Sign in required.');
  const decision = await canOpen(route, who.userId, deps);
  if (!decision.ok) {
    auditDenied(route, who.userId, decision.reason);
    return send(res, 403, `${who.displayName} cannot open this app.`);
  }
  // A sleeping stack wakes on its first request; meanwhile a short page that reloads itself.
  const use = (await deps.waking?.(route).catch(() => 'running' as const)) ?? 'running';
  if (use !== 'running') {
    const page = /text\/html/.test(header(req, 'accept'));
    const starting = use === 'starting';
    const body = starting ? (page ? WAKING_PAGE : 'Starting\n') : page ? WAKE_FAILED_PAGE : 'Could not start\n';
    return send(res, 503, body, {
      ...(page ? { 'Content-Type': 'text/html; charset=utf-8' } : {}),
      'Retry-After': starting ? '3' : '300',
    });
  }
  send(res, 200, '', identityHeaders(hostname, route.kind, who));
  // After the answer: recording use never slows or fails a request.
  void deps.opened?.(route).catch(() => undefined);
}

/** The internal listener's request handler. */
export function internalHandler(secret: () => string, deps: InternalDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!secretOk(req, secret())) return send(res, 403, 'Forbidden');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const route = await deps.getRoute(header(req, 'x-nanoclaw-route'));
      if (!route || !(await deps.isLive(route))) return send(res, 404, 'This app is not published.');
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/gateway/check') return check(req, res, route, deps);
      if (path === '/.nanoclaw/jwks.json')
        return send(res, 200, JSON.stringify(jwks()), {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${IDENTITY_TTL_S}`,
        });
      return send(res, 404, 'Not found');
    })().catch((err) => {
      log.error('Workload gateway: check failed', { err: String(err) });
      if (!res.headersSent) send(res, 500, 'Gateway error');
      else res.destroy();
    });
  };
}
