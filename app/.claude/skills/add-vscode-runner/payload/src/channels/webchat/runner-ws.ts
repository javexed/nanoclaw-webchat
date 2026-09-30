/**
 * Runner endpoint — `/ws/runner`.
 *
 * The VS Code extension on a developer's machine connects OUT to this path
 * over the same front door the PWA uses. The connection must authenticate as
 * a person (Tailscale or the SSO proxy header): a shared bearer token says
 * nothing about who is on the other end, and a machine that serves an agent
 * its project is bound to one person.
 *
 * This file owns the socket: hello, keepalive, pairing state and audit. The
 * frames it carries belong to runner-transport (the laptop tools' requests)
 * and runner-chat (the editor's chat).
 */
import { createPublicKey, randomBytes, verify, type KeyObject } from 'crypto';
import type http from 'http';
import type { Duplex } from 'stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { audit } from '../../audit.js';
import { INSTALL_SLUG } from '../../config.js';
import { log } from '../../log.js';
import { authenticateRequest, type AuthFailure, type AuthResult } from './auth.js';
import { tailnetHostNames } from './request-guard.js';
import { registerUpgradeHandler, type UpgradeHandler } from './ws.js';
import { closeRunnerChat, handleChatFrame, setupRunnerChat, type ChatDeps } from './runner-chat.js';
import { attachRunnerLink, detachRunnerLink, handleRunnerFrame } from './runner-transport.js';
import { readExtensionManifest } from './runner-extension.js';
import { stopAgentsPlacedOn } from './runner-tools.js';
import {
  ensureDedicatedGroup,
  ensurePairingRequested,
  registerPairingApprovalHandler,
  setPairingListener,
} from './runner-pairing.js';
import {
  isSafeRunnerId,
  runnerRegistry,
  type RunnerMachineRow,
  type RunnerMachineStatus,
  type RunnerRegistryPort,
} from './runner-registry.js';

// Primary path lives under /ws/ on purpose: the relay's nginx forwards the
// WebSocket Upgrade/Connection headers only for `location /ws` (prefix match),
// so every socket endpoint must sit beneath it or arrive as a plain GET.
// /runner/ws stays as an alias for proxies that upgrade every path.
export const RUNNER_WS_PATH = '/ws/runner';
export const RUNNER_WS_PATHS: readonly string[] = [RUNNER_WS_PATH, '/runner/ws'];
export const RUNNER_PROTOCOL_VERSION = 1;
/** Off unless set: the path is then destroyed like any other unknown upgrade. */
export const RUNNER_ENABLED = process.env.WEBCHAT_RUNNER_ENABLED === 'true';
/** Auth sources that identify one person; pairing binds a machine to that identity. */
const PERSONAL_SOURCES: ReadonlySet<AuthResult['source']> = new Set(['oidc', 'tailscale', 'proxy-header']);
const DEFAULT_KEEPALIVE_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;
/**
 * Per-frame ceiling. A runner's answers carry file contents (a tools.call
 * Read of a large file, a Grep over a big tree); 256 KB was hit in the field.
 * Bounded, but generous.
 */
export const MAX_PAYLOAD = 32 * 1024 * 1024;

export interface RunnerMachine {
  fingerprint: string;
  hostname: string;
  os: string;
  arch: string;
  runner: string;
  /** Ed25519 public key, SPKI DER in base64 (extension 0.x with machine keys). */
  publicKey?: string;
}

/**
 * Machine key: proof of possession. The fingerprint is a hash of what a
 * machine says about itself, so it identifies but does not authenticate. The
 * extension keeps an Ed25519 key in VS Code's secret storage and, on every
 * connect, signs central's random challenge bound to the fingerprint and to
 * the origin it dialled — a signature obtained through some other server does
 * not verify here. The registry binds the key on first sight and never
 * replaces it; revoking a machine clears it.
 */
