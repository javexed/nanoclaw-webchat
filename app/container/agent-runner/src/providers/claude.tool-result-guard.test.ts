import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The group's settings files are agent-writable: an agent can delete the
// tool-result guard's hook there, or set `disableAllHooks: true` (also in
// settings.local.json). Flag-level settings outrank every one of those files,
// so the provider declares the guard and pins hooks on there. The command must
// be the host's exactly, or Claude Code would run the guard twice.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-trg' };
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trg-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settings(): Promise<Record<string, unknown>> {
  const provider = createProvider('claude', { env: {} });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
  return (lastOptions?.settings ?? {}) as Record<string, unknown>;
}

describe('tool-result guard at flag level', () => {
  it('keeps hooks on whatever the settings files say', async () => {
    expect((await settings()).disableAllHooks).toBe(false);
  });

  it("declares the guard with the host's exact command", async () => {
    expect((await settings()).hooks).toEqual({
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'bun /app/src/tool-result-guard.ts', timeout: 10 }] },
      ],
    });
  });
});
