/**
 * What a learning review must NOT do to its surroundings: an auto-triggered
 * review stays silent even when it fails, and no review — auto or /learn —
 * clobbers the enclosing turn's tool count the auto-trigger reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { __resetLearningStateForTest, runLearningReview } from './learning-loop.js';
import { appendStatusEvent, getTurnToolCount } from './status-feed.js';
import type { RoutingContext } from './formatter.js';
import type { PollLoopConfig } from './poll-loop.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

const routing: RoutingContext = {
  platformId: 'room-1',
  channelType: 'webchat',
  threadId: 'main',
  inReplyTo: null,
  taskRun: false,
};

/** A provider whose one query yields `events`, calling `during` first. */
function scriptedProvider(events: ProviderEvent[], during: () => void = () => {}): AgentProvider {
  return {
    supportsRestrictedReview: true,
    query: () => ({
      push: () => {},
      end: () => {},
      abort: () => {},
      events: (async function* () {
        during();
        for (const e of events) yield e;
      })(),
    }),
  } as unknown as AgentProvider;
}

function config(provider: AgentProvider): PollLoopConfig {
  return { provider, providerName: 'mock', cwd: '/tmp' } as PollLoopConfig;
}

beforeEach(() => {
  __resetLearningStateForTest();
  initTestSessionDb();
  appendStatusEvent('start', null); // zero the module-global count
});
afterEach(() => {
  closeSessionDb();
});

const failing: ProviderEvent[] = [{ type: 'error', message: 'rate limited', retryable: false }];

describe('learning review error branch', () => {
  it('an auto-triggered review that fails posts nothing to the room', async () => {
    const outcome = await runLearningReview(config(scriptedProvider(failing)), routing, [], undefined, 'review', {
      announceDecline: false,
    });
    expect(outcome).toBe('error');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('a /learn someone typed still reports the failure', async () => {
    const outcome = await runLearningReview(config(scriptedProvider(failing)), routing, [], undefined, 'review');
    expect(outcome).toBe('error');
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain("Couldn't run the skill review (rate limited)");
  });
});

describe('learning review and the turn tool count', () => {
  it("neither the review's start nor its tool calls change the enclosing turn's count", async () => {
    for (let i = 0; i < 6; i++) appendStatusEvent('tool', 'Bash');
    expect(getTurnToolCount()).toBe(6);

    const provider = scriptedProvider([{ type: 'result', text: null } as ProviderEvent], () => {
      // The review's own tool activity flows through the same feed.
      appendStatusEvent('tool', 'mcp__nanoclaw__draft_skill');
      expect(getTurnToolCount()).toBe(6);
    });
    await runLearningReview(config(provider), routing, [], undefined, 'review', { announceDecline: false });

    expect(getTurnToolCount()).toBe(6);
    // And a real turn after the review still counts from its own start.
    appendStatusEvent('start', null);
    appendStatusEvent('tool', 'Read');
    expect(getTurnToolCount()).toBe(1);
  });
});