export const MACHINE_KEY_CONTEXT = 'nanoclaw-runner-key-v1';
export function machineKeyMessage(fingerprint: string, origin: string, nonce: string): string {
  return `${MACHINE_KEY_CONTEXT}\n${fingerprint}\n${origin}\n${nonce}`;
}
/** The key in canonical form (re-encoded SPKI DER, base64), or null if it is not an Ed25519 public key. */
export function parseMachineKey(raw: unknown): { key: KeyObject; publicKey: string } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return { key, publicKey: key.export({ format: 'der', type: 'spki' }).toString('base64') };
  } catch {
    return null;
  }
}
/** host[:port] with the scheme's default port dropped, lowercased. */
function normalHost(host: string): string {
  return host.toLowerCase().replace(/:(80|443)$/, '');
}
/**
 * The hosts a keyed machine may have signed its challenge for: the names
 * central is configured to be reached at: WEBCHAT_PUBLIC_URL, the
 * comma-separated WEBCHAT_RUNNER_ORIGINS (URLs or host[:port]), and this
 * machine's Tailscale Serve name. Never the request's own Host or
 * X-Forwarded-Host: a server relaying the challenge sets those to its own
 * name, and would be admitted as the machine it phished. A name given
 * without a port matches it on any port (a Tailscale Serve name serves
 * several); loopback is always accepted (verifyMachineChallenge).
 */
export async function configuredOriginHosts(
  env: NodeJS.ProcessEnv = process.env,
  tailnet: () => Promise<string[]> = tailnetHostNames,
): Promise<string[]> {
  const hosts: string[] = [];
  for (const raw of [env.WEBCHAT_PUBLIC_URL ?? '', ...(env.WEBCHAT_RUNNER_ORIGINS ?? '').split(',')]) {
    const v = raw.trim();
    if (!v) continue;
    try {
      hosts.push(new URL(v.includes('://') ? v : `https://${v}`).host);
    } catch {
      /* malformed; ignored */
    }
  }
  hosts.push(...(await tailnet().catch(() => [])));
  return [...new Set(hosts.filter(Boolean).map(normalHost))];
}
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Does `signature` sign this challenge, for this machine, addressed to one of these hosts? */
export function verifyMachineChallenge(
  key: KeyObject,
  c: { fingerprint: string; nonce: string; originHosts: string[] },
  origin: unknown,
  signature: unknown,
): 'ok' | 'origin-mismatch' | 'origin-unconfigured' | 'bad-signature' {
  if (typeof origin !== 'string' || typeof signature !== 'string') return 'bad-signature';
  let host: string;
  let hostname: string;
  try {
    const u = new URL(origin);
    host = normalHost(u.host);
    hostname = u.hostname.toLowerCase();
  } catch {
    return 'origin-mismatch';
  }
  const named = c.originHosts.some((h) => h === host || (!h.includes(':') && h === hostname));
  if (!named && !LOOPBACK.has(hostname)) return c.originHosts.length ? 'origin-mismatch' : 'origin-unconfigured';
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(machineKeyMessage(c.fingerprint, origin, c.nonce)),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    ok = false;
  }
  return ok ? 'ok' : 'bad-signature';
}
export interface ConnectedRunner {
  fingerprint: string;
  userId: string;
  displayName: string;
  hostname: string;
  os: string;
  arch: string;
  runnerVersion: string;
  /** Pairing state at hello, updated live when an owner decides. */
  pairing: RunnerMachineStatus;
  remoteIp: string;
  connectedAt: number;
  lastSeenAt: number;
}
type Frame = { type: string; [k: string]: unknown };
type Live = ConnectedRunner & { ws: WebSocket; alive: boolean };

const runners = new Map<string, Live>();
// Set by setupRunnerWebSocket; module-level because onConnection is not a closure over the options.
let activeRegistry: RunnerRegistryPort = runnerRegistry;
let activeOnPending: (machine: RunnerMachineRow, displayName: string) => Promise<void> = ensurePairingRequested;
let activeOnApproved: (machine: RunnerMachineRow) => Promise<unknown> = (m) =>
  ensureDedicatedGroup(m, m.approved_by ?? m.user_id);

export function listRunners(): ConnectedRunner[] {
  return [...runners.values()].map(({ ws: _ws, alive: _alive, ...r }) => r);
}
/**
 * Push a pairing decision to the live socket (if any) and mirror it in the
 * listing. A revoked machine's chat is cut and the agents placed on it are
 * stopped here on central before the socket closes.
 */
export function applyPairingChange(fingerprint: string, status: RunnerMachineStatus): boolean {
  const live = runners.get(fingerprint);
  if (!live) return false;
  live.pairing = status;
  send(live.ws, { type: 'pairing', status });
  if (status === 'revoked') {
    closeRunnerChat(fingerprint);
    void stopAgentsPlacedOn(fingerprint, 'machine revoked')
      .catch((err: unknown) => log.warn('Runner revoke: stopping its agents failed', { err: String(err) }))
      .finally(() => live.ws.close(4403, 'machine-revoked'));
  }
  return true;
}

