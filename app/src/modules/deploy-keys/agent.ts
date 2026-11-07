/**
 * One ssh-agent per agent group, on the host.
 *
 * Each key is loaded with an OpenSSH destination constraint per target
 * (`ssh-add -h user@host`, repeated, checked against the host keys pinned for
 * the targets), so the agent signs only for a connection bound to one of those
 * servers as its user, whatever host the container tunnels to. A server
 * reached through a jump host needs no forwarding constraint: the container's
 * ssh opens both connections itself (ProxyJump), so each is a direct
 * destination with its own `-h`. The real agent socket stays in the host-only store.
 * The container gets a second socket (in its read-only view) served by
 * `serveFiltered`: it passes only listing, signing and the session-bind
 * extension, refuses everything else (adding, removing, locking keys), and
 * logs each signature with the key and the server it was bound to.
 *
 * The agent starts when one of the group's containers spawns and stops when
 * none is running (sweep below), or when the group's last key goes.
 */
import { spawn, type ChildProcess, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import { log } from '../../log.js';
import {
  groupStoreDir,
  groupViewDir,
  hopsOf,
  keyFile,
  listStored,
  pinnedHosts,
  pinnedKeyBlobs,
  readKnownHosts,
  readMeta,
  splitTarget,
  writeMeta,
} from './store.js';

const run = promisify(execFile);

/** Socket names. The view's socket is what the container sees at /run/nanoclaw-ssh/agent.sock. */
const AGENT_SOCK = 'agent.sock';
/** Unix socket paths are limited to 107 bytes. */
const MAX_SOCK_PATH = 104;
const MAX_FRAME = 256 * 1024;

// ssh-agent protocol message numbers (draft-miller-ssh-agent).
const SSH_AGENT_FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const SIGN_REQUEST = 13;
const EXTENSION = 27;
const ALLOWED_EXTENSIONS = new Set(['session-bind@openssh.com', 'query']);

interface Running {
  child: ChildProcess;
  server: net.Server;
  realSock: string;
  viewSock: string;
}
const running = new Map<string, Running>();
const starting = new Map<string, Promise<boolean>>();

export function agentRunning(agentGroupId: string): boolean {
  return running.has(agentGroupId);
}

/**
 * Keys that can be loaded, each with the destinations it may sign for: its
 * targets whose host key is pinned (ssh-add refuses a destination it has no
 * host key for, so an unpinned one would keep the whole key out).
 */
function loadable(agentGroupId: string): Array<{ name: string; hops: string[] }> {
  const pinned = pinnedHosts(readKnownHosts(agentGroupId));
  const out: Array<{ name: string; hops: string[] }> = [];
  for (const k of listStored(agentGroupId)) {
    const hops = hopsOf(k.meta).filter((t) => pinned.has(splitTarget(t).host));
    if (hops.length) out.push({ name: k.name, hops });
  }
  return out;
}

function waitForSocket(p: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (fs.existsSync(p)) return resolve(true);
      if (Date.now() > until) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * Start (or keep) the group's agent with its keys loaded. False when the group
 * has no loadable key, or the agent could not start; the container then simply
 * has no agent socket.
 */
export function ensureAgent(agentGroupId: string): Promise<boolean> {
  if (running.has(agentGroupId)) return Promise.resolve(true);
  const pending = starting.get(agentGroupId);
  if (pending) return pending;
  const p = startAgent(agentGroupId).finally(() => starting.delete(agentGroupId));
  starting.set(agentGroupId, p);
  return p;
}

async function startAgent(agentGroupId: string): Promise<boolean> {
  const keys = loadable(agentGroupId);
  if (!keys.length) return false;
  const store = groupStoreDir(agentGroupId);
  const view = groupViewDir(agentGroupId);
  const realSock = path.join(store, AGENT_SOCK);
  const viewSock = path.join(view, AGENT_SOCK);
  if (realSock.length > MAX_SOCK_PATH || viewSock.length > MAX_SOCK_PATH) {
    log.warn('Deploy keys: socket path too long, agent not started', { agentGroupId });
    return false;
  }
  fs.rmSync(realSock, { force: true });
  fs.rmSync(viewSock, { force: true });

  const child = spawn('ssh-agent', ['-D', '-a', realSock], { stdio: 'ignore' });
  child.on('error', (err) => log.warn('Deploy keys: ssh-agent failed', { agentGroupId, err: String(err) }));
  if (!(await waitForSocket(realSock, 5000))) {
    child.kill();
    log.warn('Deploy keys: ssh-agent did not start', { agentGroupId });
    return false;
  }
  fs.chmodSync(realSock, 0o600);

  const knownHosts = path.join(store, 'known_hosts');
  let loaded = 0;
  for (const k of keys) {
    try {
      const constraints = k.hops.flatMap((t) => ['-h', t]);
      await run('ssh-add', ['-q', ...constraints, '-H', knownHosts, keyFile(agentGroupId, k.name)], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SSH_AUTH_SOCK: realSock },
        timeout: 10_000,
      });
      loaded++;
    } catch (err) {
      log.warn('Deploy keys: could not load a key', { agentGroupId, key: k.name, err: String(err).slice(0, 300) });
    }
  }
  if (!loaded) {
    child.kill();
    fs.rmSync(realSock, { force: true });
    return false;
  }

  const server = net.createServer((client) => serveFiltered(client, realSock, auditor(agentGroupId)));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(viewSock, () => resolve());
  });
  fs.chmodSync(viewSock, 0o600);
  const entry: Running = { child, server, realSock, viewSock };
  running.set(agentGroupId, entry);
  child.once('exit', () => {
    if (running.get(agentGroupId) === entry) stopAgent(agentGroupId);
  });
  log.info('Deploy keys: agent started', { agentGroupId, keys: loaded });
  return true;
}

