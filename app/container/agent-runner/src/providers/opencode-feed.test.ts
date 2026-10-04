import { beforeEach, describe, expect, it } from 'bun:test';

import { registerProviderMessageObserver, type ProviderMessageEvent } from './hooks.js';
import { __resetOpenCodeFeedForTest, forwardOpenCodeEvent } from './opencode-feed.js';

const seen: ProviderMessageEvent[] = [];
registerProviderMessageObserver((ev) => seen.push(ev));
const part = (p: Record<string, unknown>) =>
  forwardOpenCodeEvent({ type: 'message.part.updated', properties: { part: p } });

beforeEach(() => {
  seen.length = 0;
  __resetOpenCodeFeedForTest();
});

describe('OpenCode parts to the thinking bubble', () => {
  it('one tool_use per call, once it has its input', () => {
    part({ id: 'p1', type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'pending', input: {} } });
    part({
      id: 'p1',
      type: 'tool',
      callID: 'c1',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' } },
    });
    part({
      id: 'p1',
      type: 'tool',
      callID: 'c1',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'ls' } },
    });
    expect(seen).toEqual([{ kind: 'tool_use', toolName: 'bash', toolInput: { command: 'ls' } }]);
  });

  it('a call with no id is not deduplicated against later calls', () => {
    part({ type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } });
    part({ type: 'tool', tool: 'read', state: { status: 'running', input: { path: 'a' } } });
    expect(seen.map((e) => (e as { toolName?: string }).toolName)).toEqual(['bash', 'read']);
  });

  it('a reasoning part, once complete, as summarised lines with the full text on the first', () => {
    part({ id: 'r1', type: 'reasoning', text: 'Look at the file.\nThen answer.', time: { start: 1 } });
    expect(seen).toEqual([]);
    part({ id: 'r1', type: 'reasoning', text: 'Look at the file.\nThen answer.', time: { start: 1, end: 2 } });
    part({ id: 'r1', type: 'reasoning', text: 'Look at the file.\nThen answer.', time: { start: 1, end: 2 } });
    expect(seen.map((e) => (e as { text?: string }).text)).toEqual(['Look at the file.', 'Then answer.']);
    expect((seen[0] as { detail?: string }).detail).toBe('Look at the file.\nThen answer.');
  });

  it('ignores text parts and other events', () => {
    part({ id: 't1', type: 'text', text: 'hi' });
    forwardOpenCodeEvent({ type: 'session.idle', properties: {} });
    expect(seen).toEqual([]);
  });
});
