import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The served model is the one that wrote the reply. A subagent's assistant
// messages stream through the same query, carrying parent_tool_use_id and the
// subagent's model; they must not overwrite the main model's.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { resetServedModel, servedModelField } = await import('../served-model.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-served-model-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  resetServedModel();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(): Promise<void> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) void _;
}

describe('served model', () => {
  it("names the main model, not a subagent's", async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { model: 'main-model', content: [{ type: 'tool_use', name: 'Task', input: {} }] },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { model: 'subagent-model', content: [{ type: 'text', text: 'sub work' }] },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    );
    await run();
    expect(servedModelField()).toEqual({ servedModel: 'main-model' });
  });

  it('is unknown when only a subagent answered', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { model: 'subagent-model', content: [{ type: 'text', text: 'sub work' }] },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    );
    await run();
    expect(servedModelField()).toEqual({});
  });
});
