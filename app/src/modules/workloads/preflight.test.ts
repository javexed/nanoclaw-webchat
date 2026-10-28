import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OFF_REASON,
  preflightDue,
  PREFLIGHT_EVERY_MS,
  requireWorkloads,
  runPreflight,
  __setPreflightForTest,
  type PreflightDeps,
} from './preflight.js';

const ok: PreflightDeps = {
  slice: async () => ({ ok: true, memoryMaxMb: 8192 }),
  tools: async () => null,
  isolation: async () => 'blocked',
};

afterEach(() => {
  vi.unstubAllEnvs();
  __setPreflightForTest(null);
});

describe('the workloads preflight', () => {
  it('keeps workloads off unless the operator turned them on', async () => {
    expect(() => requireWorkloads()).toThrow(OFF_REASON);
    const r = await runPreflight(ok, 1);
    expect(r).toMatchObject({ ok: false, reason: OFF_REASON });
  });

  it('refuses until it has run, then passes when the host is ready', async () => {
    vi.stubEnv('NANOCLAW_WORKLOADS', '1');
    expect(() => requireWorkloads()).toThrow(/still being checked/);
    expect(await runPreflight(ok, 1)).toMatchObject({ ok: true });
    expect(() => requireWorkloads()).not.toThrow();
    expect(preflightDue(1 + PREFLIGHT_EVERY_MS - 1)).toBe(false);
    expect(preflightDue(1 + PREFLIGHT_EVERY_MS)).toBe(true);
  });

  it('names the missing slice, tool, or host rules', async () => {
    vi.stubEnv('NANOCLAW_WORKLOADS', '1');
    expect(
      (await runPreflight({ ...ok, slice: async () => ({ ok: false, reason: 'no slice nanoclaw-wl-x.slice' }) }))
        .reason,
    ).toBe('no slice nanoclaw-wl-x.slice');
    expect(() => requireWorkloads()).toThrow('no slice');
    expect(
      (await runPreflight({ ...ok, tools: async () => 'docker buildx is not installed on this host' })).reason,
    ).toMatch(/buildx/);
    const open = await runPreflight({ ...ok, isolation: async () => 'open' });
    expect(open).toMatchObject({ ok: false, isolationOpen: true });
    expect(open.reason).toMatch(/workloads-host-rules\.sh/);
    const broken = await runPreflight({
      ...ok,
      isolation: async () => {
        throw new Error('no docker');
      },
    });
    expect(broken).toMatchObject({ ok: false, isolationOpen: false });
    expect(broken.reason).toMatch(/could not run: no docker/);
  });
});
