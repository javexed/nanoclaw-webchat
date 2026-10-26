import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import {
  SERVED_MODEL_FIELD,
  noteServedModel,
  resetServedModel,
  servedModelField,
  withoutServedModel,
} from './served-model.js';

describe('served model', () => {
  afterEach(() => resetServedModel());

  it('is the latest model a response named, and nothing until one does', () => {
    expect(servedModelField()).toEqual({});
    noteServedModel('qwen3.5:4b');
    noteServedModel('gemma4:latest');
    expect(servedModelField()).toEqual({ [SERVED_MODEL_FIELD]: 'gemma4:latest' });
  });

  it('ignores a missing or blank model', () => {
    noteServedModel('m1');
    noteServedModel(undefined);
    noteServedModel('   ');
    noteServedModel(42);
    expect(servedModelField()).toEqual({ [SERVED_MODEL_FIELD]: 'm1' });
  });

  it('compares content without the stamp', () => {
    expect(withoutServedModel(JSON.stringify({ text: 'hi', servedModel: 'm' }))).toBe(JSON.stringify({ text: 'hi' }));
    expect(withoutServedModel(JSON.stringify({ text: 'hi' }))).toBe(JSON.stringify({ text: 'hi' }));
    expect(withoutServedModel('not json "servedModel"')).toBe('not json "servedModel"');
  });
});

describe('poll loop — a reply names the model that answered', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('chat', 'Chat', 'channel', 'webchat', 'room-1', NULL)`,
      )
      .run();
  });
  afterEach(() => {
    resetServedModel();
    closeSessionDb();
  });

  async function reply(onQuery: () => void): Promise<Record<string, unknown>> {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'room-1', 'webchat', ?)`,
      )
      .run(JSON.stringify({ sender: 'Alice', text: 'hi' }));
    const provider = new MockProvider({}, () => {
      onQuery();
      return { result: '<message to="chat">hello</message>' };
    });
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

  it('stamps the model the provider reported', async () => {
    const content = await reply(() => noteServedModel('qwen3.5:4b'));
    expect(content).toEqual({ text: 'hello', [SERVED_MODEL_FIELD]: 'qwen3.5:4b' });
  });

  it("stamps nothing when the provider reported none — not an earlier turn's", async () => {
    noteServedModel('from-a-previous-turn');
    const content = await reply(() => {});
    expect(content).toEqual({ text: 'hello' });
  });
});
