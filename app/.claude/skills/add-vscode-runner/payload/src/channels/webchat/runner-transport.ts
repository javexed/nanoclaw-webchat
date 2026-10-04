/**
 * Request/response and upstream frames over the runner socket.
 *
 * Central → runner:  { type: 'req', id, op, ...payload }   the laptop tools: tools.list / tools.call
 * Runner  → central: { type: 'res', id, ok: true, ...result } | { type: 'res', id, ok: false, error }
 *                    { type: 'log', level, message }      runner diagnostics, surfaced in central's log
 *
 * The transport is deliberately dumb: it does not know what a tool is.
 * runner-tools.ts owns the ops; this file owns ids, timeouts and the fact that
 * a dropped socket fails every call in flight.
 */
import type { WebSocket } from 'ws';

import { log } from '../../log.js';

export interface RunnerLink {
  fingerprint: string;
  userId: string;
  ws: WebSocket;
}

export class RunnerRequestError extends Error {
  constructor(
    readonly code: 'not-connected' | 'timeout' | 'refused' | 'disconnected',
    message: string,
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
let seq = 0;

export function attachRunnerLink(link: RunnerLink): void {
  links.set(link.fingerprint, link);
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

/** Push a frame at a runner with no reply expected (the chat panel's frames). */
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
        p.reject(new RunnerRequestError('refused', String(frame.error ?? 'runner refused the request')));
      }
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

export function __resetRunnerTransportForTest(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  links.clear();
}
