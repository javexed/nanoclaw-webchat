/**
 * Two installs on one host both number their workload networks from 0. The
 * second one's first network must skip a subnet the first already holds, not
 * fail with Docker's "Pool overlaps with other one on this address space".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { MAX_NETWORKS, overlappingIndexes } from './override.js';
import { claimNetwork, networkRow } from './store.js';

const name = (idx: number): string => `nc-wl-test-${idx}`;

describe('overlappingIndexes', () => {
  it('maps subnets in 198.18.0.0/15 to the network indexes they cover', () => {
    expect([...overlappingIndexes(['198.18.0.0/24'])]).toEqual([0]);
    expect([...overlappingIndexes(['198.18.3.0/24', '198.19.44.0/24'])]).toEqual([3, 300]);
    expect([...overlappingIndexes(['198.18.0.0/23'])]).toEqual([0, 1]);
    expect(overlappingIndexes(['198.18.0.128/25']).has(0)).toBe(true);
  });

  it('stops at both edges of the range', () => {
    expect([...overlappingIndexes(['198.19.254.0/24'])]).toEqual([MAX_NETWORKS - 1]);
    expect(overlappingIndexes(['198.19.255.0/24']).size).toBe(0);
    expect(overlappingIndexes(['198.17.255.0/24']).size).toBe(0);
    expect(overlappingIndexes(['198.16.0.0/14']).size).toBe(MAX_NETWORKS);
    expect(overlappingIndexes(['198.18.0.0/15']).size).toBe(MAX_NETWORKS);
  });

  it('ignores subnets outside the range, IPv6 and junk', () => {
    expect(overlappingIndexes(['172.17.0.0/16', '10.0.0.0/8', 'fd00::/64', 'nonsense', '198.20.0.0/24']).size).toBe(0);
  });
});

describe('claimNetwork', () => {
  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
    await getDb().exec(`DELETE FROM workload_networks;`);
  });

  afterEach(async () => {
    await closeDb();
  });

  it('skips indexes whose subnet another install already holds', async () => {
    expect(await claimNetwork('ag-a', name, 512, new Set([0]))).toEqual({ idx: 1, network: 'nc-wl-test-1' });
    expect(await claimNetwork('ag-b', name, 512, new Set([0]))).toEqual({ idx: 2, network: 'nc-wl-test-2' });
  });

  it('moves an agent off a claimed index whose network was never created', async () => {
    expect((await claimNetwork('ag-a', name, 512)).idx).toBe(0);
    expect(await claimNetwork('ag-a', name, 512, new Set([0]))).toEqual({ idx: 1, network: 'nc-wl-test-1' });
    expect((await networkRow('ag-a'))?.idx).toBe(1);
  });

  it('refuses when every free index is held elsewhere', async () => {
    await expect(claimNetwork('ag-a', name, 3, new Set([0, 1, 2]))).rejects.toThrow('no workload networks left');
  });

  it('keeps an existing claim that nothing else holds', async () => {
    await claimNetwork('ag-a', name, 512);
    expect((await claimNetwork('ag-a', name, 512, new Set([5]))).idx).toBe(0);
  });
});
