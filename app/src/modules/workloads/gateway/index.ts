/**
 * The inbound gateway for published workload apps (docs/webchat/workloads.md,
 * "Publishing"). Off unless NANOCLAW_WORKLOAD_GATEWAY_PORT is set; refused,
 * with the reason logged, where its settings are unsafe (config.ts).
 *
 * NanoClaw runs a forward_auth listener on 127.0.0.1 and keeps a Caddy
 * container in step with the published apps: on every change, and once a
 * minute (a restarted Caddy, a workload that stopped, a route switched off).
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import { createServer, type Server } from 'http';
import path from 'path';

import { log } from '../../../log.js';
import { canAccessAgentGroup } from '../../permissions/access.js';
import { isOwner } from '../../permissions/db/user-roles.js';
import { getUser } from '../../permissions/db/users.js';
import { getRoute, routesReady } from '../routes.js';
import { applyConfig, ensureContainer, removeContainer, renderCaddyfile } from './caddy.js';
import { gatewaySettings, type GatewayConfig } from './config.js';
import { internalHandler } from './internal.js';
import { gatewayDir } from './keys.js';
import { isLive, liveSites } from './live.js';

let server: Server | null = null;
let serverPort: number | null = null;
let secretValue: string | null = null;
let lastRefusal = '';
/** Whether the container was checked for removal since the gateway went off (once, not every minute). */
let offSettled = false;

/** The secret Caddy presents to the internal listener: 0600, outside the folder Caddy mounts. */
function secret(): string {
  if (secretValue) return secretValue;
  const file = path.join(gatewayDir(), 'secret');
  fs.mkdirSync(gatewayDir(), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) secretValue = fs.readFileSync(file, 'utf8').trim();
  if (!secretValue || !/^[A-Za-z0-9_-]{32,128}$/.test(secretValue)) {
    secretValue = randomBytes(32).toString('base64url');
    fs.writeFileSync(file, secretValue, { mode: 0o600 });
  }
  return secretValue;
}

const deps = {
  getRoute,
  isLive,
  userExists: async (id: string) => Boolean(await getUser(id)),
  isOwner,
  canAccessAgentGroup: async (u: string, g: string) => (await canAccessAgentGroup(u, g)).allowed,
};

async function listen(cfg: GatewayConfig): Promise<void> {
  if (server && serverPort === cfg.internalPort) return;
  await closeListener();
  const s = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, internalHandler(secret, deps));
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(cfg.internalPort, '127.0.0.1', () => resolve());
  });
  // Never what keeps the process alive.
  s.unref();
  server = s;
  serverPort = cfg.internalPort;
  log.info('Workload gateway: check listener up', { port: cfg.internalPort });
}

async function closeListener(): Promise<void> {
  const s = server;
  server = null;
  serverPort = null;
  if (!s) return;
  s.closeAllConnections?.();
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

/** Push the published apps to Caddy now. False when the gateway is off or Caddy did not take it. */
export async function syncGateway(): Promise<boolean> {
  const st = gatewaySettings();
  if (!st.on || !st.ok || !server) return false;
  return applyConfig(renderCaddyfile(st.cfg, await liveSites(), secret()));
}

/** The gateway's state, in words, for `ncl workloads routes` and the docs' checks. */
export function gatewayState(): { on: boolean; ok: boolean; reason?: string } {
  const st = gatewaySettings();
  if (!st.on) return { on: false, ok: false, reason: 'the app gateway is off on this host' };
  return st.ok ? { on: true, ok: true } : { on: true, ok: false, reason: st.reason };
}

/** One pass: start, update or stop the gateway to match the settings and the published apps. */
export async function tickGateway(switchedOn = true): Promise<void> {
  const st = gatewaySettings();
  if (!switchedOn || !st.on || !st.ok) {
    if (st.on && !st.ok && st.reason !== lastRefusal) log.warn('Workload gateway refused', { reason: st.reason });
    lastRefusal = st.on && !st.ok ? st.reason : '';
    await closeListener();
    if (!offSettled) {
      offSettled = await removeContainer()
        .then(() => true)
        .catch((err) => {
          log.warn('Workload gateway: remove failed', { err: String(err) });
          return false;
        });
    }
    return;
  }
  lastRefusal = '';
  offSettled = false;
  if (!(await routesReady())) return;
  await listen(st.cfg);
  const text = renderCaddyfile(st.cfg, await liveSites(), secret());
  if (await ensureContainer(st.cfg, text)) {
    // A fresh container starts from the file; wait until its admin socket takes a reload.
    for (let i = 0; i < 20 && !(await applyConfig(text, i < 19)); i++) await new Promise((r) => setTimeout(r, 500));
    return;
  }
  await applyConfig(text);
}

export async function stopGatewayListener(): Promise<void> {
  await closeListener();
}
