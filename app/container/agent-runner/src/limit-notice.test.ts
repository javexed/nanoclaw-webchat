import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { FAILURE_NOTICE_FIELD } from './formatter.js';
import { LIMIT_RESETS_AT_FIELD } from './limit-reset.js';
import { conversationOf, limitCoversFailure, limitNotice, noteLimit, resetLimitNotices } from './limit-notice.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const now = Date.parse('2031-01-01T03:00:00.000Z');
const resets = '2031-01-01T05:00:00.000Z';
const rateLimit = (at: string | null) =>
  limitNotice('rate_limit', `Rate limit [five_hour]${at ? ` (resets ${at})` : ''}`);

describe('limit notices: one per conversation per reset', () => {
  beforeEach(() => resetLimitNotices());

  it('tells a conversation once per reset, and each conversation separately', () => {
    expect(noteLimit('webchat:room-a:', rateLimit(resets), now)).toBe(true);
    expect(noteLimit('webchat:room-a:', rateLimit(resets), now + 60_000)).toBe(false);
    expect(noteLimit('webchat:room-a:', rateLimit('2031-01-01T05:02:00.000Z'), now)).toBe(false);
    expect(noteLimit('webchat:room-b:', rateLimit(resets), now)).toBe(true);
    expect(noteLimit('webchat:room-a:t1', rateLimit(resets), now)).toBe(true);
  });

  it('tells again for a later window, and once the reset has passed', () => {
    noteLimit('c', rateLimit(resets), now);
    expect(noteLimit('c', rateLimit('2031-01-01T10:00:00.000Z'), now)).toBe(true);
    resetLimitNotices();
    noteLimit('c', rateLimit(resets), now);
    expect(noteLimit('c', rateLimit('2031-01-01T10:00:00.000Z'), Date.parse(resets) + 1)).toBe(true);
  });

  it('treats a limit with no stated reset as one short window', () => {
    expect(noteLimit('c', rateLimit(null), now)).toBe(true);
    expect(noteLimit('c', rateLimit(null), now + 10 * 60_000)).toBe(false);
    expect(noteLimit('c', rateLimit(null), now + 16 * 60_000)).toBe(true);
  });

  it('keeps our wording and the reset field', () => {
    const n = rateLimit(resets);
    expect(n.resetsAt).toBe(resets);
    expect(n.content[LIMIT_RESETS_AT_FIELD]).toBe(resets);
    expect(String(n.content.text)).toContain('Send that again in a bit');
    expect(LIMIT_RESETS_AT_FIELD in limitNotice('quota', `Out of credits (resets ${resets})`).content).toBe(false);
  });

  it('covers failures inside the window: silent where told, the notice where not', () => {
    expect(limitCoversFailure('a', now)).toBeNull();
    noteLimit('a', rateLimit(resets), now);
    expect(limitCoversFailure('a', now + 1000)).toBe('told');
    const other = limitCoversFailure('b', now + 1000);
    expect(other).not.toBeNull();
    expect(other).not.toBe('told');
    expect(limitCoversFailure('b', now + 2000)).toBe('told');
    expect(limitCoversFailure('c', Date.parse(resets) + 1)).toBeNull();
  });

  it('keys a conversation by channel, room and thread', () => {
    expect(conversationOf({ channelType: 'webchat', platformId: 'r', threadId: null })).toBe('webchat:r:');
    expect(conversationOf({ channelType: 'webchat', platformId: 'r', threadId: 't' })).toBe('webchat:r:t');
  });
});

describe('poll loop — parallel turns on an exhausted account', () => {
  const CHAT = { platformId: 'room-1', channelType: 'webchat', threadId: null, inReplyTo: 'm1', taskRun: false };
  const reset = new Date(Date.now() + 2 * 3600_000).toISOString();

  beforeEach(() => {
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

  /** A turn that hits the limit and then ends in an error result, as the Claude provider reports it. */
  function limitedTurn(): AgentQuery {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      await new Promise((r) => setTimeout(r, 20));
      yield {
        type: 'error',
        message: `Rate limit [five_hour] (resets ${reset})`,
        retryable: false,
        classification: 'rate_limit',
      };
      yield { type: 'result', text: null, isError: true, error: 'Claude AI usage limit reached' };
    }
    return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
  }
  const chat = () =>
    getUndeliveredMessages()
      .filter((m) => m.kind === 'chat')
      .map((m) => JSON.parse(m.content) as Record<string, unknown>);

  it('posts one limit notice and no failure notice', async () => {
    const [a, b] = await Promise.all([
      processQuery(limitedTurn(), CHAT, ['m1'], 'claude', undefined, 'prompt', undefined, false),
      processQuery(
        limitedTurn(),
        { ...CHAT, inReplyTo: 'm2' },
        ['m2'],
        'claude',
        undefined,
        'prompt',
        undefined,
        false,
      ),
    ]);
    const out = chat();
    expect(out).toHaveLength(1);
    expect(out[0]![LIMIT_RESETS_AT_FIELD]).toBe(reset);
    expect(out.some((c) => c[FAILURE_NOTICE_FIELD])).toBe(false);
    // The withheld repeat still counts as the turn's answer: no empty-turn fallback.
    expect(a.producedOutput && b.producedOutput).toBe(true);
  });

  it('tells another thread once, and gives it the limit notice when its run just fails', async () => {
    await processQuery(limitedTurn(), CHAT, ['m1'], 'claude', undefined, 'prompt', undefined, false);
    async function* failing(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's2' };
      yield { type: 'result', text: null, isError: true, error: 'Claude AI usage limit reached' };
    }
    const thread = { ...CHAT, threadId: 't1', inReplyTo: 'm3' };
    await processQuery(
      { push: () => {}, end: () => {}, abort: () => {}, events: failing() },
      thread,
      ['m3'],
      'claude',
      undefined,
      'prompt',
      undefined,
      false,
    );
    const out = chat();
    expect(out).toHaveLength(2);
    expect(out.every((c) => c[LIMIT_RESETS_AT_FIELD] === reset)).toBe(true);
    expect(out.some((c) => c[FAILURE_NOTICE_FIELD])).toBe(false);
  });
});
