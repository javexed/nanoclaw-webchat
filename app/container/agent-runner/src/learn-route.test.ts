import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import { __resetLearningStateForTest } from './learning-loop.js';
import { MockProvider } from './providers/mock.js';
import type { QueryInput } from './providers/types.js';

const isReview = (i: { moduleInput?: Record<string, unknown> }): boolean =>
  (i.moduleInput as { learningReview?: boolean } | undefined)?.learningReview === true;

class RestrictedMock extends MockProvider {
  readonly supportsRestrictedReview = true;
}

beforeEach(() => {
  __resetLearningStateForTest();
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('room-1', 'Room One', 'channel', 'webchat', 'room-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertChat(id: string, text: string, opts: { senderId?: string; threadId?: string | null } = {}) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'room-1', 'webchat', ?, ?)`,
    )
    .run(id, opts.threadId ?? 'main', JSON.stringify({ sender: 'Alice', senderId: opts.senderId, text }));
}

function outboundSystemActions(): Array<Record<string, unknown>> {
  return (
    getOutboundDb().prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as { content: string }[]
  ).map((r) => JSON.parse(r.content) as Record<string, unknown>);
}

type LoopConfig = Parameters<typeof runPollLoop>[0];

async function runLoopUntil(config: Omit<LoopConfig, 'signal'>, until: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loopPromise = Promise.race([
    runPollLoop({ ...config, signal: controller.signal }),
    new Promise<void>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
  ]).catch(() => {});
  const start = Date.now();
  while (!until() && Date.now() - start < 2500) {
    await new Promise((r) => setTimeout(r, 50));
  }
  controller.abort();
  await loopPromise;
}

describe('charge-invoker routing (/learn → route_learning_review)', () => {
  it('routes instead of running when the session is not the invoker’s member session', async () => {
    const inputs: QueryInput[] = [];
    const provider = new RestrictedMock({}, (_prompt: string, input: QueryInput) => {
      inputs.push(input);
      return 'ok';
    });

    insertChat('l-1', '/learn focus on requests', { senderId: 'webchat:alice' });
    await runLoopUntil(
      { provider, providerName: 'mock', cwd: '/tmp', learning: { chargeInvoker: 'auto' } },
      () => outboundSystemActions().some((a) => a.action === 'route_learning_review'),
    );

    const action = outboundSystemActions().find((a) => a.action === 'route_learning_review');
    expect(action).toBeDefined();
    expect(action!.text).toBe('/learn focus on requests');
    expect(action!.requested_by).toBe('webchat:alice');
    expect(action!.origin).toEqual({ channel_type: 'webchat', platform_id: 'room-1' });
    // Routed means NOT run here — no provider query at all.
    expect(inputs).toHaveLength(0);
  });

  it('runs locally when the session thread IS the invoker (already self-funded)', async () => {
    const inputs: QueryInput[] = [];
    const provider = new RestrictedMock({}, (_prompt: string, input: QueryInput) => {
      inputs.push(input);
      return { result: '<message to="room-1">Nothing worth keeping.</message>' };
    });

    insertChat('l-2', '/learn', { senderId: 'webchat:alice', threadId: 'webchat:alice' });
    await runLoopUntil(
      { provider, providerName: 'mock', cwd: '/tmp', learning: { chargeInvoker: 'auto' } },
      () => inputs.length > 0,
    );

    expect(inputs).toHaveLength(1);
    expect(isReview(inputs[0])).toBe(true);
    expect(outboundSystemActions().some((a) => a.action === 'route_learning_review')).toBe(false);
  });

  it('routes even when chargeInvoker is off — the host applies the membership gate', async () => {
    const inputs: QueryInput[] = [];
    const provider = new RestrictedMock({}, (_prompt: string, input: QueryInput) => {
      inputs.push(input);
      return { result: '<message to="room-1">Nothing worth keeping.</message>' };
    });

    insertChat('l-3', '/learn', { senderId: 'webchat:alice' });
    await runLoopUntil(
      { provider, providerName: 'mock', cwd: '/tmp', learning: { chargeInvoker: 'off' } },
      () => outboundSystemActions().some((a) => a.action === 'route_learning_review'),
    );

    const action = outboundSystemActions().find((a) => a.action === 'route_learning_review');
    expect(action).toBeDefined();
    expect(action!.charge_mode).toBe('off'); // host gates membership even here
    expect(inputs).toHaveLength(0); // not run locally — the host decides who pays
  });

  it('runs locally when the sender is unidentifiable (nobody to gate)', async () => {
    const inputs2: QueryInput[] = [];
    const provider2 = new RestrictedMock({}, (_p: string, input: QueryInput) => {
      inputs2.push(input);
      return { result: '<message to="room-1">Nothing worth keeping.</message>' };
    });

    insertChat('l-4', '/learn', {}); // no senderId
    await runLoopUntil({ provider: provider2, providerName: 'mock', cwd: '/tmp' }, () => inputs2.length > 0);

    expect(isReview(inputs2[0])).toBe(true);
    expect(outboundSystemActions().some((a) => a.action === 'route_learning_review')).toBe(false);
  });
});

describe('/learn-routed — the receiving end', () => {
  it('runs the review with the carried digest and addresses the origin room', async () => {
    const inputs: QueryInput[] = [];
    const provider = new RestrictedMock({}, (_prompt: string, input: QueryInput) => {
      inputs.push(input);
      return { result: '<message to="room-1">Nothing worth keeping.</message>' };
    });

    const payload = JSON.stringify({
      text: '/learn',
      digest: '<exchange>ROOM-DIGEST-MARKER</exchange>',
      origin: { channel_type: 'webchat', platform_id: 'room-1' },
      requested_by: 'webchat:alice',
    });
    insertChat('r-1', `/learn-routed ${payload}`, { threadId: 'webchat:alice' });
    await runLoopUntil(
      { provider, providerName: 'mock', cwd: '/tmp', learning: { chargeInvoker: 'auto' } },
      () => getUndeliveredMessages().length > 0,
    );

    expect(inputs).toHaveLength(1);
    expect(isReview(inputs[0])).toBe(true);
    expect(inputs[0].prompt).toContain('ROOM-DIGEST-MARKER');
    // Never re-routes — no second route action from the receiving end.
    expect(outboundSystemActions().some((a) => a.action === 'route_learning_review')).toBe(false);
    // The one-sentence outcome lands in the ORIGIN room.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('room-1');
    expect(JSON.parse(out[0].content).text).toBe('Nothing worth keeping.');
  });
});
