import { describe, expect, it } from 'vitest';

import {
  assertDiskRoom,
  diskLevel,
  ownersFromInspect,
  parseDockerSize,
  recordUsage,
  usageFromDf,
  __resetDiskForTest,
} from './disk.js';
import { projectName } from './docker.js';
import type { Workload } from './store.js';

const w = (id: string, agentGroupId: string, name: string): Workload => ({ id, agentGroupId, name }) as Workload;
const GB = 1024 ** 3;
const none = { volumes: new Map<string, string>(), containers: new Map<string, string>() };

describe('disk use', () => {
  it('parses docker sizes', () => {
    expect(['970B', '28.7kB', '40.4MB', '1.5GB', '0B', 'N/A'].map(parseDockerSize)).toEqual([
      970, 28700, 40_400_000, 1_500_000_000, 0, 0,
    ]);
  });

  it('knows owners from inspect JSON, where a label value cannot pass for another label', () => {
    const a = w('w1', 'ag1', 'shop');
    const b = w('w2', 'ag2', 'blog');
    const owners = ownersFromInspect(
      [
        { Name: 'v1', Labels: { 'com.docker.compose.project': projectName(a) } },
        // A value with a comma: in `system df` text this read as a second label.
        { Name: 'v2', Labels: { 'com.docker.compose.project': `x,com.docker.compose.project=${projectName(b)}` } },
        { Name: 'v3', Labels: null },
      ],
      [
        {
          Id: 'c1',
          Config: { Labels: { 'nanoclaw.workload': 'w1', 'com.docker.compose.project': projectName(a) } },
        },
        // Claims w2 but runs in w1's project: refused.
        { Id: 'c2', Config: { Labels: { 'nanoclaw.workload': 'w2', 'com.docker.compose.project': projectName(a) } } },
        { Id: 'c3', Config: { Labels: { 'some.label': 'x,nanoclaw.workload=w2' } } },
      ],
      [a, b],
    );
    expect([...owners.volumes]).toEqual([['v1', 'w1']]);
    expect([...owners.containers]).toEqual([['c1', 'w1']]);
  });

  it('adds a workload’s volumes and container layers, and nothing else', () => {
    const a = w('w1', 'ag1', 'shop');
    const df = {
      Volumes: [
        { Name: 'v1', Size: '40MB' },
        { Name: 'other', Size: '5GB' },
      ],
      Containers: [
        { ID: 'c1', Size: '2MB (virtual 400MB)' },
        { ID: 'c9', Size: '9GB' },
      ],
    };
    const owners = { volumes: new Map([['v1', 'w1']]), containers: new Map([['c1', 'w1']]) };
    expect(usageFromDf(df, [a], owners).get('w1')).toBe(42_000_000);
  });

  it('counts its images (unshared part, pulled by digest or built) and the agent’s builder cache once', () => {
    const a = w('w1', 'ag1', 'shop');
    const b = w('w2', 'ag1', 'blog');
    const d = `sha256:${'e'.repeat(64)}`;
    const df = {
      Volumes: [{ Name: 'cache-ag1', Size: '100MB' }],
      Containers: [],
      Images: [
        { Repository: 'shop-web', Tag: 'built', UniqueSize: '20MB', Size: '200MB' },
        { Repository: 'postgres', Tag: '<none>', Digest: d, UniqueSize: '300MB', Size: '300MB' },
      ],
    };
    const u = usageFromDf(df, [a, b], none, {
      images: (x) => (x.id === 'w1' ? ['shop-web:built', `postgres:16@${d}`] : [`postgres:16@${d}`]),
      builderVolume: (g) => `cache-${g}`,
    });
    expect(u.get('w1')).toBe(20_000_000 + 300_000_000 + 100_000_000);
    expect(u.get('w2')).toBe(300_000_000);
  });

  it('warns at 90%, stops over 100%, and refuses starts while over', () => {
    __resetDiskForTest();
    expect([diskLevel(0.5 * GB, 1), diskLevel(0.95 * GB, 1), diskLevel(1.01 * GB, 1)]).toEqual(['ok', 'warn', 'over']);
    recordUsage(
      [w('w1', 'ag1', 'a'), w('w2', 'ag1', 'b')],
      new Map([
        ['w1', 0.7 * GB],
        ['w2', 0.4 * GB],
      ]),
    );
    expect(() => assertDiskRoom('ag1', 1)).toThrow(/1.1 GB of disk; your quota is 1 GB/);
    expect(() => assertDiskRoom('ag1', 2)).not.toThrow();
    expect(() => assertDiskRoom('ag2', 1)).not.toThrow();
  });
});
