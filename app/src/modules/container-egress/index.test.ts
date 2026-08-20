import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The point of this module is that a group set to 'host-only' or 'none' stops
// getting full egress. Before the driver seam that was argv in container-runner;
// after it, container_configs.egress was still WRITTEN by the UI and read by
// nobody, so the setting silently did nothing. These tests pin the reconnection.

const getContainerConfig = vi.fn();
const ensureEgressNetwork = vi.fn(() => true);

vi.mock('../../db/container-configs.js', () => ({ getContainerConfig }));
vi.mock('../../egress-lockdown.js', () => ({
  ensureEgressNetwork,
  egressNetworkArgs: () => ['--network', 'nanoclaw-egress'],
}));

const specFor = (agentGroupId: string) =>
  ({ key: { installSlug: 'test', agentGroupId, sessionId: 's1' } }) as never;

let prepare: (agentGroupId: string, threadId: string | null) => Promise<void>;
let resolve: (spec: never) => string[] | null;

beforeEach(async () => {
  vi.resetModules();
  const runtime = await import('../../container-runtime.js');
  const drivers = await import('../../drivers/index.js');
  drivers.__resetNetworkPolicyResolversForTest();
  const prepares: typeof prepare[] = [];
  const resolvers: typeof resolve[] = [];
  vi.spyOn(runtime, 'registerSessionPrepareHook').mockImplementation((fn) => void prepares.push(fn as never));
  vi.spyOn(drivers, 'registerNetworkPolicyResolver').mockImplementation((fn) => void resolvers.push(fn as never));
  await import('./index.js');
  prepare = prepares[0]!;
  resolve = resolvers[0]!;
});

afterEach(() => vi.restoreAllMocks());

describe('per-group egress', () => {
  it('abstains for an open group, so the install-wide lockdown still decides', () => {
    // null is not "open egress" — it hands the decision back to the driver's
    // own rules, which are the ones that arm the install-wide lockdown.
    getContainerConfig.mockResolvedValue({ egress: 'open' });
    expect(resolve(specFor('ag-open'))).toBeNull();
  });

  it("cuts the network for 'none'", async () => {
    getContainerConfig.mockResolvedValue({ egress: 'none' });
    await prepare('ag-none', null);
    expect(resolve(specFor('ag-none'))).toEqual(['--network', 'none']);
  });

  it("forces the internal network for 'host-only', even with the install flag off", async () => {
    getContainerConfig.mockResolvedValue({ egress: 'host-only' });
    await prepare('ag-host', null);
    expect(resolve(specFor('ag-host'))).toEqual(['--network', 'nanoclaw-egress']);
    // force=true: per-group means per-group, regardless of the install-wide flag.
    expect(ensureEgressNetwork).toHaveBeenCalledWith(true);
  });

  it('abstains for a group it never prepared, rather than guessing', () => {
    expect(resolve(specFor('never-seen'))).toBeNull();
  });

  it('keeps the last known mode when the config read fails', async () => {
    // A failed read is not evidence the operator opened egress. Overwriting a
    // locked-down group with 'open' because one query threw would be the worst
    // possible direction to fail in.
    getContainerConfig.mockResolvedValue({ egress: 'none' });
    await prepare('ag-flaky', null);
    getContainerConfig.mockRejectedValue(new Error('db down'));
    await prepare('ag-flaky', null);
    expect(resolve(specFor('ag-flaky'))).toEqual(['--network', 'none']);
  });
});
