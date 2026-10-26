/**
 * A harness that brings its own model (Codex, Grok, Copilot) has no registry
 * model whose host could be its egress floor, so the floor comes from the
 * provider's declared model domains — plus api.github.com for Copilot, which
 * checks the seat there before every session.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../provider-contracts/registry.js', () => ({
  getProviderHostContract: (p: string) =>
    ({
      copilot: { modelDomains: ['githubcopilot.com', 'copilot-proxy.githubusercontent.com'] },
      codex: { modelDomains: ['openai.com', 'chatgpt.com'] },
      opencode: { modelDomains: ['openrouter.ai'] },
    })[p],
}));

const { egressAllowed, harnessFloorHosts } = await import('./egress-policy.js');

describe('harnessFloorHosts', () => {
  it('Copilot reaches its service hosts and the seat check, under any network setting', () => {
    const floor = harnessFloorHosts('copilot');
    expect(floor).toEqual([
      'githubcopilot.com',
      '*.githubcopilot.com',
      'copilot-proxy.githubusercontent.com',
      '*.copilot-proxy.githubusercontent.com',
      'api.github.com',
    ]);
    for (const mode of ['none', 'host-only'] as const) {
      expect(egressAllowed(mode, 'api.business.githubcopilot.com', 443, [], floor)).toBe(true);
      expect(egressAllowed(mode, 'api.github.com', 443, [], floor)).toBe(true);
      expect(egressAllowed(mode, 'example.org', 443, [], floor)).toBe(false);
    }
  });

  it('applies to own-model harnesses only; others keep their registry model host', () => {
    expect(harnessFloorHosts('codex')).toContain('*.chatgpt.com');
    expect(harnessFloorHosts('opencode')).toEqual([]);
    expect(harnessFloorHosts('claude')).toEqual([]);
    expect(harnessFloorHosts(null)).toEqual([]);
  });
});
