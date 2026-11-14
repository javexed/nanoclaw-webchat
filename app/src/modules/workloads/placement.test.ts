/**
 * Placement: workers an owner turned workloads on for, that report, are
 * linked and passed their isolation check recently, take new stacks, by fit,
 * togetherness, pin and free memory.
 */
import { describe, expect, it } from 'vitest';

import type { Member } from '../machines/members.js';
import { placeWorkload, type PlaceDeps } from './placement.js';
import type { Workload } from './store.js';

const NOW = 1_800_000_000_000;

function machine(id: string, memTotalMb: number, over: Partial<Member> = {}): Member {
  return {
    id,
    name: id.toUpperCase(),
    role: 'worker',
    provider: 'manual',
    state: 'ready',
    facts: { cpus: 4, memTotalMb },
    health: {
      cpus: 4,
      memTotalMb,
      memUsedMb: 0,
      memNanoclawMb: 0,
      cpuUsed: 0,
      cpuNanoclaw: 0,
      diskTotalGb: 30,
      diskFreeGb: 20,
    },
    peaks: {},
    lastReport: NOW - 30_000,
    certFp: null,
    certExpires: null,
    prevCertFp: null,
    prevCertExpires: null,
    capMemoryMb: null,
    capCpus: null,
    workloadsOn: true,
    isolation: 'ok',
    isolationAt: NOW - 60_000,
    createdBy: null,
    createdAt: NOW,
    ...over,
  } as Member;
}

const wl = (id: string, agentGroupId: string, node: string, mem: number): Workload =>
  ({ id, agentGroupId, name: id, node, state: 'running', approvedMemoryMb: mem, approvedCpus: 1 }) as Workload;

function deps(
  members: Member[],
  workloads: Workload[] = [],
  opts: { pin?: string; unlinked?: string[] } = {},
): PlaceDeps {
  return {
    members: async () => members,
    linked: (id) => !(opts.unlinked ?? []).includes(id),
    workloads: async () => workloads,
    pin: async () => opts.pin ?? null,
    now: NOW,
  };
}

const need = (memoryMb: number) => ({ memoryMb, cpus: 1 });

