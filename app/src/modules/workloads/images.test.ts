import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUILDKIT_IMAGE, DIGEST_RE, HELPER_IMAGE, pinnedImage } from './images.js';

afterEach(() => vi.unstubAllEnvs());

describe('the images NanoClaw runs for workloads', () => {
  it('are pinned by digest', () => {
    expect(HELPER_IMAGE()).toMatch(DIGEST_RE);
    expect(BUILDKIT_IMAGE()).toMatch(DIGEST_RE);
  });

  it('may be overridden only by digest', () => {
    vi.stubEnv('NANOCLAW_WORKLOAD_HELPER_IMAGE', 'mirror.example/alpine:3.22');
    expect(() => HELPER_IMAGE()).toThrow(/by digest/);
    const pinned = `mirror.example/alpine:3.22@sha256:${'f'.repeat(64)}`;
    vi.stubEnv('NANOCLAW_WORKLOAD_HELPER_IMAGE', pinned);
    expect(HELPER_IMAGE()).toBe(pinned);
    expect(pinnedImage('', 'x@sha256:1', 'K')).toBe('x@sha256:1');
  });
});
