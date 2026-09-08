/**
 * parseAgentRef — the provider a caller may pin on a NEW agent.
 *
 * The wizard creates its first agent before it switches the install default
 * (that switch restarts the host). So the create call has to be able to name
 * every harness the operator can choose, Claude included: an install whose
 * .env already carries another DEFAULT_AGENT_PROVIDER would otherwise hand the
 * wizard's own agent that stale default. The rule mirrors
 * PUT /api/workspace-provider: 'claude' always, plus what is installed.
 */
import { describe, it, expect, vi } from 'vitest';

let installed: string[] = [];
vi.mock('./providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers.js')>()),
  availableProviders: () => installed,
}));

import { parseAgentRef } from './routes-rooms.js';

const newAgent = (provider?: unknown) => ({
  kind: 'new',
  name: 'Assistant',
  ...(provider === undefined ? {} : { provider }),
});

describe('parseAgentRef provider pin', () => {
  it("accepts 'claude' even when no non-default harness is installed", () => {
    installed = [];
    expect(parseAgentRef(newAgent('claude'))).toEqual({
      kind: 'new',
      name: 'Assistant',
      instructions: undefined,
      provider: 'claude',
    });
  });

  it('accepts an installed harness', () => {
    installed = ['grok'];
    expect(parseAgentRef(newAgent('grok'))).toMatchObject({ kind: 'new', provider: 'grok' });
  });

  it('rejects a harness that is not installed, and names the whole allowed set', () => {
    installed = ['codex'];
    expect(parseAgentRef(newAgent('grok'))).toEqual({ error: 'agent.provider must be one of: claude, codex' });
  });

  it('rejects a non-string provider', () => {
    installed = [];
    expect(parseAgentRef(newAgent(7))).toEqual({ error: 'agent.provider must be one of: claude' });
  });

  it('leaves provider undefined when the caller does not pin one', () => {
    installed = ['grok'];
    expect(parseAgentRef(newAgent())).toMatchObject({ kind: 'new', provider: undefined });
  });
});