describe('placement', () => {
  it('stays on central while no worker is connected', async () => {
    expect(await placeWorkload('ag', need(512), deps([]))).toEqual({ node: 'local', reason: 'no worker connected' });
    const offline = machine('m-1', 16000, { lastReport: NOW - 10 * 60_000 });
    expect((await placeWorkload('ag', need(512), deps([offline]))).node).toBe('local');
    expect((await placeWorkload('ag', need(512), deps([machine('m-1', 16000)], [], { unlinked: ['m-1'] }))).node).toBe(
      'local',
    );
  });

  it('says why a worker that exists is not used, so the card shows it', async () => {
    const r = await placeWorkload('ag', need(512), deps([machine('m-1', 16000)], [], { unlinked: ['m-1'] }));
    expect(r).toEqual({ node: 'local', reason: 'no worker usable: M-1 not linked' });
    const off = machine('m-2', 16000, { lastReport: NOW - 10 * 60_000 });
    expect((await placeWorkload('ag', need(512), deps([off]))).reason).toBe('no worker usable: M-2 not reporting');
    const gone = machine('m-3', 16000, { state: 'revoked' });
    expect((await placeWorkload('ag', need(512), deps([gone]))).reason).toBe('no worker connected');
  });

  it('never places on a draining or revoked machine', async () => {
    const r = await placeWorkload('ag', need(512), deps([machine('m-1', 16000, { state: 'draining' })]));
    expect(r.node).toBe('local');
  });

  it('leaves a worker with too little free disk alone: central takes the stack', async () => {
    const full = machine('m-1', 16000, { health: { ...machine('x', 16000).health!, diskFreeGb: 2 } });
    expect(await placeWorkload('ag', need(512), deps([full]))).toEqual({
      node: 'local',
      reason: 'no worker has 3 GB of disk free',
    });
  });

  it('picks the worker with most free memory, counting what is placed and 15% headroom', async () => {
    const a = machine('m-a', 8000); // share 6800
    const b = machine('m-b', 16000); // share 13600, 12000 placed → 1600 free
    const r = await placeWorkload('ag', need(1000), deps([a, b], [wl('w1', 'other', 'm-b', 12000)]));
    expect(r.node).toBe('m-a');
    expect(r.reason).toMatch(
      /^M-A \(runs workloads, turned on by an owner\): most free memory; fits 1.0 GB with 15% spare$/,
    );
  });

  it("counts only NanoClaw's share of a shared machine (other software's use now)", async () => {
    const base = machine('m-s', 16000);
    const shared = { ...base, health: { ...base.health!, memUsedMb: 8000, cpuUsed: 1 } }; // 16000 − 8000×1.2 − 2400 = 4000
    // No worker with room: central takes it (within central's own ceiling, checked in control.ts).
    expect(await placeWorkload('ag', need(4100), deps([shared]))).toEqual({
      node: 'local',
      reason: 'no worker has room for 4.0 GB (most free: 3.9 GB on M-S)',
    });
    expect((await placeWorkload('ag', need(3000), deps([shared]))).node).toBe('m-s');
  });

  it("keeps an agent's stacks together when its worker still fits them", async () => {
    const a = machine('m-a', 16000);
    const b = machine('m-b', 32000);
    const r = await placeWorkload('ag', need(1000), deps([a, b], [wl('w1', 'ag', 'm-a', 1000)]));
    expect(r.node).toBe('m-a');
    expect(r.reason).toMatch(/with this agent's other stacks/);
  });

  it("an owner's pin wins, and refuses rather than going elsewhere", async () => {
    const a = machine('m-a', 16000);
    const b = machine('m-b', 32000);
    expect((await placeWorkload('ag', need(1000), deps([a, b], [], { pin: 'm-a' }))).node).toBe('m-a');
    expect(await placeWorkload('ag', need(1000), deps([a, b], [], { pin: 'local' }))).toEqual({
      node: 'local',
      reason: 'pinned to central by an owner',
    });
    await expect(placeWorkload('ag', need(1000), deps([b], [], { pin: 'm-a' }))).rejects.toThrow(
      /pinned to a worker that is not available/,
    );
    await expect(placeWorkload('ag', need(20000), deps([a], [], { pin: 'm-a' }))).rejects.toThrow(
      /pinned worker M-A has/,
    );
  });

  it('a pin reaches a draining machine, which takes nothing unpinned', async () => {
    const d = machine('m-d', 16000, { state: 'draining' });
    expect((await placeWorkload('ag', need(1000), deps([d], [], { pin: 'm-d' }))).node).toBe('m-d');
    expect((await placeWorkload('other', need(1000), deps([d]))).node).toBe('local');
  });

  it('ignores deleted stacks when counting what is placed', async () => {
    const a = machine('m-a', 8000);
    const gone = { ...wl('w1', 'x', 'm-a', 6000), state: 'deleted' } as Workload;
    expect((await placeWorkload('ag', need(6000), deps([a], [gone]))).node).toBe('m-a');
  });
});

describe('placement fails closed on isolation, and workers are opt-in', () => {
  const OK = { isolation: 'ok' as const, isolationAt: NOW - 60_000 };

  it('uses a worker only when its isolation check passed recently', async () => {
    expect((await placeWorkload('ag', need(512), deps([machine('m-1', 16000, OK)]))).node).toBe('m-1');
    for (const [over, why] of [
      [{ isolation: 'open', isolationAt: NOW - 60_000 }, /host rules are missing/],
      [{ isolation: 'ok', isolationAt: NOW - 46 * 60_000 }, /last check is too old/],
      [{ isolation: 'unknown', isolationAt: NOW - 60_000 }, /not reported one yet/],
      [{ isolation: null, isolationAt: null }, /not reported one yet/],
      [{ isolation: 'ok', isolationAt: null }, /last check is too old/],
    ] as const) {
      const r = await placeWorkload('ag', need(512), deps([machine('m-1', 16000, over as Partial<Member>)]));
      expect(r.node).toBe('local');
      expect(r.reason).toMatch(/^no worker usable: worker M-1 hasn't passed the isolation check/);
      expect(r.reason).toMatch(why);
    }
  });

  it('a newly joined worker (switch off) takes nothing, and the card says why', async () => {
    const r = await placeWorkload('ag', need(512), deps([machine('m-1', 16000, { workloadsOn: false })]));
    expect(r).toEqual({
      node: 'local',
      reason: 'no worker runs workloads (an owner turns that on per machine in Admin → Machines)',
    });
    // Only the switched-on one is a candidate, even with less room.
    const on = machine('m-on', 8000);
    const off = machine('m-off', 64000, { workloadsOn: false });
    expect((await placeWorkload('ag', need(512), deps([on, off]))).node).toBe('m-on');
  });

  it('a pin outranks the switch, and says it was the pin', async () => {
    const off = machine('m-a', 16000, { workloadsOn: false });
    expect(await placeWorkload('ag', need(512), deps([off], [], { pin: 'm-a' }))).toEqual({
      node: 'm-a',
      reason: 'pinned to M-A by an owner',
    });
  });

  it('a pin never outranks a failed, old or missing isolation check', async () => {
    for (const over of [
      { isolation: 'open' as const },
      { isolationAt: NOW - 2 * 3_600_000 },
      { isolation: null, isolationAt: null },
    ]) {
      const m = machine('m-a', 16000, over);
      await expect(placeWorkload('ag', need(512), deps([m], [], { pin: 'm-a' }))).rejects.toThrow(
        /pinned to M-A, and worker M-A hasn't passed the isolation check/,
      );
    }
  });
});
