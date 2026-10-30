/**
 * The machine listener (Scaling design: joining, identity and network): a TLS
 * port of its own, separate from webchat, that machines reach over the private
 * network or Tailscale. Off unless NANOCLAW_MACHINE_PORT is set.
 *
 *   GET  /healthz     reachability check (no auth)
 *   GET  /install.sh  the installer, with this address and key pin filled in
 *   POST /enroll      one-time token + certificate request + facts → certificate
 *   POST /report      health, every minute (client certificate)
 *   POST /renew       a fresh certificate (client certificate)
 *
 * Machines pin this listener's key; the listener knows a machine by its client
 * certificate's fingerprint, and refuses a revoked one at once.
 */
import fs from 'fs';
import https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import type { TLSSocket } from 'tls';

import { audit } from '../../audit.js';
import { log } from '../../log.js';
import { installScript } from './agent-scripts.js';
import { caPaths, ensureCa, issueMachineCert, publicKeyPin, RENEW_BEFORE_MS, type CaPaths } from './ca.js';
import {
  addMember,
  memberByCert,
  membersReady,
  recordHealth,
  rotateCert,
  spendJoinToken,
  type Facts,
  type Member,
} from './members.js';

const MAX_BODY = 16 * 1024;
const ENROLL_PER_MINUTE = 10;

export interface ListenerConfig {
  port: number;
  bind: string;
  /** The address machines use to reach this listener (shown in the install command). */
  address: string;
}

const firstPrivateIpv4 = (): string | null => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? [])
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('172.')) return i.address;
  return null;
};

/** From the environment; null when the listener is off. */
export function listenerConfig(env = process.env): ListenerConfig | null {
  const port = Number(env.NANOCLAW_MACHINE_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const bind = (env.NANOCLAW_MACHINE_BIND || '127.0.0.1').trim();
  const wildcard = bind === '0.0.0.0' || bind === '::';
  const address = (env.NANOCLAW_MACHINE_ADDRESS || (wildcard ? firstPrivateIpv4() : bind) || '127.0.0.1').trim();
  return { port, bind, address };
}

const send = (res: ServerResponse, code: number, body: string, type = 'text/plain'): void => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** The joined machine behind this request's client certificate, unless revoked. */
async function caller(req: IncomingMessage): Promise<Member | null> {
  const socket = req.socket as TLSSocket;
  if (!socket.authorized) return null;
  const fp = socket.getPeerCertificate()?.fingerprint256;
  const m = fp ? await memberByCert(fp) : null;
  return m && m.state !== 'revoked' ? m : null;
}

const enrollHits = new Map<string, number[]>();
function enrollLimited(ip: string, now = Date.now()): boolean {
  const recent = (enrollHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  enrollHits.set(ip, recent);
  return recent.length > ENROLL_PER_MINUTE;
}

export function machineHandler(cfg: ListenerConfig, paths: CaPaths) {
  const pin = publicKeyPin(fs.readFileSync(paths.serverCert, 'utf8'));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '/').split('?')[0];
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    try {
      if (req.method === 'GET' && url === '/healthz') return send(res, 200, 'ok');
      if (req.method === 'GET' && url === '/install.sh')
        return send(res, 200, installScript(cfg.address, cfg.port, pin), 'text/x-shellscript');
      if (req.method !== 'POST') return send(res, 404, 'not found');
      if (!(await membersReady())) return send(res, 503, 'not ready');

      if (url === '/enroll') {
        if (enrollLimited(ip)) return send(res, 429, 'slow down');
        const raw = await readBody(req);
        let body: { token?: string; csr?: string; facts?: Facts };
        try {
          body = JSON.parse(raw ?? '');
        } catch {
          return send(res, 400, 'bad request');
        }
        const csr = Buffer.from(String(body.csr ?? ''), 'base64').toString('utf8');
        const role = await spendJoinToken(String(body.token ?? ''));
        if (!role) {
          audit({ type: 'machine.join', effect: 'deny', reason: 'token', detail: { ip } });
          return send(res, 403, 'token refused');
        }
        let cert;
        try {
          cert = issueMachineCert(csr, paths);
        } catch {
          return send(res, 400, 'bad certificate request');
        }
        const m = await addMember(String(body.token), role, body.facts ?? { cpus: 0, memTotalMb: 0 }, cert);
        audit({ type: 'machine.join', effect: 'allow', detail: { machineId: m.id, name: m.name, role, ip } });
        log.info('Machine joined', { machineId: m.id, name: m.name, role });
        return send(res, 200, `id ${m.id}\nname ${m.name}\n${cert.cert}`);
      }

      const m = await caller(req);
      if (!m) return send(res, 403, 'revoked or unknown');

      if (url === '/report') {
        const raw = await readBody(req);
        let health: Record<string, unknown>;
        try {
          health = JSON.parse(raw ?? '');
        } catch {
          return send(res, 400, 'bad request');
        }
        const after = await recordHealth(m.id, health);
        const renew = !after?.certExpires || after.certExpires - Date.now() < RENEW_BEFORE_MS;
        return send(res, 200, renew ? 'renew' : 'ok');
      }

      if (url === '/renew') {
        const csr = await readBody(req);
        let cert;
        try {
          cert = issueMachineCert(csr ?? '', paths);
        } catch {
          return send(res, 400, 'bad certificate request');
        }
        await rotateCert(m.id, cert);
        return send(res, 200, cert.cert);
      }
      return send(res, 404, 'not found');
    } catch (err) {
      log.error('Machine listener request failed', { url, err: String(err) });
      if (!res.headersSent) send(res, 500, 'error');
    }
  };
}

let server: https.Server | null = null;

/** Start the listener when NANOCLAW_MACHINE_PORT is set; a no-op otherwise. */
export function startMachineListener(env = process.env): void {
  const cfg = listenerConfig(env);
  if (!cfg || server) return;
  const paths = caPaths();
  try {
    ensureCa(
      paths,
      [cfg.address, cfg.bind].filter((a) => a && a !== '0.0.0.0' && a !== '::'),
    );
  } catch (err) {
    log.error('Machine listener NOT started: could not set up its certificates (is openssl installed?)', {
      err: String(err),
    });
    return;
  }
  const handler = machineHandler(cfg, paths);
  server = https.createServer(
    {
      key: fs.readFileSync(paths.serverKey),
      cert: fs.readFileSync(paths.serverCert),
      ca: fs.readFileSync(paths.caCert),
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req, res) => void handler(req, res),
  );
  server.on('error', (err) => log.error('Machine listener error', { err: String(err) }));
  server.listen(cfg.port, cfg.bind, () =>
    log.info('Machine listener on', { port: cfg.port, bind: cfg.bind, address: cfg.address }),
  );
}

export function stopMachineListener(): void {
  server?.close();
  server = null;
}

/** For the Add machine screen: where machines connect, and the key they pin. */
export function listenerInfo(env = process.env): { address: string; port: number; pin: string } | null {
  const cfg = listenerConfig(env);
  if (!cfg) return null;
  const paths = caPaths();
  if (!fs.existsSync(paths.serverCert)) return null;
  return { address: cfg.address, port: cfg.port, pin: publicKeyPin(fs.readFileSync(paths.serverCert, 'utf8')) };
}
