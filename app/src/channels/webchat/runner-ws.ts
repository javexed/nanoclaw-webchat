/**
 * Runner endpoint — `/ws/runner`.
 *
 * The VS Code extension on a developer's machine connects OUT to this path
 * over the same front door the PWA uses. The connection must authenticate as
 * a person (Tailscale or the SSO proxy header): a shared bearer token says
 * nothing about who is on the other end, and a machine that realises
 * containers and carries model traffic is bound to one person.
 *
 * This file owns the socket: hello, keepalive, pairing state and audit. The
 * frames it carries belong to runner-transport (requests, events,
 * heartbeats), runner-relay (streams) and runner-chat (the editor's chat).
 */
import type http from 'http';
import type { Duplex } from 'stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { audit } from '../../audit.js';
import { log } from '../../log.js';
import { authenticateRequest, type AuthFailure, type AuthResult } from './auth.js';
import { registerUpgradeHandler, type UpgradeHandler } from './ws.js';
import { closeRunnerChat, handleChatFrame, setupRunnerChat, type ChatDeps } from './runner-chat.js';
import { attachRunnerLink, detachRunnerLink, handleRunnerFrame } from './runner-transport.js';
import { readExtensionManifest } from './runner-extension.js';
import { closeRunnerStreams, handleRelayFrame } from './runner-relay.js';
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
 * Per-frame ceiling. A runner's answers carry mailbox rows (an agent reply
 * quoting a large file easily passes 256 KB) and relay data; 256 KB was hit in
 * the field. Bounded, but generous.
 */
export const MAX_PAYLOAD = 32 * 1024 * 1024;

export interface RunnerMachine {
  fingerprint: string;
  hostname: string;
  os: string;
  arch: string;
  runner: string;
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
/** Push a pairing decision to the live socket (if any) and mirror it in the listing. */
export function applyPairingChange(fingerprint: string, status: RunnerMachineStatus): boolean {
  const live = runners.get(fingerprint);
  if (!live) return false;
  live.pairing = status;
  send(live.ws, { type: 'pairing', status });
  if (status === 'revoked') live.ws.close(4403, 'machine-revoked');
  return true;
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
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth, remoteIp, keepaliveMs));
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

function onConnection(ws: WebSocket, auth: AuthResult, remoteIp: string, keepaliveMs: number): void {
  let entry: Live | null = null;

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
      if (frame.type !== 'hello') {
        send(ws, { type: 'error', code: 'hello-first', message: 'first frame must be hello' });
        return;
      }
      const m = (frame.machine ?? {}) as Partial<RunnerMachine>;
      if (frame.v !== RUNNER_PROTOCOL_VERSION || !isSafeRunnerId(m.fingerprint)) {
        send(ws, {
          type: 'error',
          code: 'bad-hello',
          message: `hello must carry v=${RUNNER_PROTOCOL_VERSION} and machine.fingerprint`,
        });
        ws.close(4400, 'bad hello');
        return;
      }
      clearTimeout(helloTimer);
      const machine = await activeRegistry.recordMachineSeen({
        fingerprint: m.fingerprint,
        userId: auth.userId,
        hostname: String(m.hostname ?? ''),
        os: String(m.os ?? ''),
        arch: String(m.arch ?? ''),
        runnerVersion: String(m.runner ?? ''),
      });
      // A pairing binds one user to one fingerprint; a revoked machine stays
      // out until an owner re-approves it. Both are refused AFTER auth, so the
      // audit row names the real person who tried.
      const refusal =
        machine.user_id !== auth.userId
          ? 'fingerprint-bound-to-other-user'
          : machine.status === 'revoked'
            ? 'machine-revoked'
            : null;
      if (refusal) {
        audit({
          type: 'runner.refused',
          actor: `human:${auth.userId}`,
          effect: 'deny',
          detail: { reason: refusal, fingerprint: m.fingerprint, ip: remoteIp },
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
        return;
      }
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
        hostname: String(m.hostname ?? ''),
        os: String(m.os ?? ''),
        arch: String(m.arch ?? ''),
        runnerVersion: String(m.runner ?? ''),
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
        // The runner build this install serves; the extension offers the update when it is newer.
        ...updateOffer(),
      });
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
      default:
        if (handleRunnerFrame(entry.fingerprint, frame)) break;
        if (handleRelayFrame(entry.fingerprint, frame)) break;
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
      closeRunnerStreams(entry.fingerprint);
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
