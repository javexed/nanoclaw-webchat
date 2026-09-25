import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetMailboxEndpointForTest } from '../channels/webchat/runner-mailbox-endpoint.js';
import { RunnerSessionStore, __setRunnerSessionStoreForTest } from '../channels/webchat/runner-sessions-store.js';
import { RunnerRequestError } from '../channels/webchat/runner-transport.js';

import { FleetSessionDriver, RemoteHandle, type FleetRemotePort } from './fleet-driver.js';
import { fakeLocalDriver } from './fleet-fixture.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import type { SessionEvent, SessionKey, SessionSpec } from './types.js';

// A fake runner on the other end of the port: answers ops, records what it saw.
function fakePort(opts: {
  connected?: string[];
  have?: string[];
  authorize?: boolean;
  imageRef?: string;
  imagePolicy?: 'machine' | 'pull' | 'build';
  roots: FleetRemotePort['roots'];
  /** Containers the runner no longer has: `start` refuses with "no container". */
  gone?: Set<string>;
  /** The laptop's container runtime is not answering: container ops refuse retryably. */
  runtimeDown?: { value: boolean };
  store?: RunnerSessionStore;
  rewake?: FleetRemotePort['rewake'];
}) {
  const store = opts.store ?? new RunnerSessionStore(null);
  // The mailbox endpoint uses the install's store; keep them one and the same.
  __setRunnerSessionStoreForTest(store);
  const calls: Array<{ fp: string; op: string; payload: Record<string, unknown> }> = [];
  const eventCbs: Array<(fp: string, e: SessionEvent) => void> = [];
  const hbCbs: Array<(fp: string, k: SessionKey, m: number) => void> = [];
  const attachCbs: Array<(fp: string) => void> = [];
  const detachCbs: Array<(fp: string) => void> = [];
  const runtimeCbs: Array<(fp: string, reachable: boolean, detail?: string) => void> = [];
  const touched: Array<{ key: SessionKey; mtimeMs: number }> = [];
  const stored = new Set(opts.have ?? []);
  const states = new Map<string, string>();
  const port: FleetRemotePort & {
    calls: typeof calls;
    touched: typeof touched;
    emit: (fp: string, e: SessionEvent) => void;
    beat: (fp: string, k: SessionKey, m: number) => void;
    reconnect: (fp: string) => void;
    disconnect: (fp: string) => void;
    runtime: (fp: string, reachable: boolean) => void;
    states: typeof states;
  } = {
    calls,
    touched,
    states,
    emit: (fp, e) => eventCbs.forEach((cb) => cb(fp, e)),
    beat: (fp, k, m) => hbCbs.forEach((cb) => cb(fp, k, m)),
    reconnect: (fp) => {
      if (opts.connected && !opts.connected.includes(fp)) opts.connected.push(fp);
      attachCbs.forEach((cb) => cb(fp));
    },
    disconnect: (fp) => {
      if (opts.connected) opts.connected.splice(opts.connected.indexOf(fp), 1);
      detachCbs.forEach((cb) => cb(fp));
    },
    runtime: (fp, reachable) => runtimeCbs.forEach((cb) => cb(fp, reachable)),
    async request(fp, op, payload = {}) {
      calls.push({ fp, op, payload });
      if (!(opts.connected ?? []).includes(fp)) throw new RunnerRequestError('not-connected', 'nope');
      if (opts.runtimeDown?.value && ['start', 'stop', 'status'].includes(op))
        throw new RunnerRequestError('refused', 'cannot inspect: connection refused', {
          kind: 'runtime-unavailable',
          retryable: true,
        });
      switch (op) {
        case 'have':
          return { missing: (payload.hashes as string[]).filter((h) => !stored.has(h)) };
        case 'bundle':
          if (payload.seq === (payload.total as number) - 1) stored.add(payload.hash as string);
          return {};
        case 'prepare':
          states.set((payload.spec as { name: string }).name, 'created');
          return { name: (payload.spec as { name: string }).name };
        case 'start':
          if (opts.gone?.has(payload.name as string))
            throw new RunnerRequestError('refused', `unknown: no container ${String(payload.name)}`);
          states.set(payload.name as string, 'running');
          return {};
        case 'status':
          if (opts.gone?.has(payload.name as string)) return { state: 'absent' };
          return { state: states.get(payload.name as string) ?? 'absent', exitCode: 0 };
        case 'stop':
          states.set(payload.name as string, 'exited');
          return {};
        case 'list':
          return {
            sessions: [...states].map(([name, state]) => ({
              name,
              state,
              key: { installSlug: 'spike', agentGroupId: 'g9', sessionId: name },
            })),
          };
        default:
          throw new RunnerRequestError('refused', `unknown op ${op}`);
      }
    },
    isConnected: (fp) => (opts.connected ?? []).includes(fp),
    connected: () => opts.connected ?? [],
    onEvent: (cb) => {
      eventCbs.push(cb);
      return () => {};
    },
    onHeartbeat: (cb) => {
      hbCbs.push(cb);
      return () => {};
    },
    onAttached: (cb) => {
      attachCbs.push(cb);
    },
    onDetached: (cb) => {
      detachCbs.push(cb);
    },
    onRuntime: (cb) => {
      runtimeCbs.push(cb);
    },
    suspendHoldMs: 60 * 60 * 1000,
    store,
    ...(opts.rewake ? { rewake: opts.rewake } : {}),
    authorize: async () => (opts.authorize === false ? { ok: false, reason: 'not admitted' } : { ok: true }),
    imageSource: async () => ({
      ...(opts.imageRef ? { ref: opts.imageRef } : {}),
      policy: opts.imagePolicy ?? ('machine' as const),
    }),
    roots: opts.roots,
    touchHeartbeat: (key, mtimeMs) => touched.push({ key, mtimeMs }),
  };
  return port;
}

