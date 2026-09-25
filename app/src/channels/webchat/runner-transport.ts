/**
 * Request/response and upstream frames over the runner socket.
 *
 * Central → runner:  { type: 'req', id, op, ...payload }
 * Runner  → central: { type: 'res', id, ok: true, ...result } | { type: 'res', id, ok: false, error, failure? }
 * Runner  → central: { type: 'event', key, kind }        SessionEvent, exactly as the docker driver emits
 *                    { type: 'heartbeat', key, mtimeMs }  the container's liveness file, mirrored centrally
 *                    { type: 'log', level, message }      runner diagnostics, surfaced in central's log
 *                    { type: 'runtime', reachable, detail? } the laptop's container runtime went away / came back
 *
 * The transport is deliberately dumb: it does not know what a spec is. The
 * fleet driver owns the ops; this file owns ids, timeouts and the fact that a
 * dropped socket fails every call in flight.
 */
import type { WebSocket } from 'ws';

import type { SessionEvent, SessionFailure } from '../../drivers/types.js';
import { log } from '../../log.js';
import { isSafeRunnerId } from './runner-registry.js';

export interface RunnerLink {
  fingerprint: string;
  userId: string;
  ws: WebSocket;
}

export class RunnerRequestError extends Error {
  constructor(
    readonly code: 'not-connected' | 'timeout' | 'refused' | 'disconnected',
    message: string,
    readonly failure?: SessionFailure,
  ) {
    super(message);
    this.name = 'RunnerRequestError';
  }
}

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  fingerprint: string;
};

const links = new Map<string, RunnerLink>();
const pending = new Map<string, Pending>();
const eventSubscribers = new Set<(fingerprint: string, event: SessionEvent) => void>();
const heartbeatSubscribers = new Set<(fingerprint: string, key: SessionEvent['key'], mtimeMs: number) => void>();
const attachSubscribers = new Set<(fingerprint: string) => void>();
const detachSubscribers = new Set<(fingerprint: string) => void>();
const runtimeSubscribers = new Set<(fingerprint: string, reachable: boolean, detail?: string) => void>();
let seq = 0;

export function attachRunnerLink(link: RunnerLink): void {
  links.set(link.fingerprint, link);
  for (const cb of attachSubscribers) {
    try {
      cb(link.fingerprint);
    } catch (err) {
      log.warn('Runner attach subscriber threw', { fingerprint: link.fingerprint.slice(0, 12), err });
    }
  }
}
/** A runner (re)connected. Its side may have forgotten everything — a reload, a restart — so whoever owns sessions there re-asserts them. */
export function onRunnerAttached(cb: (fingerprint: string) => void): void {
  attachSubscribers.add(cb);
}
/** A runner's socket closed: a laptop that slept, lost its network, or quit. Owners hold what they placed there. */
export function onRunnerDetached(cb: (fingerprint: string) => void): void {
  detachSubscribers.add(cb);
}
/** The runner's container runtime stopped (or resumed) answering while its socket stayed up. */
export function onRunnerRuntime(cb: (fingerprint: string, reachable: boolean, detail?: string) => void): void {
  runtimeSubscribers.add(cb);
}
export function detachRunnerLink(fingerprint: string, ws: WebSocket): void {
  if (links.get(fingerprint)?.ws !== ws) return;
  links.delete(fingerprint);
  for (const [id, p] of pending) {
    if (p.fingerprint !== fingerprint) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new RunnerRequestError('disconnected', 'runner disconnected while the request was in flight'));
  }
  for (const cb of detachSubscribers) {
    try {
      cb(fingerprint);
    } catch (err) {
      log.warn('Runner detach subscriber threw', { fingerprint: fingerprint.slice(0, 12), err });
    }
  }
}
export function isRunnerConnected(fingerprint: string): boolean {
  return links.has(fingerprint);
}
export function connectedRunnerFingerprints(): string[] {
  return [...links.keys()];
}