export function stopAgent(agentGroupId: string): void {
  const r = running.get(agentGroupId);
  if (!r) return;
  running.delete(agentGroupId);
  r.server.close();
  r.child.kill();
  fs.rmSync(r.viewSock, { force: true });
  fs.rmSync(r.realSock, { force: true });
  log.info('Deploy keys: agent stopped', { agentGroupId });
}

/** After a key change: a running agent is restarted with the new set (or stopped when none is left). */
export async function reloadAgent(agentGroupId: string): Promise<void> {
  if (!running.has(agentGroupId)) return;
  stopAgent(agentGroupId);
  await ensureAgent(agentGroupId);
}

export function stopAllAgents(): void {
  for (const id of [...running.keys()]) stopAgent(id);
}

/**
 * Stop the agents of groups with no running container. `isLive` answers
 * whether a group has one; injected so this module does not import the runner.
 */
export async function sweepAgents(isLive: (agentGroupId: string) => Promise<boolean>): Promise<void> {
  for (const id of [...running.keys()]) {
    try {
      if (!(await isLive(id))) stopAgent(id);
    } catch {
      /* keep it; the next sweep decides */
    }
  }
}

// ── the container's socket ────────────────────────────────────────────────────

export interface SignEvent {
  /** SHA256 fingerprint of the key asked to sign. */
  keyFingerprint: string;
  /** The server host key the session was bound to, as SHA256 fingerprint; null when unbound. */
  boundHostKey: string | null;
}

const sha256 = (blob: Buffer): string =>
  'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

/** Read an SSH `string` (uint32 length + bytes) at `off`. */
function sshString(buf: Buffer, off: number): { value: Buffer; next: number } | null {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32BE(off);
  if (off + 4 + len > buf.length) return null;
  return { value: buf.subarray(off + 4, off + 4 + len), next: off + 4 + len };
}

/** Pull whole frames (uint32 length + body) off a growing buffer. */
function frames(state: { buf: Buffer }, chunk: Buffer): Buffer[] | null {
  state.buf = Buffer.concat([state.buf, chunk]);
  const out: Buffer[] = [];
  while (state.buf.length >= 4) {
    const len = state.buf.readUInt32BE(0);
    if (len < 1 || len > MAX_FRAME) return null;
    if (state.buf.length < 4 + len) break;
    out.push(state.buf.subarray(0, 4 + len));
    state.buf = state.buf.subarray(4 + len);
  }
  return out;
}

/** Is this client request one the container may make? Returns why not, or null. */
export function refusal(frame: Buffer): string | null {
  const type = frame[4];
  if (type === REQUEST_IDENTITIES || type === SIGN_REQUEST) return null;
  if (type === EXTENSION) {
    const name = sshString(frame, 5);
    if (name && ALLOWED_EXTENSIONS.has(name.value.toString('latin1'))) return null;
    return 'extension';
  }
  return `message ${type}`;
}

/**
 * Serve one container connection: forward allowed requests to the real agent
 * one at a time, answer the rest with SSH_AGENT_FAILURE, report signatures.
 */
export function serveFiltered(client: net.Socket, realSock: string, onSign: (e: SignEvent) => void): void {
  const upstream = net.connect(realSock);
  const fromClient = { buf: Buffer.alloc(0) };
  const fromAgent = { buf: Buffer.alloc(0) };
  const queue: Buffer[] = [];
  let waiting = false;
  let boundHostKey: string | null = null;
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  const failure = Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE]);

  const pump = (): void => {
    while (!waiting && queue.length) {
      const frame = queue.shift()!;
      if (refusal(frame)) {
        client.write(failure);
        continue;
      }
      const type = frame[4];
      if (type === EXTENSION) {
        const name = sshString(frame, 5);
        if (name?.value.toString('latin1') === 'session-bind@openssh.com') {
          const hostKey = sshString(frame, name.next);
          if (hostKey) boundHostKey = sha256(hostKey.value);
        }
      } else if (type === SIGN_REQUEST) {
        const key = sshString(frame, 5);
        if (key) onSign({ keyFingerprint: sha256(key.value), boundHostKey });
      }
      waiting = true;
      upstream.write(frame);
    }
  };

  client.on('data', (chunk: Buffer) => {
    const got = frames(fromClient, chunk);
    if (!got) return close();
    queue.push(...got);
    pump();
  });
  upstream.on('data', (chunk: Buffer) => {
    const got = frames(fromAgent, chunk);
    if (!got) return close();
    for (const f of got) {
      client.write(f);
      waiting = false;
    }
    pump();
  });
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
}

/** Log each signature with the key's name and the host it was bound to, and stamp the key's last use. */
function auditor(agentGroupId: string): (e: SignEvent) => void {
  return (e) => {
    try {
      const store = groupStoreDir(agentGroupId);
      const key = listStored(agentGroupId).find((k) => {
        const b64 = k.publicKey.split(/\s+/)[1];
        return b64 && sha256(Buffer.from(b64, 'base64')) === e.keyFingerprint;
      });
      const host = e.boundHostKey
        ? (pinnedKeyBlobs(readKnownHosts(agentGroupId)).find((p) => sha256(p.blob) === e.boundHostKey)?.host ?? null)
        : null;
      log.info('Deploy key used', { agentGroupId, key: key?.name ?? e.keyFingerprint, host });
      if (key) {
        const meta = readMeta(store, key.name);
        const last = meta.lastUsedAt ? Date.parse(meta.lastUsedAt) : 0;
        if (Date.now() - last > 60_000) writeMeta(store, key.name, { ...meta, lastUsedAt: new Date().toISOString() });
      }
    } catch (err) {
      log.warn('Deploy keys: audit failed', { agentGroupId, err: String(err) });
    }
  };
}