/**
 * The developer ran "Stop all agents". The machine already serves nothing
 * until they resume (it enforces that itself); here the agents placed on it
 * stop running on central.
 */
function onStopAll(live: Live): void {
  void stopAgentsPlacedOn(live.fingerprint, 'developer stopped all agents').then(
    (sessions) => {
      audit({
        type: 'runner.stop_all',
        actor: `human:${live.userId}`,
        effect: 'allow',
        detail: { fingerprint: live.fingerprint, sessions },
      });
      log.info('Runner: developer stopped all agents on the machine', {
        fingerprint: live.fingerprint.slice(0, 12),
        sessions,
      });
    },
    (err: unknown) => log.warn('Runner stop all: stopping its agents failed', { err: String(err) }),
  );
}
export function __resetRunnersForTest(): void {
  for (const r of runners.values()) r.ws.terminate();
  runners.clear();
}

export interface RunnerWsOptions {
  authenticate?: (req: http.IncomingMessage) => Promise<AuthResult | AuthFailure>;
  /**
   * Default true: a machine pairs only behind a source that names a PERSON
   * (a verified Entra token, a Tailscale identity, or identity headers from a
   * trusted proxy). The shared
   * bearer token and the localhost owner are not a person. Tests may relax it.
   */
  requireIdentity?: boolean;
  /** Machine registry (DB). Tests inject an in-memory one. */
  registry?: RunnerRegistryPort;
  /** What to do for a pending machine — default raises the pairing card. */
  onPending?: (machine: RunnerMachineRow, displayName: string) => Promise<void>;
  /** What to do for an approved machine — default makes sure it has its dedicated agent group. */
  onApproved?: (machine: RunnerMachineRow) => Promise<unknown>;
  keepaliveMs?: number;
  /** Per-frame ceiling; defaults to MAX_PAYLOAD (tests use a small one). */
  maxPayload?: number;
  /** The router hook a message from a laptop's chat view is handed to (server.ts owns it). */
  chatInbound?: ChatDeps['inbound'];
}

export function setupRunnerWebSocket(opts: RunnerWsOptions = {}): WebSocketServer {
  setupRunnerChat(opts.chatInbound ?? null);
  const authenticate = opts.authenticate ?? authenticateRequest;
  const requireIdentity = opts.requireIdentity ?? true;
  activeRegistry = opts.registry ?? runnerRegistry;
  activeOnPending = opts.onPending ?? ensurePairingRequested;
  activeOnApproved =
    opts.onApproved ?? ((m) => ensureDedicatedGroup(m, m.approved_by ?? m.user_id, { reconnect: true }));
  registerPairingApprovalHandler();
  setPairingListener((fp, status) => applyPairingChange(fp, status));
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? MAX_PAYLOAD });

  // JSON-level keepalive (not the ws protocol ping) so the runner can observe
  // and log it: a runner that misses one whole interval is dropped, and its
  // reconnect path re-establishes it.
  const timer = setInterval(() => {
    for (const [fp, r] of runners) {
      if (!r.alive) {
        log.info('Runner keepalive lapsed — dropping', { fingerprint: fp.slice(0, 12), userId: r.userId });
        // terminate() fires 'close', whose handler removes the entry and
        // detaches the link, chat and relay streams. Deleting here first would
        // make that handler skip all of it.
        r.ws.terminate();
        continue;
      }
      r.alive = false;
      // The served runner version rides the keepalive too, so a runner that stays
      // connected for days still learns of a new build within one interval.
      send(r.ws, { type: 'ping', t: Date.now(), ...updateOffer() });
    }
  }, keepaliveMs);
  wss.on('close', () => clearInterval(timer));

  const onUpgrade: UpgradeHandler = (req, socket, head) => {
    void (async () => {
      const remoteIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const auth = await authenticate(req);
      if (!auth.ok) {
        refuse(socket, 401, 'Unauthorized');
        return;
      }
      if (requireIdentity && !PERSONAL_SOURCES.has(auth.source)) {
        audit({
          type: 'runner.refused',
          actor: `human:${auth.userId}`,
          effect: 'deny',
          detail: { reason: 'source-not-personal', source: auth.source, ip: remoteIp },
        });
        refuse(socket, 403, 'Runner connections must sign in as a person (Tailscale or SSO)');
        return;
      }
      const originHosts = await configuredOriginHosts();
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth, remoteIp, keepaliveMs, originHosts));
    })().catch((err) => {
      log.warn('Runner WS upgrade failed', { err });
      socket.destroy();
    });
  };
  for (const p of RUNNER_WS_PATHS) registerUpgradeHandler(p, onUpgrade);

  return wss;
}

