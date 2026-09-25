import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import {
  RunnerRequestError,
  __resetRunnerTransportForTest,
  attachRunnerLink,
  connectedRunnerFingerprints,
  detachRunnerLink,
  handleRunnerFrame,
  onRunnerDetached,
  onRunnerEvent,
  onRunnerHeartbeat,
  onRunnerRuntime,
  runnerRequest,
} from './runner-transport.js';

// The transport only needs send() and readyState from a socket.
function fakeWs(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { OPEN: 1, readyState: 1, sent, send: (s: string) => sent.push(JSON.parse(s)) } as unknown as WebSocket & {
    sent: typeof sent;
  };
}
const FP = 'a'.repeat(64);
const key = { installSlug: 'i', agentGroupId: 'g', sessionId: 's' };

describe('runner transport', () => {
  it('correlates responses by id and strips the envelope', async () => {
    __resetRunnerTransportForTest();
    const ws = fakeWs();
    attachRunnerLink({ fingerprint: FP, userId: 'u', ws });
    const p = runnerRequest(FP, 'status', { name: 'n' });
    const req = ws.sent[0];
    expect(req).toMatchObject({ type: 'req', op: 'status', name: 'n' });
    expect(handleRunnerFrame(FP, { type: 'res', id: req.id, ok: true, state: 'running' })).toBe(true);
    expect(await p).toEqual({ state: 'running' });
    expect(connectedRunnerFingerprints()).toEqual([FP]);
  });

  it('a refusal carries the runner failure; a foreign answer is dropped; a timeout rejects', async () => {
    __resetRunnerTransportForTest();
    vi.useFakeTimers();
    const ws = fakeWs();
    attachRunnerLink({ fingerprint: FP, userId: 'u', ws });
    const p1 = runnerRequest(FP, 'prepare', {}, 1000);
    const id = ws.sent[0].id;
    handleRunnerFrame('b'.repeat(64), { type: 'res', id, ok: false, error: 'impostor' }); // wrong runner: ignored
    handleRunnerFrame(FP, {
      type: 'res',
      id,
      ok: false,
      error: 'no docker',
      failure: { kind: 'runtime-unavailable', retryable: true },
    });
    await expect(p1).rejects.toMatchObject({ code: 'refused', failure: { kind: 'runtime-unavailable' } });
    const p2 = runnerRequest(FP, 'status', {}, 1000);
    vi.advanceTimersByTime(1001);
    await expect(p2).rejects.toMatchObject({ code: 'timeout' });
    vi.useRealTimers();
  });

  it('detaching a link fails every in-flight request for that runner only', async () => {
    __resetRunnerTransportForTest();
    const a = fakeWs();
    const b = fakeWs();
    attachRunnerLink({ fingerprint: FP, userId: 'u', ws: a });
    attachRunnerLink({ fingerprint: 'b'.repeat(64), userId: 'u', ws: b });
    const pa = runnerRequest(FP, 'x');
    const pb = runnerRequest('b'.repeat(64), 'x');
    detachRunnerLink(FP, a);
    await expect(pa).rejects.toBeInstanceOf(RunnerRequestError);
    handleRunnerFrame('b'.repeat(64), { type: 'res', id: b.sent[0].id, ok: true });
    expect(await pb).toEqual({});
    await expect(runnerRequest(FP, 'x')).rejects.toMatchObject({ code: 'not-connected' });
    detachRunnerLink('b'.repeat(64), fakeWs()); // a different socket: not this link, no-op
    expect(connectedRunnerFingerprints()).toEqual(['b'.repeat(64)]);
  });

  it('routes event/heartbeat/log frames and rejects malformed ones quietly', () => {
    __resetRunnerTransportForTest();
    const events: unknown[] = [];
    const beats: unknown[] = [];
    onRunnerEvent((fp, e) => events.push([fp, e]));
    onRunnerHeartbeat((fp, k, m) => beats.push([fp, k, m]));
    expect(handleRunnerFrame(FP, { type: 'event', key, kind: 'terminal' })).toBe(true);
    expect(handleRunnerFrame(FP, { type: 'event', key, kind: 'bogus' })).toBe(true);
    expect(handleRunnerFrame(FP, { type: 'event', key: { agentGroupId: 'g' }, kind: 'terminal' })).toBe(true);
    // Key fields become path segments (the heartbeat file): anything but a plain id is dropped.
    expect(handleRunnerFrame(FP, { type: 'event', key: { ...key, agentGroupId: '../etc' }, kind: 'terminal' })).toBe(
      true,
    );
    expect(handleRunnerFrame(FP, { type: 'heartbeat', key: { ...key, sessionId: '..' }, mtimeMs: 1 })).toBe(true);
    expect(handleRunnerFrame(FP, { type: 'heartbeat', key, mtimeMs: 42 })).toBe(true);
    expect(handleRunnerFrame(FP, { type: 'log', level: 'info', message: 'hi' })).toBe(true);
    expect(handleRunnerFrame(FP, { type: 'weird' })).toBe(false);
    expect(events).toEqual([[FP, { key, kind: 'terminal' }]]);
    expect(beats).toEqual([[FP, key, 42]]);
  });

  it('reports a runtime going away or coming back, and a link closing', () => {
    __resetRunnerTransportForTest();
    const runtime: unknown[] = [];
    const detached: string[] = [];
    onRunnerRuntime((fp, reachable, detail) => runtime.push([fp, reachable, detail]));
    onRunnerDetached((fp) => detached.push(fp));
    expect(handleRunnerFrame(FP, { type: 'runtime', reachable: false, detail: 'podman: connection refused' })).toBe(
      true,
    );
    expect(handleRunnerFrame(FP, { type: 'runtime', reachable: true })).toBe(true);
    expect(handleRunnerFrame(FP, { type: 'runtime', reachable: 'yes' })).toBe(true); // malformed: dropped
    expect(runtime).toEqual([
      [FP, false, 'podman: connection refused'],
      [FP, true, undefined],
    ]);
    const ws = fakeWs();
    attachRunnerLink({ fingerprint: FP, userId: 'u', ws });
    detachRunnerLink(FP, fakeWs()); // a stale socket closing: not this link
    expect(detached).toEqual([]);
    detachRunnerLink(FP, ws);
    expect(detached).toEqual([FP]);
  });
});
