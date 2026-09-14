import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Claude's thinking blocks ride the same assistant `content` array as text.
// Nothing consumed them, so `summarizeThinking` sat exported with no caller and
// the live reasoning feed was empty for every Claude-backed agent while pi's
// worked — the bubble looked broken for the provider most agents run.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const seen: { kind: string; text?: string; detail?: string }[] = [];
const { registerProviderMessageObserver } = await import('./hooks.js');
registerProviderMessageObserver((ev) => {
  seen.push(ev as { kind: string; text?: string; detail?: string });
});

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  seen.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thinking-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drain(): Promise<void> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) void _;
}

describe('claude thinking blocks reach the reasoning feed', () => {
  it('emits one reasoning event per summarised line, and leaves text alone', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'First I check the file\nThen I edit it' },
            { type: 'text', text: '<message to="user">done</message>' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: '<message to="user">done</message>' },
    );

    await drain();

    const reasoning = seen.filter((e) => e.kind === 'reasoning');
    expect(reasoning.map((e) => e.text)).toEqual(['First I check the file', 'Then I edit it']);
    // The FIRST line carries the full untruncated block for the durable store
    // and click-to-expand; later lines do not, so it is not duplicated.
    expect(reasoning[0]!.detail).toBe('First I check the file\nThen I edit it');
    expect(reasoning[1]!.detail).toBeUndefined();
  });

  it('ignores an assistant message with no thinking block', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'plain' }] } },
      { type: 'result', subtype: 'success', result: 'plain' },
    );

    await drain();

    expect(seen.filter((e) => e.kind === 'reasoning')).toHaveLength(0);
  });

  it('keeps only the tail of a long trace, per summarizeThinking', async () => {
    sdkMessages.length = 0;
    const many = Array.from({ length: 20 }, (_, i) => `step ${i}`).join('\n');
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-3' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: many }] } },
      { type: 'result', subtype: 'success', result: 'x' },
    );

    await drain();

    const reasoning = seen.filter((e) => e.kind === 'reasoning').map((e) => e.text);
    expect(reasoning).toHaveLength(8);
    expect(reasoning.at(-1)).toBe('step 19');
  });
});