function updateOffer(): { update?: { version: string; sha256: string; size: number } } {
  const m = readExtensionManifest();
  return m ? { update: { version: m.version, sha256: m.sha256, size: m.size } } : {};
}

function refuse(socket: Duplex, status: 401 | 403, text: string): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden';
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
  );
  socket.destroy();
}

function send(ws: WebSocket, frame: Frame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function onConnection(
  ws: WebSocket,
  auth: AuthResult,
  remoteIp: string,
  keepaliveMs: number,
  originHosts: string[],
): void {
  let entry: Live | null = null;
  /** Set between a keyed hello and its signed answer. */
  let challenge: {
    nonce: string;
    key: KeyObject;
    publicKey: string;
    machine: RunnerMachine;
    existing: RunnerMachineRow | undefined;
  } | null = null;

  // The first frame must be `hello`; nothing else is accepted before it, and a
  // socket that never says hello is closed rather than left to squat.
  const helloTimer = setTimeout(() => {
    if (!entry) {
      send(ws, { type: 'error', code: 'hello-timeout', message: `expected hello within ${HELLO_TIMEOUT_MS / 1000}s` });
      ws.close(4400, 'hello timeout');
    }
  }, HELLO_TIMEOUT_MS);

  // Without a listener, a socket error — an oversized frame, a protocol
  // violation — is an uncaught exception, and one laptop takes central down
  // (seen 2026-09-23: "Max payload size exceeded"). Log it and drop this link.
  ws.on('error', (err) => {
    log.warn('Runner socket error — closing this link', {
      fingerprint: entry?.fingerprint.slice(0, 12) ?? null,
      err: String((err as Error)?.message ?? err),
    });
    ws.terminate();
  });

  let helloSeen = false;

  /**
   * A pairing binds one user to one fingerprint; a revoked machine stays out
   * until an owner re-approves it. Both are refused AFTER auth, so the audit
   * row names the real person who tried. True when refused.
   */
  const refuseBinding = (machine: RunnerMachineRow): boolean => {
    const refusal =
      machine.user_id !== auth.userId
        ? 'fingerprint-bound-to-other-user'
        : machine.status === 'revoked'
          ? 'machine-revoked'
          : null;
    if (!refusal) return false;
    audit({
      type: 'runner.refused',
      actor: `human:${auth.userId}`,
      effect: 'deny',
      detail: { reason: refusal, fingerprint: machine.fingerprint, ip: remoteIp },
    });
    send(ws, {
      type: 'error',
      code: refusal,
      message:
        refusal === 'machine-revoked'
          ? 'this machine was revoked; ask an owner to approve it again'
          : 'this machine is paired to another user',
    });
    ws.close(4403, refusal);
    return true;
  };

  /** The machine did not prove the key it is bound to (or the one it presented). */
  const refuseKey = (fingerprint: string, reason: string): void => {
    audit({
      type: 'runner.machine.key.mismatch',
      actor: `human:${auth.userId}`,
      effect: 'deny',
      detail: { reason, fingerprint, ip: remoteIp },
    });
    send(ws, {
      type: 'error',
      code: 'machine-key-mismatch',
      message:
        reason === 'origin-mismatch'
          ? 'the signed origin is not this server'
          : reason === 'origin-unconfigured'
            ? 'central does not know its own address (set WEBCHAT_PUBLIC_URL), so it cannot check which server this machine signed for'
            : 'this machine did not prove the key it is paired with; an owner can revoke and re-approve it',
    });
    ws.close(4403, 'machine-key-mismatch');
  };

  const admit = async (
    m: RunnerMachine,
    publicKey: string | null,
    existing: RunnerMachineRow | undefined,
  ): Promise<void> => {
    let machine = await activeRegistry.recordMachineSeen({
      fingerprint: m.fingerprint,
      userId: auth.userId,
      hostname: m.hostname,
      os: m.os,
      arch: m.arch,
      runnerVersion: m.runner,
      ...(publicKey ? { publicKey } : {}),
    });
    if (refuseBinding(machine)) return;
    if (publicKey && existing && !existing.public_key) {
      // Paired before keys existed: the first key it proves is its key from now on.
      if (await activeRegistry.bindMachineKey(m.fingerprint, publicKey)) {
        audit({
          type: 'runner.machine.key.bound',
          actor: `human:${auth.userId}`,
          effect: 'allow',
          detail: { fingerprint: m.fingerprint, ip: remoteIp },
        });
      }
      machine = (await activeRegistry.getMachine(m.fingerprint)) ?? machine;
    }
    // Whatever raced us, the row's key is the one this connection must have
    // proved; a keyless connection is refused once any key is bound.
    if (machine.public_key && machine.public_key !== publicKey)
      return refuseKey(m.fingerprint, publicKey ? 'different-key' : 'no-key');
    // Gone while we were checking: its close handler has run, so register nothing.
    if (ws.readyState !== ws.OPEN) return;
    clearTimeout(helloTimer);
    if (machine.status === 'pending') {
      void activeOnPending(machine, auth.displayName).catch((err: unknown) =>
        log.warn('Runner pairing request failed', { err }),
      );
    }
    // An approved machine gets its dedicated agent on connect if it has none
    // yet — approved before the feature existed, or provisioning failed then.
    if (machine.status === 'approved') {
      void activeOnApproved(machine).catch((err: unknown) =>
        log.warn('Runner dedicated-group reconcile failed', { err }),
      );
    }
    // One live connection per machine: a reconnecting runner supersedes its
    // own stale socket instead of leaving two entries that both look alive.
    const prev = runners.get(m.fingerprint);
    if (prev && prev.ws !== ws) {
      // Tell the loser WHY, with a code it can act on. Terminating silently
      // makes it reconnect at once and supersede the winner in turn, so two
      // VS Code windows on one machine trade the connection forever — which
      // is exactly what a machine with a second window open did.
      send(prev.ws, {
        type: 'error',
        code: 'superseded',
        message: 'another connection from this machine took over',
      });
      prev.ws.close(4409, 'superseded');
      const stale = prev.ws;
      setTimeout(() => stale.terminate(), 2000).unref?.();
    }
    entry = {
      fingerprint: m.fingerprint,
      userId: auth.userId,
      displayName: auth.displayName,
      hostname: m.hostname,
      os: m.os,
      arch: m.arch,
      runnerVersion: m.runner,
      pairing: machine.status,
      remoteIp,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      ws,
      alive: true,
    };
    runners.set(m.fingerprint, entry);
    attachRunnerLink({ fingerprint: m.fingerprint, userId: auth.userId, ws });
    audit({
      type: 'runner.connect',
      actor: `human:${auth.userId}`,
      effect: 'allow',
      detail: {
        fingerprint: m.fingerprint,
        hostname: entry.hostname,
        os: entry.os,
        runner: entry.runnerVersion,
        pairing: machine.status,
        ip: remoteIp,
        source: auth.source,
        keyed: !!publicKey,
      },
    });
    log.info('Runner connected', {
      userId: auth.userId,
      hostname: entry.hostname,
      fingerprint: m.fingerprint.slice(0, 12),
      offering: readExtensionManifest()?.version ?? 'none',
    });
    send(ws, {
      type: 'welcome',
      v: RUNNER_PROTOCOL_VERSION,
      userId: auth.userId,
      displayName: auth.displayName,
      serverTime: Date.now(),
      keepaliveMs,
      pairing: machine.status,
      // This install's name: the machine refuses requests naming any other.
      installSlug: INSTALL_SLUG,
      // The runner build this install serves; the extension offers the update when it is newer.
      ...updateOffer(),
    });
  };

  ws.on('message', (data) => {
    onMessage(data).catch((err) => log.warn('Runner frame handling failed', { err: String(err) }));
  });
  const onMessage = async (data: WebSocket.RawData): Promise<void> => {
    let frame: Frame;
    try {
      frame = JSON.parse(String(data)) as Frame;
    } catch {
      send(ws, { type: 'error', code: 'bad-json', message: 'frames are JSON objects' });
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      send(ws, { type: 'error', code: 'bad-frame', message: 'frame needs a string `type`' });
      return;
    }

    if (!entry) {
      if (challenge) {
        if (frame.type !== 'challenge.response') {
          send(ws, { type: 'error', code: 'challenge-first', message: 'answer the challenge first' });
          return;
        }
        const c = challenge;
        challenge = null;
        const verdict = verifyMachineChallenge(
          c.key,
          { fingerprint: c.machine.fingerprint, nonce: c.nonce, originHosts },
          frame.origin,
          frame.signature,
        );
        if (verdict !== 'ok') {
          refuseKey(c.machine.fingerprint, verdict);
          return;
        }
        await admit(c.machine, c.publicKey, c.existing);
        return;
      }
      if (frame.type !== 'hello') {
        send(ws, { type: 'error', code: 'hello-first', message: 'first frame must be hello' });
        return;
      }
      if (helloSeen) {
        send(ws, { type: 'error', code: 'hello-once', message: 'one hello per connection' });
        return;
      }
      const m = (frame.machine ?? {}) as Partial<RunnerMachine>;
      const parsedKey = m.publicKey === undefined ? null : parseMachineKey(m.publicKey);
      if (
        frame.v !== RUNNER_PROTOCOL_VERSION ||
        !isSafeRunnerId(m.fingerprint) ||
        (m.publicKey !== undefined && !parsedKey)
      ) {
        send(ws, {
          type: 'error',
          code: 'bad-hello',
          message: `hello must carry v=${RUNNER_PROTOCOL_VERSION}, machine.fingerprint, and an Ed25519 machine.publicKey if any`,
        });
        ws.close(4400, 'bad hello');
        return;
      }
      helloSeen = true;
      const machine: RunnerMachine = {
        fingerprint: m.fingerprint,
        hostname: String(m.hostname ?? ''),
        os: String(m.os ?? ''),
        arch: String(m.arch ?? ''),
        runner: String(m.runner ?? ''),
      };
      const existing = await activeRegistry.getMachine(machine.fingerprint);
      if (existing && refuseBinding(existing)) return;
      if (existing?.public_key) {
        // Bound: the key is required and never changes.
        if (!parsedKey) return refuseKey(machine.fingerprint, 'no-key');
        if (parsedKey.publicKey !== existing.public_key) return refuseKey(machine.fingerprint, 'different-key');
      } else if (!parsedKey && !existing?.keyless_allowed) {
        // A machine never seen before must bring a key: a fingerprint alone is
        // guessable. So must one revoked and approved again: only machines
        // paired before keys existed may still connect without one.
        audit({
          type: 'runner.refused',
          actor: `human:${auth.userId}`,
          effect: 'deny',
          detail: {
            reason: 'machine-key-required',
            fingerprint: machine.fingerprint,
            ip: remoteIp,
            known: !!existing,
          },
        });
        send(ws, {
          type: 'error',
          code: 'machine-key-required',
          message: existing
            ? 'this machine must prove a key to reconnect, and this NanoClaw extension has none; update it'
            : 'this NanoClaw extension is too old to pair a new machine; update it',
        });
        ws.close(4403, 'machine-key-required');
        return;
      }
      if (parsedKey) {
        const nonce = randomBytes(32).toString('base64url');
        challenge = { nonce, key: parsedKey.key, publicKey: parsedKey.publicKey, machine, existing };
        send(ws, { type: 'challenge', nonce });
        return;
      }
      // Transition: a machine paired before keys existed, on an extension without them.
      audit({
        type: 'runner.machine.keyless',
        actor: `human:${auth.userId}`,
        effect: 'allow',
        detail: { fingerprint: machine.fingerprint, runner: machine.runner, ip: remoteIp },
      });
      await admit(machine, null, existing);
      return;
    }

    entry.lastSeenAt = Date.now();
    entry.alive = true;
    switch (frame.type) {
      case 'pong':
        break;
      case 'ping':
        send(ws, { type: 'pong', t: frame.t });
        break;
      case 'stopAll':
        onStopAll(entry);
        break;
      default:
        if (handleRunnerFrame(entry.fingerprint, frame)) break;
        // Revoked and being wound down: nothing more is taken from it.
        if (entry.pairing === 'revoked') break;
        if (handleChatFrame(entry, frame)) break;
        send(ws, {
          type: 'error',
          code: 'unknown-frame',
          message: `unknown frame type ${frame.type}`,
        });
    }
  };

  ws.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    if (entry && runners.get(entry.fingerprint)?.ws === ws) {
      runners.delete(entry.fingerprint);
      detachRunnerLink(entry.fingerprint, ws);
      closeRunnerChat(entry.fingerprint);
      audit({
        type: 'runner.disconnect',
        actor: `human:${entry.userId}`,
        effect: 'allow',
        detail: {
          fingerprint: entry.fingerprint,
          code,
          reason: String(reason),
          uptimeS: Math.round((Date.now() - entry.connectedAt) / 1000),
        },
      });
    }
  });
}
