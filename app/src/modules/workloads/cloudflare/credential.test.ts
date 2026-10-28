import { describe, expect, it, vi } from 'vitest';

import type { OnecliAdmin } from '../../user-credentials/onecli-admin.js';
import { checkVault, connectCloudflareToken, SECRET_SPEC } from './credential.js';

const fakeAdmin = (secrets: Array<Record<string, unknown>> = []) => {
  const a = {
    listAllSecrets: vi.fn(async () => secrets),
    createGenericSecret: vi.fn(async () => 's-new'),
    updateGenericSecret: vi.fn(async () => undefined),
    updateSecretPathPattern: vi.fn(async () => undefined),
    ensureAgent: vi.fn(async () => 'agent-1'),
    setSecretMode: vi.fn(async () => undefined),
    setSecrets: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => [{ id: 'agent-1', identifier: 'nanoclaw-cloudflare', secretMode: 'selective' }]),
    listAgentSecretIds: vi.fn(async () => ['s-new']),
  };
  return a as typeof a & OnecliAdmin;
};

describe('the Cloudflare API token in the vault', () => {
  it('is stored as Bearer on api.cloudflare.com for the nanoclaw-cloudflare identity alone, selective', async () => {
    const admin = fakeAdmin();
    await connectCloudflareToken(admin, ` ${'t'.repeat(40)} `);
    expect(admin.createGenericSecret).toHaveBeenCalledWith('NanoClaw Cloudflare API token', 't'.repeat(40), {
      ...SECRET_SPEC,
    });
    expect(SECRET_SPEC).toEqual({
      hostPattern: 'api.cloudflare.com',
      pathPattern: '/client/v4/*',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
    expect(admin.ensureAgent).toHaveBeenCalledWith('NanoClaw Cloudflare publishing', 'nanoclaw-cloudflare');
    expect(admin.setSecretMode).toHaveBeenCalledWith('agent-1', 'selective');
    expect(admin.setSecrets).toHaveBeenCalledWith('agent-1', ['s-new']);
  });

  it('refuses something that is not a token', async () => {
    await expect(connectCloudflareToken(fakeAdmin(), 'short')).rejects.toThrow(/not a Cloudflare API token/);
  });

  it('is not ready while any other identity is in "all" mode, or ours is not selective', async () => {
    const admin = fakeAdmin([{ id: 's-new', name: 'NanoClaw Cloudflare API token' }]);
    expect(await checkVault(admin)).toEqual({ ok: true, warnings: [] });
    admin.listAgents.mockResolvedValue([
      { id: 'agent-1', identifier: 'nanoclaw-cloudflare', secretMode: 'selective' },
      { id: 'x', identifier: 'ag-123', secretMode: 'all' },
    ]);
    expect(await checkVault(admin)).toMatchObject({ ok: false, missing: /"all" secret mode/ });
    admin.listAgents.mockResolvedValue([{ id: 'agent-1', identifier: 'nanoclaw-cloudflare', secretMode: 'all' }]);
    expect(await checkVault(admin)).toMatchObject({ ok: false, missing: /selective/ });
  });

  it('does not mistake an agent’s own Cloudflare tool secret for the route’s', async () => {
    const admin = fakeAdmin([
      {
        id: 't1',
        type: 'generic',
        name: 'ToolSecret cloudflare',
        hostPattern: 'api.cloudflare.com',
        pathPattern: '/client/v4/*',
      },
    ]);
    expect(await checkVault(admin)).toMatchObject({ ok: false, missing: /not in the vault/ });
  });
});
