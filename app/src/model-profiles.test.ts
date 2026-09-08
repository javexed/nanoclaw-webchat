import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILE,
  deriveTurnTimeoutMs,
  parseParameterSize,
  PROFILES,
  resolveModelProfile,
  type CachedProfile,
} from './model-profiles.js';

describe('parseParameterSize', () => {
  it('reads the shapes Ollama actually reports', () => {
    expect(parseParameterSize('4.7B')).toBeCloseTo(4.7);
    expect(parseParameterSize('9.0B')).toBeCloseTo(9);
    expect(parseParameterSize('3.2B')).toBeCloseTo(3.2);
    expect(parseParameterSize('1.5b')).toBeCloseTo(1.5);
  });

  it('converts millions so a tiny model does not read as enormous', () => {
    expect(parseParameterSize('500M')).toBeCloseTo(0.5);
  });

  it('returns null rather than guessing', () => {
    for (const bad of [null, undefined, '', 'unknown', '7', 'B', '-3B', '0B']) {
      expect(parseParameterSize(bad)).toBeNull();
    }
  });
});

describe('deriveTurnTimeoutMs', () => {
  it('gives a bigger model more time than a smaller one', () => {
    expect(deriveTurnTimeoutMs(9)).toBeGreaterThan(deriveTurnTimeoutMs(4.7));
  });

  it('covers what the models actually needed, with headroom', () => {
    // ornith-1.5:9b took 251s on the write case and blew past 300s on another.
    expect(deriveTurnTimeoutMs(9)).toBeGreaterThan(251_000);
    // qwen3.5:4b finished file work in 60-109s.
    expect(deriveTurnTimeoutMs(4.7)).toBeGreaterThan(109_000);
  });

  it('falls back to the floor for an unknown size instead of an unbounded wait', () => {
    expect(deriveTurnTimeoutMs(null)).toBe(120_000);
    expect(deriveTurnTimeoutMs(Number.NaN)).toBe(120_000);
    expect(deriveTurnTimeoutMs(0)).toBe(120_000);
  });

  it('caps absurd sizes so a bad reading cannot hang a turn for an hour', () => {
    expect(deriveTurnTimeoutMs(10_000)).toBe(900_000);
  });
});

describe('resolveModelProfile', () => {
  const cache: Record<string, CachedProfile> = {
    'probed-model': {
      model: 'probed-model',
      measuredAt: '2026-08-23T00:00:00.000Z',
      tools: 'read,write,edit,bash',
      messageTool: false,
      notes: 'from probe',
    },
  };

  it('falls back to the documented default for a model nobody has measured', () => {
    const r = resolveModelProfile({ model: 'brand-new:7b', parameterSize: '7.0B' });
    expect(r.source).toBe('default');
    expect(r.tools).toBe(DEFAULT_PROFILE.tools);
  });

  it('uses a cached probe when the table has nothing', () => {
    const r = resolveModelProfile({ model: 'probed-model', cache });
    expect(r.source).toBe('probe');
    expect(r.messageTool).toBe(false);
  });

  it('never lets a probe overrule a hand-written table entry', () => {
    // A person's decision outranks a measurement taken at some unknown moment.
    const r = resolveModelProfile({
      model: 'probed-model',
      cache,
      table: { 'probed-model': { tools: 'read', messageTool: true, notes: 'declared' } },
    });
    expect(r.source).toBe('table');
    expect(r.tools).toBe('read');
    expect(r.messageTool).toBe(true);
  });

  it('always derives a timeout, even when the profile omits one', () => {
    const r = resolveModelProfile({ model: 'x', parameterSize: '9.0B' });
    expect(r.turnTimeoutMs).toBeGreaterThan(0);
  });

  it('keeps tools ON by default — turning them off was measured as far worse', () => {
    // Toolless qwen3.5:4b took 263s on a question it answers in 21-38s with
    // tools, and timed out every eval run. No default may quietly do that.
    const r = resolveModelProfile({ model: 'anything', parameterSize: '1.0B' });
    expect(r.tools).not.toBe('none');
    expect(r.tools).toContain('bash');
  });
});

describe('PROFILES keys', () => {
  it('are bare model ids, never provider-prefixed', () => {
    // A prefixed key misses every lookup SILENTLY: resolution falls through to
    // the default, the timeout collapses to the floor, and nothing logs it.
    // Shipped that way once; the live container came up with a 120s budget and
    // no cap, and only an env dump found it.
    for (const key of Object.keys(PROFILES)) {
      expect(key).not.toContain('/');
    }
  });

  it('resolves a table row using the id the caller actually passes', () => {
    // The caller strips `<provider>/` before resolving. Pin that contract here
    // rather than trusting both sides to keep agreeing.
    const r = resolveModelProfile({ model: 'qwen3.5:4b' });
    expect(r.source).toBe('table');
    expect(r.noopCapThreshold).toBe(2);
  });

  it('gives every measured row an explicit turn budget', () => {
    // Parameter size needs a round trip the spawn path does not take, so a row
    // without turnTimeoutMs silently gets the floor.
    for (const [key, p] of Object.entries(PROFILES)) {
      expect(p.turnTimeoutMs, `${key} has no turnTimeoutMs`).toBeGreaterThan(0);
    }
  });
});