const FP = 'f'.repeat(64);
let tmp: string;
let spec: SessionSpec;
let roots: FleetRemotePort['roots'];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-fleet-'));
  // Materialize the fixture's mount sources under FIXTURE_POLICY's roots, remapped into tmp.
  roots = {
    dataRoot: path.join(tmp, 'install/data'),
    groupsRoot: path.join(tmp, 'install/groups'),
    buildContext: path.join(tmp, 'install/container'),
  };
  fs.mkdirSync(path.join(tmp, 'install/data/v2-sessions/g1/s1'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'install/data/v2-sessions/g1/s1/inbound.db'), 'db');
  fs.mkdirSync(path.join(tmp, 'install/container/agent-runner/src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'install/container/agent-runner/src/index.ts'), 'x');
  fs.writeFileSync(path.join(tmp, 'install/container/CLAUDE.md'), '# c');
  fs.writeFileSync(path.join(tmp, 'install/container/Dockerfile'), 'FROM scratch');
  const base = fixtureSpec();
  const remap = (p: string) => p.replace('/install', path.join(tmp, 'install'));
  spec = {
    ...base,
    containers: base.containers.map((c) => ({
      ...c,
      env: { ...c.env, HTTPS_PROXY: 'http://x:tok@host.docker.internal:10255' },
      mounts: c.mounts.map((m) => ({ ...m, hostPath: remap(m.hostPath) })),
    })),
  };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  __resetMailboxEndpointForTest();
  __setRunnerSessionStoreForTest(null);
});

const policy = () => ({
  ...FIXTURE_POLICY,
  groupsRoot: roots.groupsRoot,
  dataRoot: roots.dataRoot,
  surfaceRoots: FIXTURE_POLICY.surfaceRoots.map((s) => s.replace('/install', path.join(tmp, 'install'))),
  materialsRoot: path.join(tmp, 'install/data/session-materials'),
});
const placement = { agent_group_id: 'g1', fingerprint: FP, slots_json: '{}', created_by: 'o', created_at: 1 };

