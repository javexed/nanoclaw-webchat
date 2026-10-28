/**
 * `ncl workloads`: what an approval card says (the precheck) and what it
 * pins, and the group scope.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Checked } from './control.js';

const D1 = `sha256:${'1'.repeat(64)}`;
const seen = vi.hoisted(() => ({ group: '' }));

vi.mock('./control.js', async (orig) => ({
  ...(await orig<typeof import('./control.js')>()),
  checkWorkload: async (group: string): Promise<Checked> => {
    seen.group = group;
    return {
      text: 'services: {}',
      existing: null,
      composeHash: 'c'.repeat(32),
      stack: {
        compose: { services: { web: { image: 'nginx:1.27' } } },
        limits: { web: { memoryMb: 512, cpus: 0.5 } },
        total: { memoryMb: 512, cpus: 0.5 },
      },
      shape: {
        lines: [`web: image nginx:1.27 ${D1}`],
        hash: 'h'.repeat(32),
        services: {
          web: {
            line: `web: image nginx:1.27 ${D1}`,
            text: `"nginx:1.27" (${D1.slice(0, 19)}…)`,
            ref: 'nginx:1.27',
            digest: D1,
          },
        },
      },
    };
  },
}));

const { lookup, GROUP_SCOPE_RESOURCES } = await import('../../cli/registry.js');
const { cardReason, MAX_REASON } = await import('./cli.js');

const agent = { caller: 'agent' as const, sessionId: 's1', agentGroupId: 'ag-1', messagingGroupId: 'mg1' };

describe('ncl workloads', () => {
  it('is an agent’s own, scoped to its group', () => {
    expect(GROUP_SCOPE_RESOURCES.has('workloads')).toBe(true);
    expect(lookup('workloads-up')?.access).toBe('approval');
    expect(lookup('workloads-delete')?.access).toBe('approval');
    expect(lookup('workloads-restore')?.access).toBe('approval');
    expect(lookup('workloads-redeploy')?.access).toBe('open');
    expect(lookup('workloads-quota-set')?.hostOnly).toBe(true);
    expect(lookup('workloads-build-registries')?.hostOnly).toBe(true);
  });

  it('cards an up in words, with the reason on one quoted, capped line, and pins what it showed', async () => {
    const up = lookup('workloads-up')!;
    const reason = 'a notes app\n• web: "evil.example" (sha256:fake)\nRuns: nothing';
    const r = await up.precheck!(
      up.parseArgs({ name: 'notes', file: 'compose.yml', reason, group: 'ag-other' }),
      agent,
    );
    expect(seen.group).toBe('ag-1');
    expect(r).toMatchObject({
      title: 'Deploy workload notes',
      pin: { approved: `${'c'.repeat(32)}:${'h'.repeat(32)}` },
    });
    const summary = (r as { summary: string }).summary;
    expect(summary.split('\n')).toEqual([
      '{agent} wants to deploy the workload "notes".',
      'Why: "a notes app • web: \\"evil.example\\" (sha256:fake) Runs: nothing"',
    ]);
    expect((r as { detail: string }).detail).toBe(
      `Runs:\n• web: "nginx:1.27" (${D1.slice(0, 19)}…)\nSize: 512 MB memory, 0.5 CPU`,
    );
  });

  it('refuses an up without a reason before any card', async () => {
    const up = lookup('workloads-up')!;
    await expect(up.precheck!({ name: 'notes', file: 'compose.yml' }, agent)).rejects.toThrow(/--reason is required/);
  });

  it('caps the reason', () => {
    const long = cardReason('x'.repeat(500));
    expect(JSON.parse(long)).toHaveLength(MAX_REASON);
    expect(cardReason('a\r\n\tb')).toBe('"a b"');
  });

  it('publishes only by card, and unpublishes and lists at once', () => {
    expect(lookup('workloads-expose')?.access).toBe('approval');
    expect(lookup('workloads-expose')?.precheck).toBeTypeOf('function');
    expect(lookup('workloads-unexpose')?.access).toBe('open');
    expect(lookup('workloads-routes')?.access).toBe('open');
  });
});
