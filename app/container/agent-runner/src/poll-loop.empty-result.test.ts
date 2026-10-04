import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

// An empty result that came back while the model was still working: the turn
// must stay open (one nudge), so the late reply still delivers, instead of
// closing the query under the model and reporting the agent as failed.

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});
afterEach(() => closeSessionDb());

const CHAT = { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1', taskRun: false };

function stub(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return { pushes, query: { push: (m: string) => void pushes.push(m), end: () => {}, events, abort: () => {} } };
}
const delivered = () =>
  getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
const emptyNudges = (pushes: string[]) => pushes.filter((p) => p.includes('ended without a reply'));

describe('an empty result with nothing delivered', () => {
  it('keeps the turn open with one nudge, and the late reply delivers', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: '' }; // early, while the model still works
      yield { type: 'result', text: '<message to="discord-main">The real answer.</message>' };
      yield { type: 'result', text: '<internal>done</internal>' }; // the nudge's answer
    }
    const { query, pushes } = stub(events());
    const r = await processQuery(query, CHAT, ['m1'], 'claude', undefined, 'prompt', undefined, false);
    expect(delivered()).toEqual(['The real answer.']);
    expect(emptyNudges(pushes)).toHaveLength(1);
    expect(r.producedOutput).toBe(true);
  });

  it('nudges once only: a second empty result ends the turn', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: '' };
      yield { type: 'result', text: '' };
    }
    const { query, pushes } = stub(events());
    await processQuery(query, CHAT, ['m1'], 'claude', undefined, 'prompt', undefined, false);
    expect(emptyNudges(pushes)).toHaveLength(1);
  });

  it('does not nudge after a reply went out, or on a task run', async () => {
    async function* replied(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Sent mid-turn.</message>' };
      yield { type: 'result', text: '' };
    }
    const a = stub(replied());
    await processQuery(a.query, CHAT, ['m1'], 'claude', undefined, 'prompt', undefined, true);
    expect(emptyNudges(a.pushes)).toHaveLength(0);

    async function* task(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: '' };
    }
    const b = stub(task());
    await processQuery(b.query, { ...CHAT, taskRun: true }, ['m1'], 'claude', undefined, 'prompt', undefined, false);
    expect(emptyNudges(b.pushes)).toHaveLength(0);
  });

  it("archives the nudge's answer against the prompt it answers, not a follow-up queued meanwhile", async () => {
    const { query, pushes } = stub(
      (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 's1' };
        getInboundDb()
          .prepare(
            `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
             VALUES ('m2', 'chat', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', NULL, 1, 0, ?)`,
          )
          .run(JSON.stringify({ sender: 'User', text: 'follow-up while busy' }));
        const deadline = Date.now() + 5000;
        while (!pushes.some((p) => p.includes('follow-up while busy')) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        yield { type: 'result', text: '' }; // the first prompt's, empty: nudged
        yield { type: 'result', text: '<message to="discord-main">Re: follow-up.</message>' };
        yield { type: 'result', text: '<message to="discord-main">The real answer.</message>' }; // the nudge's
      })(),
    );
    const exchanges: ProviderExchange[] = [];
    await processQuery(query, CHAT, ['m1'], 'claude', (x) => void exchanges.push(x), 'prompt', undefined, false);
    expect(emptyNudges(pushes)).toHaveLength(1);
    expect(exchanges.map((x) => x.prompt.includes('follow-up while busy'))).toEqual([true, false]);
    expect(exchanges[1]!.prompt).toBe('prompt');
  });

  async function* emptyThenDone(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 's1' };
    yield { type: 'result', text: '' };
  }

  it('does not nudge a lenient (local-model) turn: its answer would reach the room as prose', async () => {
    const { query, pushes } = stub(emptyThenDone());
    await processQuery(
      query,
      CHAT,
      ['m1'],
      'pi',
      undefined,
      'prompt',
      undefined,
      false,
      undefined,
      undefined,
      [],
      true,
    );
    expect(emptyNudges(pushes)).toHaveLength(0);
  });

  it('does not nudge an agent-to-agent turn', async () => {
    const { query, pushes } = stub(emptyThenDone());
    const A2A = { ...CHAT, channelType: 'agent', platformId: 'ag-caller' };
    await processQuery(query, A2A, ['m1'], 'claude', undefined, 'prompt', undefined, false);
    expect(emptyNudges(pushes)).toHaveLength(0);
  });

  it('does not nudge a slash-command query such as /compact', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, trigger, content)
         VALUES ('c1', 'chat', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 'chan-1', 'discord', 1, ?)`,
      )
      .run(JSON.stringify({ sender: 'User', text: '/compact' }));
    const pushes: string[] = [];
    let queried = false;
    const provider = {
      isSessionInvalid: () => false,
      query: () => {
        queried = true;
        return { push: (m: string) => void pushes.push(m), end: () => {}, abort: () => {}, events: emptyThenDone() };
      },
    } as unknown as AgentProvider;
    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'claude', cwd: '/tmp', signal: controller.signal });
    const deadline = Date.now() + 5000;
    while (!(queried && delivered().length > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;
    expect(queried).toBe(true);
    expect(emptyNudges(pushes)).toHaveLength(0);
  });
});