describe('fleet driver, remote path', () => {
  it('ships only the missing bundles, prepares by name, and returns a remote handle holding the proxy credential', async () => {
    const port = fakePort({ connected: [FP], roots });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const handle = (await fleet.prepare(spec)) as RemoteHandle;
    expect(handle).toBeInstanceOf(RemoteHandle);
    expect(handle.name).toBe('ncl-spike-s1');
    expect(handle.proxyTarget).toEqual({ host: 'host.docker.internal', port: 10255, username: 'x', password: 'tok' });
    const ops = port.calls.map((c) => c.op);
    expect(ops[0]).toBe('have');
    expect(ops.filter((o) => o === 'bundle').length).toBeGreaterThan(0);
    expect(ops[ops.length - 1]).toBe('prepare');
    const sent = port.calls.find((c) => c.op === 'prepare')!.payload.spec as { env: Record<string, string> };
    expect(sent.env.HTTPS_PROXY).not.toContain('tok');
    // second prepare of the same spec: everything is cached, nothing re-shipped
    port.calls.length = 0;
    await fleet.prepare(spec);
    expect(port.calls.map((c) => c.op)).toEqual(['have', 'prepare']);
  });

  it("a placement's declared slot reaches the runner as a slot to bind, with the project-dir hint", async () => {
    const port = fakePort({ connected: [FP], roots });
    const fleet = new FleetSessionDriver(
      fakeLocalDriver(),
      async () => ({
        ...placement,
        slots_json: '{"/workspace/project":{"mode":"rw","exclude":["*.tfvars"],"propose":true}}',
      }),
      policy(),
      port,
    );
    await fleet.prepare(spec);
    const sent = port.calls.find((c) => c.op === 'prepare')!.payload.spec as {
      mounts: Array<{ kind: string; containerPath: string; mode?: string }>;
      env: Record<string, string>;
    };
    expect(sent.mounts).toContainEqual({
      kind: 'slot',
      class: 'allowlisted-extra',
      containerPath: '/workspace/project',
      mode: 'rw',
      exclude: ['*.tfvars'],
      propose: true,
    });
    expect(sent.env.NANOCLAW_PROJECT_DIR).toBe('/workspace/project');
    expect(sent.env.NANOCLAW_PROJECT_MODE).toBe('propose');
    // The placeholder host path never travels: a slot names only the container side.
    expect(JSON.stringify(sent)).not.toContain('nonexistent');
    // No declared slots → nothing added, no hint.
    const port2 = fakePort({ connected: [FP], roots });
    const fleet2 = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port2);
    await fleet2.prepare(spec);
    const plain = port2.calls.find((c) => c.op === 'prepare')!.payload.spec as {
      mounts: Array<{ containerPath: string }>;
      env: Record<string, string>;
    };
    expect(plain.mounts.some((m) => m.containerPath === '/workspace/project')).toBe(false);
    expect(plain.env.NANOCLAW_PROJECT_DIR).toBeUndefined();
  });

  it('a placed group with its runner offline fails retryable, and an unauthorized machine is denied', async () => {
    const offline = new FleetSessionDriver(
      fakeLocalDriver(),
      async () => placement,
      policy(),
      fakePort({ connected: [], roots }),
    );
    await expect(offline.prepare(spec)).rejects.toMatchObject({ kind: 'runtime-unavailable', retryable: true });
    const denied = new FleetSessionDriver(
      fakeLocalDriver(),
      async () => placement,
      policy(),
      fakePort({ connected: [FP], roots, authorize: false }),
    );
    await expect(denied.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  it('the remote handle drives start/status/stop over the port', async () => {
    const port = fakePort({ connected: [FP], roots });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const handle = await fleet.prepare(spec);
    expect(await handle.status()).toEqual({ phase: 'ready' });
    await handle.start();
    expect(await handle.status()).toEqual({ phase: 'running' });
    await handle.stop('test');
    expect(await handle.status()).toEqual({ phase: 'stopped' });
    expect(handle.execSpec(['ls']).argsPlain).toEqual(['exec', '-i', 'ncl-spike-s1', 'ls']);
  });

  it('re-asserts a running session when its runner reconnects, and only while it is running', async () => {
    const port = fakePort({ connected: [FP], roots });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const handle = await fleet.prepare(spec);
    // Not started yet: a reconnect has nothing to re-assert.
    port.calls.length = 0;
    port.reconnect(FP);
    await new Promise((r) => setTimeout(r, 10));
    expect(port.calls.map((c) => c.op)).toEqual([]);

    await handle.start();
    port.calls.length = 0;
    // The extension host reloaded: the runner forgot the container. Central re-issues start.
    port.reconnect(FP);
    await new Promise((r) => setTimeout(r, 10));
    expect(port.calls.map((c) => c.op)).toEqual(['start']);
    expect(port.calls[0].payload).toMatchObject({ name: 'ncl-spike-s1', key: spec.key, resume: true });
    // Another machine reconnecting is not this session's business.
    port.calls.length = 0;
    port.reconnect('b'.repeat(64));
    await new Promise((r) => setTimeout(r, 10));
    expect(port.calls).toEqual([]);

    await handle.stop('test');
    port.calls.length = 0;
    port.reconnect(FP);
    await new Promise((r) => setTimeout(r, 10));
    expect(port.calls.map((c) => c.op)).toEqual([]);
  });

  it("a reconnecting runner that answers 'no container' ends the session instead of leaving it running forever", async () => {
    const gone = new Set<string>();
    const port = fakePort({ connected: [FP], roots, gone });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const events: Array<{ kind: string; sessionId: string }> = [];
    fleet.watchSessions('spike', (e) => events.push({ kind: e.kind, sessionId: e.key.sessionId }));
    const handle = await fleet.prepare(spec);
    await handle.start();
    expect(await handle.status()).toEqual({ phase: 'running' });

    // The container was removed while no supervision was attached (a reload).
    gone.add('ncl-spike-s1');
    port.calls.length = 0;
    port.reconnect(FP);
    await new Promise((r) => setTimeout(r, 10));
    expect(port.calls.map((c) => c.op)).toEqual(['start']);
    // Central learns of the death from the refusal itself…
    expect(events).toEqual([{ kind: 'terminal', sessionId: 's1' }]);
    expect(await handle.status()).toEqual({ phase: 'stopped' });
    // …and does not keep re-asserting a session it now knows is gone.
    port.calls.length = 0;
    port.reconnect(FP);
    await new Promise((r) => setTimeout(r, 10));
    expect(port.calls).toEqual([]);
  });

  it('forwards events and mirrors heartbeats only for sessions placed on THAT runner', async () => {
    const port = fakePort({ connected: [FP], roots });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const seen: SessionEvent[] = [];
    fleet.watchSessions('spike', (e) => seen.push(e));
    await fleet.prepare(spec);
    port.emit(FP, { key: spec.key, kind: 'terminal' });
    port.emit('other-runner', { key: spec.key, kind: 'terminal' }); // impostor
    port.emit(FP, { key: { ...spec.key, sessionId: 'never-placed' }, kind: 'terminal' });
    expect(seen).toEqual([{ key: spec.key, kind: 'terminal' }]);
    port.beat(FP, spec.key, 1234);
    port.beat('other-runner', spec.key, 999);
    expect(port.touched).toEqual([{ key: spec.key, mtimeMs: 1234 }]);
  });

  it('listSessions merges local docker with what connected runners report', async () => {
    const port = fakePort({ connected: [FP], roots });
    port.states.set('ncl-spike-zz', 'running');
    // The reported session's agent (g9) is placed on this runner.
    const placedHere = async (ag: string) => (ag === 'g9' ? { ...placement, agent_group_id: 'g9' } : undefined);
    const fleet = new FleetSessionDriver(fakeLocalDriver(), placedHere, policy(), port);
    const snaps = await fleet.listSessions('spike');
    expect(snaps.map((s) => [s.handle.name, s.phase])).toEqual([['ncl-spike-zz', 'running']]);
    expect(snaps[0].handle).toBeInstanceOf(RemoteHandle);
    // a runner that fails to answer does not break the listing
    const flaky = fakePort({ connected: ['g'.repeat(64)], roots });
    flaky.request = vi.fn(async () => {
      throw new RunnerRequestError('timeout', 't');
    });
    expect(
      await new FleetSessionDriver(fakeLocalDriver(), async () => undefined, policy(), flaky).listSessions('spike'),
    ).toEqual([]);
  });

  it('listSessions never lets a runner claim a session that is not its own', async () => {
    const port = fakePort({ connected: [FP], roots });
    port.states.set('ncl-spike-zz', 'running');
    // g9 is not placed on this runner: its report is ignored.
    const elsewhere = async () => ({ ...placement, agent_group_id: 'g9', fingerprint: 'e'.repeat(64) });
    expect(await new FleetSessionDriver(fakeLocalDriver(), elsewhere, policy(), port).listSessions('spike')).toEqual(
      [],
    );
    expect(
      await new FleetSessionDriver(fakeLocalDriver(), async () => undefined, policy(), port).listSessions('spike'),
    ).toEqual([]);
  });

  it('listSessions does not re-point a session another runner already owns', async () => {
    const other = 'e'.repeat(64);
    const port = fakePort({ connected: [FP, other], roots });
    port.states.set('ncl-spike-zz', 'running');
    // g9 is placed on FP; the impostor reports the same session too.
    const onFp = async (ag: string) => (ag === 'g9' ? { ...placement, agent_group_id: 'g9' } : undefined);
    const fleet = new FleetSessionDriver(fakeLocalDriver(), onFp, policy(), port);
    const snaps = await fleet.listSessions('spike');
    expect(snaps.map((s) => (s.handle as RemoteHandle).fingerprint)).toEqual([FP]);
  });
});

describe('fleet driver, suspension', () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));
  async function running(port: ReturnType<typeof fakePort>) {
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const events: string[] = [];
    fleet.watchSessions('spike', (e) => events.push(e.kind));
    const handle = (await fleet.prepare(spec)) as RemoteHandle;
    await handle.start();
    return { fleet, handle, events };
  }

  it('a runner that disconnects holds its sessions: heartbeats stay fresh, stale mirrors are ignored, the absence is not idleness', async () => {
    const port = fakePort({ connected: [FP], roots });
    const { fleet, handle } = await running(port);
    port.touched.length = 0;
    const before = Date.now();
    port.disconnect(FP);
    expect(handle.suspendedSince).not.toBeNull();
    // Held at once, and on every tick of the hold.
    expect(port.touched.length).toBe(1);
    expect(port.touched[0].mtimeMs).toBeGreaterThanOrEqual(before);
    fleet.holdSuspended(Date.now() + 40 * 60 * 1000);
    expect(port.touched.length).toBe(2);
    // A stale mirror from the laptop cannot age a held session.
    port.beat(FP, spec.key, 1000);
    expect(port.touched.length).toBe(2);
    // Status is the last known phase, not a round trip to a sleeping laptop.
    expect(await handle.status()).toEqual({ phase: 'running' });

    // The laptop wakes: the session is re-asserted and resumed.
    port.calls.length = 0;
    port.reconnect(FP);
    await tick();
    expect(port.calls.map((c) => c.op)).toEqual(['start']);
    expect(handle.suspendedSince).toBeNull();
    // After the resume, the old mirror is floored at the resume time.
    port.touched.length = 0;
    port.beat(FP, spec.key, 1000);
    expect(port.touched[0].mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it('a status read the runtime cannot answer keeps the last phase instead of reading as failed', async () => {
    const runtimeDown = { value: false };
    const port = fakePort({ connected: [FP], roots, runtimeDown });
    const { handle } = await running(port);
    runtimeDown.value = true;
    expect(await handle.status()).toEqual({ phase: 'running' });
  });

  it('the hold is bounded: past it, the session is released to the ordinary ceiling', async () => {
    const port = fakePort({ connected: [FP], roots });
    const { fleet } = await running(port);
    port.disconnect(FP);
    port.touched.length = 0;
    fleet.holdSuspended(Date.now() + 2 * 60 * 60 * 1000); // two hours > the one-hour hold
    expect(port.touched).toEqual([]);
  });

  it('a machine back without its runtime keeps the session held and retries, then resumes when the runtime answers', async () => {
    const runtimeDown = { value: false };
    const port = fakePort({ connected: [FP], roots, runtimeDown });
    const { handle, events } = await running(port);
    port.disconnect(FP);
    runtimeDown.value = true;
    port.calls.length = 0;
    port.reconnect(FP);
    await tick();
    expect(port.calls.map((c) => c.op)).toEqual(['start']);
    // Not ended, not respawned — still held.
    expect(events).toEqual([]);
    expect(handle.suspendedSince).not.toBeNull();
    expect(handle.live).toBe(true);
    // The runner says its runtime is back: re-assert at once, no waiting on the backoff.
    runtimeDown.value = false;
    port.runtime(FP, false);
    port.calls.length = 0;
    port.runtime(FP, true);
    await tick();
    expect(port.calls.map((c) => c.op)).toEqual(['start']);
    expect(handle.suspendedSince).toBeNull();
  });

  it('a runtime that goes away while the runner stays connected also holds the session', async () => {
    const port = fakePort({ connected: [FP], roots });
    const { handle } = await running(port);
    port.runtime(FP, false);
    expect(handle.suspendedSince).not.toBeNull();
    port.runtime(FP, true);
    await tick();
    expect(handle.suspendedSince).toBeNull();
  });

  it('respawns only when the container is genuinely gone after the machine returns', async () => {
    const gone = new Set<string>();
    const port = fakePort({ connected: [FP], roots, gone });
    const { handle, events } = await running(port);
    port.disconnect(FP);
    gone.add('ncl-spike-s1'); // podman's machine restarted: the container did not survive
    port.reconnect(FP);
    await tick();
    expect(events).toEqual(['terminal']);
    expect(handle.live).toBe(false);
    // Released: a later absence of the machine holds nothing on its behalf.
    port.touched.length = 0;
    port.disconnect(FP);
    expect(port.touched).toEqual([]);
  });

  it('a stop issued while the machine is away is delivered when it returns, before anything is realized again', async () => {
    const port = fakePort({ connected: [FP], roots });
    const { fleet, handle } = await running(port);
    port.disconnect(FP);
    await handle.stop('absolute-ceiling');
    expect(await handle.status()).toEqual({ phase: 'stopped' });
    port.calls.length = 0;
    port.reconnect(FP);
    await tick();
    expect(port.calls.map((c) => [c.op, c.payload.name])).toEqual([['stop', 'ncl-spike-s1']]);
    // Delivered once, not on every return.
    port.calls.length = 0;
    port.reconnect(FP);
    await tick();
    expect(port.calls).toEqual([]);

    // A respawn that races the reconnect's pass: the stop still goes first.
    const h2 = (await fleet.prepare(spec)) as RemoteHandle;
    await h2.start();
    port.disconnect(FP);
    await h2.stop('absolute-ceiling');
    port.connected().push(FP);
    port.calls.length = 0;
    await fleet.prepare(spec);
    expect(port.calls[0]).toMatchObject({ op: 'stop', payload: { name: 'ncl-spike-s1' } });
  });

  it('a terminal event from the runner releases the handle, so a later re-assert cannot restart it', async () => {
    const port = fakePort({ connected: [FP], roots });
    const { handle } = await running(port);
    port.emit(FP, { key: spec.key, kind: 'terminal' });
    expect(handle.live).toBe(false);
    port.calls.length = 0;
    port.runtime(FP, false);
    port.runtime(FP, true);
    port.reconnect(FP);
    await tick();
    expect(port.calls).toEqual([]);
  });
});

describe('fleet driver, central restarts', () => {
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  it('a runner reconnecting to a restarted central gets its remembered sessions woken, with the token they already carry', async () => {
    const store = new RunnerSessionStore(null);
    // Before the restart: a session prepared and running on FP.
    const before = fakePort({ connected: [FP], roots, store });
    const old = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), before);
    const h = (await old.prepare(spec)) as RemoteHandle;
    await h.start();
    const token = (before.calls.find((c) => c.op === 'prepare')!.payload.spec as { env: Record<string, string> }).env
      .NANOCLAW_MAILBOX_TOKEN;
    expect(store.get(spec.key)).toMatchObject({ fingerprint: FP, name: 'ncl-spike-s1', token });

    // Central restarts: a new driver, nothing in memory, the store on disk.
    __resetMailboxEndpointForTest();
    const woken: string[] = [];
    let fresh!: FleetSessionDriver;
    const after = fakePort({
      connected: [],
      roots,
      store,
      rewake: async (key) => {
        woken.push(key.sessionId);
        // What the spawn path does: prepare + start through this driver.
        const again = await fresh.prepare(spec);
        await again.start();
        return 'ok';
      },
    });
    fresh = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), after);
    fresh.watchSessions('spike', () => {});
    after.reconnect(FP);
    await tick(30);
    expect(woken).toEqual(['s1']);
    // Same token in the new spec: the runner sees an unchanged container and adopts it.
    const respec = after.calls.find((c) => c.op === 'prepare')!.payload.spec as { env: Record<string, string> };
    expect(respec.env.NANOCLAW_MAILBOX_TOKEN).toBe(token);
    // A second reconnect does not wake it again: it is supervised now.
    after.reconnect(FP);
    await tick(30);
    expect(woken).toEqual(['s1']);
  });

  it('a session no longer active is stopped on its machine and forgotten; a retry is retried', async () => {
    const store = new RunnerSessionStore(null);
    store.put({ key: spec.key, fingerprint: FP, token: 't', name: 'ncl-spike-s1' });
    const outcomes: Array<'retry' | 'gone'> = ['retry', 'gone'];
    const port = fakePort({ connected: [], roots, store, rewake: async () => outcomes.shift()! });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    fleet.watchSessions('spike', () => {});
    port.reconnect(FP);
    await tick(5_300); // the first retry waits 5 s
    expect(outcomes).toEqual([]);
    expect(port.calls.filter((c) => c.op === 'stop').map((c) => c.payload.name)).toEqual(['ncl-spike-s1']);
    expect(store.get(spec.key)).toBeUndefined();
  }, 10_000);

  it('a machine back after its hold ran out gets its old session stopped, not resumed', async () => {
    const store = new RunnerSessionStore(null);
    store.put({
      key: spec.key,
      fingerprint: FP,
      token: 't',
      name: 'ncl-spike-s1',
      suspendedSince: Date.now() - 2 * 60 * 60 * 1000,
    });
    const woken: string[] = [];
    const port = fakePort({
      connected: [],
      roots,
      store,
      rewake: async (k) => {
        woken.push(k.sessionId);
        return 'ok';
      },
    });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    fleet.watchSessions('spike', () => {});
    port.reconnect(FP);
    await tick(30);
    expect(woken).toEqual([]);
    expect(port.calls.filter((c) => c.op === 'stop').map((c) => c.payload.name)).toEqual(['ncl-spike-s1']);
    expect(store.get(spec.key)).toBeUndefined();
  });

  it('a stop queued while the machine was away survives a central restart', async () => {
    const store = new RunnerSessionStore(null);
    const port = fakePort({ connected: [FP], roots, store });
    const fleet = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port);
    const h = await fleet.prepare(spec);
    await h.start();
    port.disconnect(FP);
    await h.stop('absolute-ceiling');
    expect(store.stops(FP)).toEqual({ 'ncl-spike-s1': 'absolute-ceiling' });
    // Restart, then the machine returns.
    const port2 = fakePort({ connected: [], roots, store });
    const fleet2 = new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy(), port2);
    fleet2.watchSessions('spike', () => {});
    port2.reconnect(FP);
    await tick(30);
    expect(port2.calls.filter((c) => c.op === 'stop').map((c) => c.payload.name)).toEqual(['ncl-spike-s1']);
    expect(store.stops(FP)).toEqual({});
  });
});
