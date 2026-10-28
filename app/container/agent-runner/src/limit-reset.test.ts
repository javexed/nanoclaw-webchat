import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { classifyRateLimitEvent } from './providers/claude.js';
import { runPollLoop } from './poll-loop.js';
import { LIMIT_RESETS_AT_FIELD, limitResetsAt } from './limit-reset.js';
import { resetLimitNotices } from './limit-notice.js';

describe('limitResetsAt', () => {
  it('reads the reset the rate-limit classifier writes', () => {
    const blocked = classifyRateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 });
    expect(limitResetsAt(blocked!.message)).toBe(new Date(1_900_000_000_000).toISOString());
  });

  it('gives null when there is no reset, or it does not parse', () => {
    expect(limitResetsAt('Rate limit [five_hour]')).toBeNull();
    expect(limitResetsAt('Rate limit (resets soon)')).toBeNull();
    expect(limitResetsAt(undefined)).toBeNull();
  });
});

describe('poll loop — rate-limit notice carries the reset', () => {
  beforeEach(() => {
    // Each case is a fresh account: one notice per reset would hold back the next.
    resetLimitNotices();
    initTestSessionDb();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('chat', 'Chat', 'channel', 'webchat', 'room-1', NULL)`,
      )
      .run();
  });
  afterEach(() => {
    closeSessionDb();
    resetLimitNotices();
  });

  async function noticeFor(error: { message: string; classification: string }): Promise<Record<string, unknown>> {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'room-1', 'webchat', ?)`,
      )
      .run(JSON.stringify({ sender: 'Alice', text: 'hi' }));
    const provider = new MockProvider({}, () => ({ error: { ...error, retryable: false } }));
    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }).catch(
      () => {},
    );
    const start = Date.now();
    while (getUndeliveredMessages().length === 0 && Date.now() - start < 1800) {
      await new Promise((r) => setTimeout(r, 30));
    }
    controller.abort();
    await Promise.race([loop, new Promise((r) => setTimeout(r, 200))]);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    return JSON.parse(out[0]!.content) as Record<string, unknown>;
  }

  it('adds the reset instant beside the text', async () => {
    const at = '2031-01-01T05:00:00.000Z';
    const content = await noticeFor({ message: `Rate limit [five_hour] (resets ${at})`, classification: 'rate_limit' });
    expect(content.text).toContain('rate limit');
    expect(content[LIMIT_RESETS_AT_FIELD]).toBe(at);
  });

  it('adds nothing when the limit gave no reset', async () => {
    const content = await noticeFor({ message: 'Rate limit [five_hour]', classification: 'rate_limit' });
    expect(LIMIT_RESETS_AT_FIELD in content).toBe(false);
  });

  it('adds nothing for credit exhaustion, which no wait fixes', async () => {
    const content = await noticeFor({
      message: 'Out of credits (resets 2031-01-01T05:00:00.000Z)',
      classification: 'quota',
    });
    expect(LIMIT_RESETS_AT_FIELD in content).toBe(false);
  });
});
