/**
 * The remote event path, end to end through the REAL modules: a runner's
 * `terminal` frame → runner-transport → the fleet driver's fan-in → the
 * session-events hub → the caller's onTerminal.
 *
 * Every other test in this area fakes one of those seams. This one fakes only
 * the socket, because the bug it exists to catch — a remotely placed session
 * that dies and is not noticed until the 30-minute ceiling kills it — lives in
 * the wiring BETWEEN them, and each seam looks correct on its own.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import {
  __resetRunnerTransportForTest,
  attachRunnerLink,
  connectedRunnerFingerprints,
  handleRunnerFrame,
  isRunnerConnected,
  onRunnerEvent,
  onRunnerHeartbeat,
  runnerRequest,
} from '../channels/webchat/runner-transport.js';

import { FleetSessionDriver, type FleetRemotePort } from './fleet-driver.js';
import { fakeLocalDriver } from './fleet-fixture.js';
import { withSessionEvents } from './session-events.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import type { SessionSpec } from './types.js';

const FP = 'a'.repeat(64);
let tmp: string;
let spec: SessionSpec;
let roots: FleetRemotePort['roots'];
/** What the fake runner claims `status` sees; 'absent' is a container that ran with --rm and exited. */
let containerState = 'running';

/** A socket that answers central's requests the way the runner agent would. */
function fakeRunnerSocket(): WebSocket {
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(raw: string) {
      const req = JSON.parse(raw) as { type: string; id: string; op: string };
      if (req.type !== 'req') return;
      const reply = (body: Record<string, unknown>) =>
        setImmediate(() => handleRunnerFrame(FP, { type: 'res', id: req.id, ok: true, ...body }));
      if (req.op === 'have') return reply({ missing: [] });
      if (req.op === 'prepare') return reply({ name: 'ncl-spike-s1' });
      if (req.op === 'start') return reply({});
      if (req.op === 'status') return reply({ state: containerState });
      return reply({});
    },
  };
  return ws as unknown as WebSocket;
}

const placement = { agent_group_id: 'g1', fingerprint: FP, slots_json: '{}', created_by: 'o', created_at: 1 };

beforeEach(() => {
  __resetRunnerTransportForTest();
  containerState = 'running';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-events-'));
  roots = {
    dataRoot: path.join(tmp, 'install/data'),
    groupsRoot: path.join(tmp, 'install/groups'),
    buildContext: path.join(tmp, 'install/container'),
  };
  fs.mkdirSync(path.join(tmp, 'install/data/v2-sessions/g1/s1'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'install/container/agent-runner/src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'install/container/agent-runner/src/index.ts'), 'x');
  fs.writeFileSync(path.join(tmp, 'install/container/CLAUDE.md'), '# c');
  const base = fixtureSpec();
  const remap = (p: string) => p.replace('/install', path.join(tmp, 'install'));
  spec = {
    ...base,
    containers: base.containers.map((c) => ({
      ...c,
      mounts: c.mounts.map((m) => ({ ...m, hostPath: remap(m.hostPath) })),
    })),
  };
  attachRunnerLink({ fingerprint: FP, userId: 'webchat:dev', ws: fakeRunnerSocket() });
});
afterEach(() => {
  __resetRunnerTransportForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fleet() {
  const port: FleetRemotePort = {
    request: runnerRequest,
    isConnected: isRunnerConnected,
    connected: connectedRunnerFingerprints,
    onEvent: onRunnerEvent,
    onHeartbeat: onRunnerHeartbeat,
    authorize: async () => ({ ok: true }),
    imageSource: async () => ({ policy: 'machine' }),
    roots,
    touchHeartbeat: () => {},
  };
  const policy = {
    ...FIXTURE_POLICY,
    dataRoot: roots.dataRoot,
    groupsRoot: roots.groupsRoot,
    surfaceRoots: FIXTURE_POLICY.surfaceRoots.map((s) => s.replace('/install', path.join(tmp, 'install'))),
    materialsRoot: path.join(tmp, 'install/data/session-materials'),
  };
  return withSessionEvents(new FleetSessionDriver(fakeLocalDriver(), async () => placement, policy, port));
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('a remotely placed session that dies is noticed at once', () => {
  it("the runner's terminal frame reaches the caller's onTerminal", async () => {
    const hub = fleet();
    const handle = await hub.prepare(spec);
    await handle.start();
    let ended = false;
    handle.onTerminal(() => {
      ended = true;
    });

    containerState = 'absent'; // --rm removed it when it exited
    handleRunnerFrame(FP, { type: 'event', key: spec.key, kind: 'terminal' });
    await settle();

    expect(ended).toBe(true);
  });

  it('a still-running container is not declared dead by a spurious frame', async () => {
    const hub = fleet();
    const handle = await hub.prepare(spec);
    await handle.start();
    let ended = false;
    handle.onTerminal(() => {
      ended = true;
    });

    handleRunnerFrame(FP, { type: 'event', key: spec.key, kind: 'terminal' }); // state stays 'running'
    await settle();

    expect(ended).toBe(false);
  });

  it('a frame from a runner this session was not placed on is ignored', async () => {
    const hub = fleet();
    const handle = await hub.prepare(spec);
    await handle.start();
    let ended = false;
    handle.onTerminal(() => {
      ended = true;
    });

    containerState = 'absent';
    handleRunnerFrame('b'.repeat(64), { type: 'event', key: spec.key, kind: 'terminal' });
    await settle();

    expect(ended).toBe(false);
  });
});
