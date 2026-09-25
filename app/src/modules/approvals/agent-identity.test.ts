import { afterEach, describe, expect, it, vi } from 'vitest';

const groups = vi.hoisted(() => new Set<string>(['ag-1']));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => {
    if (id === 'boom') throw new Error('db down');
    return groups.has(id) ? { id } : undefined;
  },
}));

const { registerApprovalAgentGroupFallback, resolveApprovalAgentGroup } = await import('./agent-identity.js');

afterEach(() => registerApprovalAgentGroupFallback(async () => null));

describe('resolveApprovalAgentGroup', () => {
  it('keeps an identity that already names a group', async () => {
    registerApprovalAgentGroupFallback(async () => 'wrong');
    expect(await resolveApprovalAgentGroup('ag-1')).toBe('ag-1');
  });

  it('maps a derived identity through the registered fallback', async () => {
    registerApprovalAgentGroupFallback(async (id) => (id === 'user-creds-alice-aaa' ? 'ag-1' : null));
    expect(await resolveApprovalAgentGroup('user-creds-alice-aaa')).toBe('ag-1');
  });

  it('returns an unknown identity unchanged, so ownership still refuses it', async () => {
    expect(await resolveApprovalAgentGroup('someone-else')).toBe('someone-else');
  });

  it('never throws, even when the group lookup fails', async () => {
    expect(await resolveApprovalAgentGroup('boom')).toBe('boom');
  });

  it('treats a throwing fallback as unknown', async () => {
    registerApprovalAgentGroupFallback(() => {
      throw new Error('db down');
    });
    expect(await resolveApprovalAgentGroup('user-creds-x')).toBe('user-creds-x');
  });
});
