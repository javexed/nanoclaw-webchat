import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import {
  RunnerRequestError,
  __resetRunnerTransportForTest,
  attachRunnerLink,
  connectedRunnerFingerprints,
  detachRunnerLink,
  handleRunnerFrame,
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
    const p = runnerRequest(FP, 'tools.list', { name: 'n' });
    const req = ws.sent[0];
    expect(req).toMatchObject({ type: 'req', op: 'tools.list', name: 'n' });
    expect(handleRunnerFrame(FP, { type: 'res', id: req.id, ok: true, state: 'running' })).toBe(true);
    expect(await p).toEqual({ state: 'running' });
    expect(connectedRunnerFingerprints()).toEqual([FP]);
  });

  it('a refusal rejects with its error; a foreign answer is dropped; a timeout rejects', async () => {
    __resetRunnerTransportForTest();
    vi.useFakeTimers();
    const ws = fakeWs();
    attachRunnerLink({ fingerprint: FP, userId: 'u', ws });
    const p1 = runnerRequest(FP, 'tools.call', {}, 1000);
    const id = ws.sent[0].id;
    handleRunnerFrame('b'.repeat(64), { type: 'res', id, ok: false, error: 'impostor' }); // wrong runner: ignored
    handleRunnerFrame(FP, { type: 'res', id, ok: false, error: 'folder not allowed' });
    await expect(p1).rejects.toMatchObject({ code: 'refused', message: 'folder not allowed' });
    const p2 = runnerRequest(FP, 'tools.list', {}, 1000);
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

  it('takes log frames; the frames of the retired laptop container are not its own', () => {
    __resetRunnerTransportForTest();
    expect(handleRunnerFrame(FP, { type: 'log', level: 'info', message: 'hi' })).toBe(true);
    for (const type of ['event', 'heartbeat', 'runtime', 'weird'])
      expect(handleRunnerFrame(FP, { type, key, kind: 'terminal' }), type).toBe(false);
  });

  it('a stale socket closing leaves the live link alone', () => {
    __resetRunnerTransportForTest();
    const ws = fakeWs();
    attachRunnerLink({ fingerprint: FP, userId: 'u', ws });
    detachRunnerLink(FP, fakeWs());
    expect(connectedRunnerFingerprints()).toEqual([FP]);
    detachRunnerLink(FP, ws);
    expect(connectedRunnerFingerprints()).toEqual([]);
  });
});
