import { describe, expect, it } from 'vitest';

import { spawnFailureNotice } from './container-runner.js';

describe('spawn failure notice', () => {
  it('names an unreachable container runtime for what it is, and keeps the gateway hint for everything else', () => {
    const away = spawnFailureNotice(
      Object.assign(new Error('session realization failed: runtime-unavailable'), {
        kind: 'runtime-unavailable',
        retryable: true,
      }),
    );
    expect(away).toMatch(/container runtime isn't reachable/);
    expect(away).not.toMatch(/credential gateway/);
    // The gateway is a skill since upstream 2.4.0 (OneCLI or another), so the hint names none.
    expect(spawnFailureNotice(new Error('401 from the gateway'))).toMatch(/credential gateway is unreachable/);
    expect(spawnFailureNotice(undefined)).toMatch(/credential gateway is unreachable/);
  });

  it('says a start was refused and in what category, but keeps the reason itself (local paths) out of the room', () => {
    const refused = spawnFailureNotice(
      Object.assign(new Error('session realization failed: denied-by-policy'), {
        kind: 'denied-by-policy',
        retryable: false,
        detail: 'mount /srv/nanoclaw/groups/proj: EPERM\nstack…',
      }),
    );
    expect(refused).toMatch(/my start was refused \(policy\)/);
    expect(refused).not.toMatch(/credential gateway|stack|workspace|proj|EPERM/);
    expect(
      spawnFailureNotice(
        Object.assign(new Error('x'), { kind: 'spec-invalid', retryable: false, detail: '/home/u/x' }),
      ),
    ).toMatch(/refused \(invalid session setup\)/);
    const image = spawnFailureNotice(
      Object.assign(new Error('x'), { kind: 'image-unavailable', retryable: true, detail: 'pulling /var/lib/x' }),
    );
    expect(image).toMatch(/agent image isn't ready yet\./);
    expect(image).not.toMatch(/var\/lib/);
  });
});
