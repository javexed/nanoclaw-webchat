import { describe, expect, it, vi } from 'vitest';

// The router behind the gateway (it serves cloud models), on port 4000 here.
vi.mock('./cloud-models.js', () => ({
  agentRouterBase: (endpoint: string | null) =>
    /:4000(\/|$)/.test(endpoint ?? '') ? 'http://nanoclaw-litellm:4000' : null,
}));

import { modelHostPattern } from './egress-policy.js';

describe('a filtered agent on a router model', () => {
  it("may reach the router's container name (where it dials it, through the gateway), not the bridge port", () => {
    expect(modelHostPattern({ endpoint: 'http://127.0.0.1:4000/v1' })).toBe('nanoclaw-litellm:4000');
    expect(modelHostPattern({ endpoint: 'http://host.docker.internal:4000/v1' })).toBe('nanoclaw-litellm:4000');
  });

  it('other model endpoints keep their own host', () => {
    expect(modelHostPattern({ endpoint: 'http://127.0.0.1:11434' })).toBe('host.docker.internal:11434');
    expect(modelHostPattern({ endpoint: 'https://llm.example.org/v1' })).toBe('llm.example.org:443');
  });
});

describe('the filter on that host', () => {
  it('lets the agent through to the router by name, on its port only', async () => {
    const { hostMatches } = await import('./egress-policy.js');
    const pattern = modelHostPattern({ endpoint: 'http://127.0.0.1:4000/v1' })!;
    expect(hostMatches('nanoclaw-litellm', 4000, pattern)).toBe(true);
    expect(hostMatches('nanoclaw-litellm', 80, pattern)).toBe(false);
    expect(hostMatches('other-container', 4000, pattern)).toBe(false);
  });
});
