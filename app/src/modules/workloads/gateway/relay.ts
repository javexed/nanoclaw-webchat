/**
 * Published apps of stacks on worker machines. A workload's service address
 * exists on its worker only, so Caddy (on this host's network) cannot dial it.
 * For each such app NanoClaw listens on a unix socket in the gateway's run
 * folder (caddy.ts runDir: 0700, NanoClaw's own user, mounted into the Caddy
 * container, which runs as that user) and carries each connection over the
 * worker's link (worker-main.ts `tcp`, which reaches workload addresses
 * only); Caddy's site for the app points at that socket. A loopback TCP port
 * would let any local process skip the gateway's check; the socket is
 * reachable only by NanoClaw's own user. Every request still passes the
 * gateway's check first (forward_auth).
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { log } from '../../../log.js';
import { isLinked, openWorkerTcp } from '../../machines/links.js';
import { MOUNT, runDir } from './caddy.js';

interface Relay {
  server: net.Server;
  /** The socket's file here. */
  file: string;
  /** What Caddy dials (the same socket, inside its container). */
  target: string;
}

const relays = new Map<string, Relay>();
const keyOf = (node: string, target: string): string => `${node}|${target}`;
/** A unix socket path may hold 107 bytes. */
const MAX_SOCKET_PATH = 107;
const SOCKET_NAME = /^r-[0-9a-f]{16}\.sock$/;

let dirOverride: string | null = null;
const socketDir = (): string => dirOverride ?? runDir();
let swept = false;

/** Sockets a previous run of NanoClaw left behind: nothing listens on them any more. */
function sweepStale(dir: string): void {
  if (swept) return;
  swept = true;
  for (const n of fs.readdirSync(dir)) if (SOCKET_NAME.test(n)) fs.rmSync(path.join(dir, n), { force: true });
}

/** Where Caddy reaches `target` (address:port) on the worker `node`: a relay socket; null when it is not linked. */
export async function relayFor(node: string, target: string): Promise<string | null> {
  if (!isLinked(node)) return null;
  const k = keyOf(node, target);
  const have = relays.get(k);
  if (have) return have.target;
  const dir = socketDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  sweepStale(dir);
  const name = `r-${crypto.randomBytes(8).toString('hex')}.sock`;
  const file = path.join(dir, name);
  if (Buffer.byteLength(file) > MAX_SOCKET_PATH) {
    log.warn('Workload gateway: the run folder path is too long for a relay socket', { dir });
    return null;
  }
  const [host, p] = target.split(':');
  const server = net.createServer((sock) => {
    sock.on('error', () => undefined);
    let up: ReturnType<typeof openWorkerTcp>;
    try {
      up = openWorkerTcp(node, host, Number(p));
    } catch {
      return void sock.destroy();
    }
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
    sock.pipe(up);
    up.pipe(sock);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => resolve());
  });
  fs.chmodSync(file, 0o600);
  server.on('error', (err) => log.warn('Workload gateway: relay failed', { node, target, err: String(err) }));
  server.unref();
  const r = { server, file, target: `unix/${MOUNT}/${name}` };
  relays.set(k, r);
  return r.target;
}

/** Is this a relay NanoClaw opened (what a Caddy site may point at besides a workload address)? */
export function isRelayTarget(t: string): boolean {
  const prefix = `unix/${MOUNT}/`;
  return (
    t.startsWith(prefix) && SOCKET_NAME.test(t.slice(prefix.length)) && [...relays.values()].some((r) => r.target === t)
  );
}

function closeRelay(k: string, r: Relay): void {
  r.server.close();
  fs.rmSync(r.file, { force: true });
  relays.delete(k);
}

/** Close the relays no live site uses any more. */
export function keepRelays(targets: Set<string>): void {
  for (const [k, r] of relays) if (!targets.has(r.target)) closeRelay(k, r);
}

/** The socket file a relay target names here (for tests and the startup sweep). */
export function relayFile(target: string): string | null {
  return [...relays.values()].find((r) => r.target === target)?.file ?? null;
}

export function __setRelayDirForTest(dir: string | null): void {
  dirOverride = dir;
  swept = false;
}

export function __resetRelaysForTest(): void {
  for (const [k, r] of relays) closeRelay(k, r);
}
