import { beforeEach, describe, expect, it } from 'vitest';

import { __resetBuildRefusalsForTest, buildRefusalsSince, noteBuildRefusal } from './build-refusals.js';

describe('build refusals', () => {
  beforeEach(() => __resetBuildRefusalsForTest());

  it('keeps the latest reason per host:port since a time, per agent', () => {
    noteBuildRefusal('ag-1', 'Reg.Example.com', 443, 'not on the list', 1_000);
    noteBuildRefusal('ag-1', 'reg.example.com', 443, 'could not connect: refused', 2_000);
    noteBuildRefusal('ag-1', 'other.example.com', 80, 'not on the list', 500);
    noteBuildRefusal('ag-2', 'reg.example.com', 443, 'not on the list', 2_000);
    expect(buildRefusalsSince('ag-1', 900)).toEqual(['reg.example.com:443: could not connect: refused']);
    expect(buildRefusalsSince('ag-3', 0)).toEqual([]);
  });

  it('a failed build names them first', async () => {
    const { withRefusals } = await import('../../modules/workloads/docker.js');
    const now = Date.now();
    noteBuildRefusal('ag-1', 'registry.example.com', 443, 'not on the list', now);
    expect(withRefusals('ag-1', now, 'the build failed: Forbidden')).toBe(
      'Blocked during the build:\n- registry.example.com:443: not on the list\n\nthe build failed: Forbidden',
    );
    expect(withRefusals('ag-2', now, 'x')).toBe('x');
  });
});
