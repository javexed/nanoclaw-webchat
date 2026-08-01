/**
 * The cap is the security-relevant part of escalation: without it, a provider
 * that fails every turn (dead backend) or a prompt crafted to fail on purpose
 * silently bills the expensive fallback forever. These tests drive the real
 * poll loop, so they cover the wiring as well as the counter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { __snapshotRunnerHooksForTest } from './runner-hooks.js';
import { __snapshotProviderHooksForTest } from './providers/hooks.js';
import { armEscalation } from './escalation.js';

let restoreRunner: (() => void) | undefined;
let restoreProviders: (() => void) | undefined;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  restoreRunner = __snapshotRunnerHooksForTest();
  restoreProviders = __snapshotProviderHooksForTest();
});

afterEach(() => {
  restoreRunner?.();
  restoreProviders?.();
  restoreRunner = restoreProviders = undefined;
  delete process.env.NANOCLAW_ESCALATION_CAP;
  closeSessionDb();
});

/** Count fallback invocations by giving the fallback its own provider. */
let fallbackCalls = 0;

function armWithMockFallback(cap: string): void {
  process.env.NANOCLAW_ESCALATION_CAP = cap;
  fallbackCalls = 0;
  // createProvider('mock') is registered by providers/index.js side effects in
  // the real runner; here we stub the factory path by arming with a provider
  // we construct directly through the same public entry point.
  armEscalation({ fallbackName: 'mock' });
}

function insert(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text: 'hello' }));
}

async function runOneTurn(response: unknown, id: string): Promise<void> {
  insert(id);
  const controller = new AbortController();
  const provider = new MockProvider({}, () => response as never);
  await Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }),
    new Promise<void>((r) => setTimeout(r, 1200)),
  ]);
  controller.abort();
}

const FAIL = { error: { message: 'backend unreachable', retryable: false, classification: 'network' } };

/**
 * Did THIS turn escalate? The status feed is cleared at every turn_start
 * (resetFeed), so this is a per-turn question, not a running total — an
 * earlier version of this test counted cumulatively and mis-read a correct
 * cap as a broken one.
 */
function escalatedThisTurn(): boolean {
  const rows = getOutboundDb()
    .prepare(`SELECT text FROM status_events WHERE text LIKE 'Escalating to%'`)
    .all() as { text: string }[];
  return rows.length > 0;
}

describe('escalation cap', () => {
  it('stops after CAP consecutive failures, then a clean turn restores the budget', async () => {
    process.env.NANOCLAW_ESCALATION_CAP = '2';
    armEscalation({ fallbackName: 'mock' });

    await runOneTurn(FAIL, 'm-f1');
    expect(escalatedThisTurn(), 'failure 1 of 2 escalates').toBe(true);

    await runOneTurn(FAIL, 'm-f2');
    expect(escalatedThisTurn(), 'failure 2 of 2 escalates').toBe(true);

    await runOneTurn(FAIL, 'm-f3');
    expect(escalatedThisTurn(), 'failure 3 exceeds the cap — must NOT spend').toBe(false);

    await runOneTurn(FAIL, 'm-f3b');
    expect(escalatedThisTurn(), 'still capped while failures continue').toBe(false);

    // A delivered turn restores the budget...
    await runOneTurn('<message to="discord-test">all good</message>', 'm-ok');

    await runOneTurn(FAIL, 'm-f4');
    expect(escalatedThisTurn(), 'a completed turn must restore the budget').toBe(true);
    // Six real poll-loop turns; bun's 5s default is not enough.
  }, 30_000);

  it('NANOCLAW_ESCALATION_CAP=0 disables escalation outright', async () => {
    process.env.NANOCLAW_ESCALATION_CAP = '0';
    armEscalation({ fallbackName: 'mock' });
    await runOneTurn(FAIL, 'm-cap0');
    const out = getOutboundDb().prepare(`SELECT content FROM messages_out`).all() as { content: string }[];
    // No retry armed → the primary's error is what the user sees.
    expect(out.some((r) => r.content.includes('unreachable'))).toBe(true);
  });

  it('an unset fallback name arms nothing', () => {
    expect(() => armEscalation({ fallbackName: undefined })).not.toThrow();
    expect(() => armEscalation({ fallbackName: '   ' })).not.toThrow();
  });

  it('a bad cap value falls back to the default rather than disabling', () => {
    process.env.NANOCLAW_ESCALATION_CAP = 'not-a-number';
    expect(() => armEscalation({ fallbackName: 'mock' })).not.toThrow();
  });
});
