/**
 * Fleet isolation is opt-in, and the property that matters most is the
 * NEGATIVE one: an install that never sets CREDENTIAL_ISOLATION must not touch
 * the vault at all. Isolation is destructive-ish — it flips an agent to
 * `selective`, after which it only sees what is assigned — so switching it on
 * by accident would cut agents off from credentials they had been using.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AG = 'ag-fleet';

async function loadWith(env: string | undefined, admin: Record<string, unknown>) {
  vi.resetModules();
  if (env === undefined) delete process.env.CREDENTIAL_ISOLATION;
  else process.env.CREDENTIAL_ISOLATION = env;
  vi.doMock('../user-credentials/onecli-admin.js', () => ({ realOnecliAdmin: admin }));
  vi.doMock('../../db/agent-groups.js', () => ({ getAgentGroup: () => ({ id: AG, name: 'Fleet' }) }));
  await import('./index.js');
  const { runSessionPrepareHooks } = await import('../../container-runtime.js');
  return runSessionPrepareHooks;
}

beforeEach(() => {
  delete process.env.CREDENTIAL_ISOLATION;
});
afterEach(() => {
  delete process.env.CREDENTIAL_ISOLATION;
  vi.resetModules();
  vi.doUnmock('../user-credentials/onecli-admin.js');
  vi.doUnmock('../../db/agent-groups.js');
});

describe('fleet isolation', () => {
  it('does nothing at all when unset — no vault calls', async () => {
    const calls: string[] = [];
    const admin = {
      findAgentId: async () => {
        calls.push('findAgentId');
        return 'a1';
      },
      getSecretMode: async () => {
        calls.push('getSecretMode');
        return 'all';
      },
      ensureAgent: async () => {
        calls.push('ensureAgent');
        return 'a1';
      },
    };
    const run = await loadWith(undefined, admin);
    await run(AG, null);
    expect(calls, 'an install not opting in must not touch the vault').toEqual([]);
  });

  it('ignores any value other than fleet', async () => {
    const calls: string[] = [];
    const admin = {
      findAgentId: async () => {
        calls.push('findAgentId');
        return 'a1';
      },
    };
    const run = await loadWith('true', admin); // a plausible operator typo
    await run(AG, null);
    expect(calls).toEqual([]);
  });

  it('leaves an already-isolated group alone (no writes on every spawn)', async () => {
    const calls: string[] = [];
    const admin = {
      findAgentId: async () => 'a1',
      getSecretMode: async () => {
        calls.push('getSecretMode');
        return 'selective';
      },
      setSecretMode: async () => calls.push('setSecretMode'),
      ensureAgent: async () => calls.push('ensureAgent'),
    };
    const run = await loadWith('fleet', admin);
    await run(AG, null);
    expect(calls).not.toContain('setSecretMode');
    expect(calls).not.toContain('ensureAgent');
  });

  it('never lets a vault failure break the spawn', async () => {
    // The hook runs on the user's turn — a vault hiccup must degrade to "not
    // isolated this time", never to a failed spawn.
    const admin = {
      findAgentId: async () => {
        throw new Error('vault down');
      },
    };
    const run = await loadWith('fleet', admin);
    await expect(run(AG, null)).resolves.toBeUndefined();
  });
});
