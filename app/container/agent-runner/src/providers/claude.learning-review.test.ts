import { describe, expect, it, mock } from 'bun:test';

// What the Claude provider hands the SDK for a learning-review query. The
// review's restriction is only real if it reaches the SDK: `allowedTools`
// alone pre-approves and restricts nothing under bypassPermissions.
const sdkCalls: Array<Record<string, unknown>> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdkCalls.push(options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./index.js');
await import('../provider-contracts/index.js');
await import('../learning-loop.js'); // registers the review's options contributor
const { createProvider } = await import('./factory.js');
const { PATH_REVIEW_TOOLS, URL_REVIEW_TOOLS } = await import('../learning-loop.js');

function queryWith(moduleInput?: Record<string, unknown>): Record<string, unknown> {
  sdkCalls.length = 0;
  const provider = createProvider('claude', { mcpServers: { extra: { command: 'extra-server' } } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'p', cwd: '/workspace/agent', moduleInput });
  expect(sdkCalls).toHaveLength(1);
  return sdkCalls[0]!;
}

describe('Claude learning review is actually restricted', () => {
  it('leaves ordinary turns on the provider defaults', () => {
    const opts = queryWith();
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.tools).toBeUndefined();
    expect(opts.allowedTools).toContain('Bash');
  });

  it('a plain review gets no built-in tools and denies everything but draft_skill', () => {
    const opts = queryWith({ learningReview: true });
    expect(opts.tools).toEqual([]);
    expect(opts.permissionMode).toBe('dontAsk');
    expect(opts.allowedTools).toEqual(['mcp__nanoclaw__draft_skill']);
    // The provider's disallowed floor survives the contribution.
    expect(Array.isArray(opts.disallowedTools)).toBe(true);
    expect((opts.disallowedTools as string[]).length).toBeGreaterThan(0);
  });

  it('a URL review reaches WebFetch and nothing else', () => {
    const opts = queryWith({ learningReview: true, learningReviewTools: [...URL_REVIEW_TOOLS] });
    expect(opts.tools).toEqual(['WebFetch']);
    expect(opts.allowedTools).toEqual(['mcp__nanoclaw__draft_skill', 'WebFetch']);
    expect(opts.permissionMode).toBe('dontAsk');
  });

  it('a path review reaches Read/Glob/Grep and nothing else', () => {
    const opts = queryWith({ learningReview: true, learningReviewTools: [...PATH_REVIEW_TOOLS] });
    expect(opts.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(opts.allowedTools).toEqual(['mcp__nanoclaw__draft_skill', 'Read', 'Glob', 'Grep']);
    expect(opts.allowedTools).not.toContain('Bash');
    expect(opts.permissionMode).toBe('dontAsk');
  });
});