/** Send a request; resolves with the runner's result fields, rejects with RunnerRequestError. */
export function runnerRequest(
  fingerprint: string,
  op: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const link = links.get(fingerprint);
  if (!link || link.ws.readyState !== link.ws.OPEN) {
    return Promise.reject(
      new RunnerRequestError('not-connected', `runner ${fingerprint.slice(0, 12)} is not connected`),
    );
  }
  const id = `r${Date.now().toString(36)}-${(seq++).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new RunnerRequestError('timeout', `runner did not answer ${op} within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer, fingerprint });
    link.ws.send(JSON.stringify({ type: 'req', id, op, ...payload }));
  });
}

/** Push a frame at a runner with no reply expected — the relay's tunnels, which are not request/response. */
export function sendRunnerFrame(fingerprint: string, frame: Record<string, unknown>): boolean {
  const link = links.get(fingerprint);
  if (!link || link.ws.readyState !== link.ws.OPEN) return false;
  link.ws.send(JSON.stringify(frame));
  return true;
}

/** Route an upstream frame. Returns true when the frame belonged to the transport. */
export function handleRunnerFrame(fingerprint: string, frame: Record<string, unknown>): boolean {
  switch (frame.type) {
    case 'res': {
      const p = pending.get(String(frame.id));
      if (!p || p.fingerprint !== fingerprint) return true; // late or foreign answer: drop
      clearTimeout(p.timer);
      pending.delete(String(frame.id));
      if (frame.ok === true) {
        const { type: _t, id: _i, ok: _o, ...rest } = frame;
        p.resolve(rest);
      } else {
        p.reject(
          new RunnerRequestError(
            'refused',
            String(frame.error ?? 'runner refused the request'),
            frame.failure as SessionFailure | undefined,
          ),
        );
      }
      return true;
    }
    case 'event': {
      const key = frame.key as SessionEvent['key'] | undefined;
      const kind = frame.kind;
      if (
        !key ||
        !isSafeRunnerId(key.agentGroupId) ||
        !isSafeRunnerId(key.sessionId) ||
        !isSafeRunnerId(key.installSlug)
      )
        return true;
      if (kind !== 'terminal' && kind !== 'phase' && kind !== 'hint') return true;
      for (const cb of eventSubscribers) cb(fingerprint, { key, kind });
      return true;
    }
    case 'heartbeat': {
      const key = frame.key as SessionEvent['key'] | undefined;
      if (!key || !isSafeRunnerId(key.agentGroupId) || !isSafeRunnerId(key.sessionId)) return true;
      const mtimeMs = typeof frame.mtimeMs === 'number' ? frame.mtimeMs : Date.now();
      for (const cb of heartbeatSubscribers)
        cb(
          fingerprint,
          { installSlug: String(key.installSlug ?? ''), agentGroupId: key.agentGroupId, sessionId: key.sessionId },
          mtimeMs,
        );
      return true;
    }
    case 'runtime': {
      if (typeof frame.reachable !== 'boolean') return true;
      const detail = typeof frame.detail === 'string' ? frame.detail.slice(0, 300) : undefined;
      for (const cb of runtimeSubscribers) cb(fingerprint, frame.reachable, detail);
      return true;
    }
    case 'log': {
      const level = frame.level === 'warn' || frame.level === 'error' ? 'warn' : 'info';
      log[level](`Runner ${fingerprint.slice(0, 12)}: ${String(frame.message ?? '').slice(0, 500)}`);
      return true;
    }
    default:
      return false;
  }
}

export function onRunnerEvent(cb: (fingerprint: string, event: SessionEvent) => void): () => void {
  eventSubscribers.add(cb);
  return () => eventSubscribers.delete(cb);
}
export function onRunnerHeartbeat(
  cb: (fingerprint: string, key: SessionEvent['key'], mtimeMs: number) => void,
): () => void {
  heartbeatSubscribers.add(cb);
  return () => heartbeatSubscribers.delete(cb);
}
export function __resetRunnerTransportForTest(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  links.clear();
  eventSubscribers.clear();
  heartbeatSubscribers.clear();
  detachSubscribers.clear();
  runtimeSubscribers.clear();
}
