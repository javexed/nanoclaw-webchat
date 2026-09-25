import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One policy for every agent: unset means the allowlist, both filtered modes
// sit behind central's egress filter on the lockdown network, only an explicit
// 'open' gets an ordinary network — and nothing in this module may fail open.

const getContainerConfig = vi.fn();
const ensureEgressNetwork = vi.fn(() => true);
const ensureEgressFilter = vi.fn();
const registerFilteredContainer = vi.fn();
let bridgeFails = false;
let lockdown = false;

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get EGRESS_LOCKDOWN() {
    return lockdown;
  },
}));

vi.mock('../../db/container-configs.js', () => ({ getContainerConfig }));
vi.mock('../../egress-lockdown.js', () => ({
  ensureEgressNetwork,
  egressBridgeAddress: () => {
    if (bridgeFails) throw new Error('no bridge');
    return '203.0.113.1';
  },
  egressNetworkArgs: () => ['--network', 'nanoclaw-egress-test', '--add-host=host.docker.internal:203.0.113.1'],
}));
vi.mock('../../channels/webchat/egress-filter.js', () => ({
  ensureEgressFilter,
  registerFilteredContainer,
  defaultFilterDeps: () => ({}),
}));
vi.mock('../../channels/webchat/mcp-relay.js', () => ({ mcpRelayTarget: () => ({ host: '172.17.0.1', port: 3302 }) }));
vi.mock('../../drivers/docker-driver.js', () => ({
  agentContainerName: (s: { key: { sessionId: string } }) => `ncl-test-${s.key.sessionId}`,
}));

const FILTERED = ['--network', 'nanoclaw-egress-test', '--add-host=host.docker.internal:203.0.113.1'];
/** What the OneCLI gateway declares since upstream 2.4.0: a runtime container, reached as host.docker.internal. */
const ACCESS = { endpoint: 'host.docker.internal', target: { kind: 'runtime', identity: 'onecli-gateway' } };
const specFor = (agentGroupId: string, proxy: string | null = 'http://x:tok@host.docker.internal:10255') =>
  ({
    key: { installSlug: 'test', agentGroupId, sessionId: 's1' },
    networkAccess: ACCESS,
    containers: [{ role: 'agent', env: proxy ? { HTTPS_PROXY: proxy } : {} }],
  }) as never;

let prepare: (agentGroupId: string, threadId: string | null) => Promise<void>;
let resolve: (spec: never) => string[] | null;

beforeEach(async () => {
  vi.resetModules();
  bridgeFails = false;
  lockdown = false;
  ensureEgressFilter.mockClear();
  registerFilteredContainer.mockClear();
  const seam = await import('../../seam/index.js');
  seam.__resetNetworkPolicyResolversForTest();
  const prepares: (typeof prepare)[] = [];
  const resolvers: (typeof resolve)[] = [];
  vi.spyOn(seam, 'registerSessionPrepareHook').mockImplementation((fn) => void prepares.push(fn as never));
  vi.spyOn(seam, 'registerNetworkPolicyResolver').mockImplementation((fn) => void resolvers.push(fn as never));
  await import('./index.js');
  prepare = prepares[0]!;
  resolve = resolvers[0]!;
});

afterEach(() => vi.restoreAllMocks());

describe('per-group egress', () => {
  it('only an explicit open group gets an ordinary network', async () => {
    getContainerConfig.mockResolvedValue({ egress: 'open' });
    await prepare('ag-open', null);
    expect(resolve(specFor('ag-open'))).toBeNull();
  });

  it('under the install-wide lockdown even an open group goes behind the filter (its policy lets it through)', async () => {
    lockdown = true;
    getContainerConfig.mockResolvedValue({ egress: 'open' });
    await prepare('ag-open-locked', null);
    expect(resolve(specFor('ag-open-locked'))).toEqual(FILTERED);
    expect(registerFilteredContainer).toHaveBeenCalledWith('ncl-test-s1', {
      agentGroupId: 'ag-open-locked',
      sessionId: 's1',
    });
  });

  it('an unset mode is the allowlist: the agent goes behind the egress filter, registered as itself', async () => {
    getContainerConfig.mockResolvedValue({ egress: null });
    await prepare('ag-default', null);
    expect(resolve(specFor('ag-default'))).toEqual(FILTERED);
    // The spec's gateway access goes through: the detach target and the endpoint name.
    expect(ensureEgressNetwork).toHaveBeenCalledWith(ACCESS, true);
    // The filter listens on the bridge, on the gateway port the proxy URL names, and passes the MCP relay through.
    expect(ensureEgressFilter).toHaveBeenCalledWith('203.0.113.1', 10255, expect.anything(), [
      { port: 3302, target: { host: '172.17.0.1', port: 3302 } },
    ]);
    expect(registerFilteredContainer).toHaveBeenCalledWith('ncl-test-s1', {
      agentGroupId: 'ag-default',
      sessionId: 's1',
    });
  });

  it("finds the gateway's proxy URL where the gateway puts it — the contributed env", async () => {
    getContainerConfig.mockResolvedValue({ egress: null });
    await prepare('ag-contrib', null);
    const spec = {
      key: { installSlug: 'test', agentGroupId: 'ag-contrib', sessionId: 's1' },
      containers: [
        {
          role: 'agent',
          env: { TZ: 'UTC' },
          contributedEnv: { HTTPS_PROXY: 'http://x:tok@host.docker.internal:10255' },
        },
      ],
    } as never;
    expect(resolve(spec)).toEqual(FILTERED);
    expect(ensureEgressFilter).toHaveBeenCalledWith('203.0.113.1', 10255, expect.anything(), expect.anything());
  });

  it('model only is filtered too (the filter enforces it) — no longer a dead network that also cut off the model', async () => {
    getContainerConfig.mockResolvedValue({ egress: 'none' });
    await prepare('ag-none', null);
    expect(resolve(specFor('ag-none'))).toEqual(FILTERED);
  });

  it('a group it never prepared gets the default — the allowlist — never open by omission', async () => {
    expect(resolve(specFor('never-seen'))).toEqual(FILTERED);
  });

  it('fails closed: any failure putting the agent behind the filter means no network at all', async () => {
    getContainerConfig.mockResolvedValue({ egress: 'host-only' });
    await prepare('ag-x', null);
    expect(resolve(specFor('ag-x', null))).toEqual(['--network', 'none']); // no proxy URL to filter
    bridgeFails = true;
    expect(resolve(specFor('ag-x'))).toEqual(['--network', 'none']);
  });

  it('fails closed to the allowlist when the config read fails, even after open', async () => {
    getContainerConfig.mockResolvedValue({ egress: 'open' });
    await prepare('ag-flaky', null);
    getContainerConfig.mockRejectedValue(new Error('db down'));
    (await import('../../channels/webchat/egress-policy.js')).forgetGroupEgressMode('ag-flaky');
    await prepare('ag-flaky', null);
    expect(resolve(specFor('ag-flaky'))).not.toBeNull();
  });
});
