/**
 * Saving a secret for one agent or one person isolates the whole fleet first:
 * any agent left in `all` mode would be offered it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let chosen: boolean | null = null;
let skipped: { id: string; reason: string }[] = [];
const setCredentialIsolation = vi.fn(async (v: boolean | null) => {
  chosen = v;
});
const isolateAllGroups = vi.fn(async () => ({ isolated: ['ag-1'], skipped }));

vi.mock('../../channels/webchat/db.js', () => ({
  getCredentialIsolation: async () => chosen,
  setCredentialIsolation,
}));
vi.mock('../tool-secrets/index.js', () => ({
  isolateAllGroups,
  isolateGroup: vi.fn(),
  getGroupIsolation: vi.fn(),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async (id: string) => ({ id, name: `Agent ${id}` }) }));
vi.mock('../user-credentials/onecli-admin.js', () => ({ realOnecliAdmin: {} }));

const { ensureFleetIsolation } = await import('./index.js');

beforeEach(() => {
  delete process.env.CREDENTIAL_ISOLATION;
  chosen = null;
  skipped = [];
  setCredentialIsolation.mockClear();
  isolateAllGroups.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('ensureFleetIsolation', () => {
  it('turns isolation on and isolates every existing agent now', async () => {
    await ensureFleetIsolation();
    expect(setCredentialIsolation).toHaveBeenCalledWith(true);
    expect(isolateAllGroups).toHaveBeenCalledTimes(1);
  });

  it('keeps an owner who already chose isolation, and still isolates now', async () => {
    chosen = true;
    await ensureFleetIsolation();
    expect(setCredentialIsolation).not.toHaveBeenCalled();
    expect(isolateAllGroups).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than overriding an owner who turned isolation off', async () => {
    chosen = false;
    await expect(ensureFleetIsolation()).rejects.toThrow('Credential isolation is off');
    expect(isolateAllGroups).not.toHaveBeenCalled();
  });

  it('lets an agent with no vault identity yet wait for its first spawn', async () => {
    skipped = [{ id: 'ag-new', reason: 'no OneCLI agent yet' }];
    await expect(ensureFleetIsolation()).resolves.toBeUndefined();
  });

  it('refuses, naming the agent, when one that exists cannot be isolated', async () => {
    skipped = [{ id: 'ag-2', reason: 'No model credential to pin' }];
    await expect(ensureFleetIsolation()).rejects.toThrow(/Couldn't make every agent private.*Agent ag-2/);
  });
});
