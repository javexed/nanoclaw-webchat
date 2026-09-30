import { afterEach, describe, expect, it } from 'vitest';

import { __dockerNetworkArgsForTest as dockerNetworkArgs, registerSidecarEgressCheck } from './index.js';
import { __resetNetworkPolicyResolversForTest, registerNetworkPolicyResolver } from '../seam/network-hooks.js';
import { fixtureSpec } from './spec-fixture.js';

// A session-container gateway (a sidecar) owns the agent's network namespace,
// so upstream returns no flags for it before the seam is consulted. An egress
// module's filtered policy would then be skipped in silence (patch on
// src/drivers/index.ts). The driver asks the egress module's side-effect-free
// check instead of the resolver, and refuses on anything but a clear "no".

afterEach(() => {
  __resetNetworkPolicyResolversForTest();
  registerSidecarEgressCheck(null);
});

const behindSidecar = () => {
  const spec = fixtureSpec();
  return {
    ...spec,
    networkAccess: { ...spec.networkAccess, target: { kind: 'session-container', role: 'egress-proxy' } },
  } as never;
};

describe('a session-container gateway', () => {
  it('still gets no flags when no module filters the agent', () => {
    expect(dockerNetworkArgs(behindSidecar())).toEqual([]);
    registerSidecarEgressCheck(() => false);
    expect(dockerNetworkArgs(behindSidecar())).toEqual([]);
  });

  it("refuses to start an agent whose egress policy the sidecar's namespace would bypass, as a policy denial", () => {
    registerSidecarEgressCheck(() => true);
    let err: unknown;
    try {
      dockerNetworkArgs(behindSidecar());
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'denied-by-policy', retryable: false });
    expect((err as { detail: string }).detail).toMatch(/session-container gateway/);
  });

  it('fails closed when the check throws or gives no clear answer', () => {
    registerSidecarEgressCheck(() => {
      throw new Error('cache gone');
    });
    expect(() => dockerNetworkArgs(behindSidecar())).toThrow(/session-container gateway/);
    registerSidecarEgressCheck((() => undefined) as never);
    expect(() => dockerNetworkArgs(behindSidecar())).toThrow(/session-container gateway/);
  });

  it('never runs the network resolver (it has side effects) for a sidecar session', () => {
    let called = false;
    registerNetworkPolicyResolver(() => {
      called = true;
      return ['--network', 'nanoclaw-egress-test'];
    });
    registerSidecarEgressCheck(() => false);
    expect(dockerNetworkArgs(behindSidecar())).toEqual([]);
    expect(called).toBe(false);
  });
});
