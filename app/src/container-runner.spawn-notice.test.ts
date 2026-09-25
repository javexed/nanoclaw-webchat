import { describe, expect, it } from 'vitest';

import { spawnFailureNotice } from './container-runner.js';

describe('spawn failure notice', () => {
  it('names an unreachable machine for what it is, and keeps the gateway hint for everything else', () => {
    const away = spawnFailureNotice(
      Object.assign(new Error('session realization failed: runtime-unavailable'), {
        kind: 'runtime-unavailable',
        retryable: true,
      }),
    );
    expect(away).toMatch(/machine I run on isn't reachable/);
    expect(away).not.toMatch(/credential gateway/);
    // The gateway is a skill since upstream 2.4.0 (OneCLI or another), so the hint names none.
    expect(spawnFailureNotice(new Error('401 from the gateway'))).toMatch(/credential gateway is unreachable/);
    expect(spawnFailureNotice(undefined)).toMatch(/credential gateway is unreachable/);
  });
});
