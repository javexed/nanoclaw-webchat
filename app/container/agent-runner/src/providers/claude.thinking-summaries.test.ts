import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ProviderOptions } from './types.js';

// Newer models return thinking blocks with the text omitted unless a summary
// is requested, so without `showThinkingSummaries` the thinking bubble's
// reasoning feed stays empty. The provider asks for summaries through the
// Settings member and leaves the thinking TYPE alone: forcing `adaptive`
// would break any model older than Opus 4.6. A custom ANTHROPIC_BASE_URL
// (a local or routed model) gets no such request.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-ts' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = undefined;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thinking-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(options: ProviderOptions): Promise<Record<string, unknown>> {
  const provider = createProvider('claude', options);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
  return lastOptions ?? {};
}

describe('thinking summaries', () => {
  it("are requested on Anthropic's API", async () => {
    const opts = await drive({ env: {} });
    expect((opts.settings as Record<string, unknown>).showThinkingSummaries).toBe(true);
  });

  it('are not requested from a custom ANTHROPIC_BASE_URL (a local or routed model)', async () => {
    const opts = await drive({ env: { ANTHROPIC_BASE_URL: 'http://router:4000' } });
    expect('showThinkingSummaries' in (opts.settings as Record<string, unknown>)).toBe(false);
  });

  it('leave the thinking type to the CLI: no `thinking` option is forced', async () => {
    const opts = await drive({ env: {} });
    expect(opts.thinking).toBeUndefined();
  });

  it('the execution policy keys still win over them', async () => {
    const opts = await drive({ env: {} });
    expect(opts.settings).toMatchObject({ syncClaudeAiSkills: false, syncClaudeAiPlugins: false });
  });
});
