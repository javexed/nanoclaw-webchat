/**
 * Teardown racing the daemon's own `--rm` removal. The session container is
 * created with `--rm`, so after `docker stop` the daemon starts deleting it and
 * our `rm --force` can lose the race; that must not read as a failed teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerSessionDriver, removalWaitClock } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

const IN_PROGRESS = 'Error response from daemon: removal of container ncl-spike-s1 is already in progress';

/** `ps -a` answers from a script, one entry per call (the last one repeats). */
class ScriptedPsCli extends FakeCli {
  ps: Array<string | Error> = [''];
  override run(args: string[], opts?: { input?: string }): string {
    if (args[0] === 'ps') {
      super.run(args, opts);
      const next = this.ps.length > 1 ? this.ps.shift()! : this.ps[0];
      if (next instanceof Error) throw next;
      return next;
    }
    return super.run(args, opts);
  }
}

let cli: ScriptedPsCli;

async function preparedHandle() {
  const driver = new DockerSessionDriver({ ...FIXTURE_POLICY, cli });
  return driver.prepare(fixtureSpec());
}

const realClock = { ...removalWaitClock };
/** Virtual time the settle wait reads; its sleeps advance it instead of waiting. */
let clock = 0;
const sleeps: number[] = [];

beforeEach(() => {
  cli = new ScriptedPsCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  clock = 0;
  sleeps.length = 0;
  removalWaitClock.now = () => clock;
  removalWaitClock.sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
});

afterEach(() => {
  Object.assign(removalWaitClock, realClock);
});

describe('stop() racing auto-removal', () => {
  it('treats "removal already in progress" as a completed teardown', async () => {
    const handle = await preparedHandle();
    cli.responses.unshift({ match: /^rm /, throws: new Error(IN_PROGRESS) });
    cli.ps = ['ncl-spike-s1'];
    await expect(handle.stop('absolute-ceiling')).resolves.toBeUndefined();
  });

  it('treats a container the daemon is removing as gone', async () => {
    const handle = await preparedHandle();
    cli.responses.unshift({ match: /^rm /, throws: new Error('Error response from daemon: conflict') });
    cli.ps = ['removing'];
    await expect(handle.stop('absolute-ceiling')).resolves.toBeUndefined();
  });

  it('waits for a still-listed container to disappear instead of failing at once', async () => {
    const handle = await preparedHandle();
    cli.responses.unshift({ match: /^rm /, throws: new Error('Error response from daemon: conflict') });
    cli.ps = ['exited', 'exited', ''];
    await expect(handle.stop('absolute-ceiling')).resolves.toBeUndefined();
    expect(cli.joined().filter((c) => c.startsWith('ps ')).length).toBe(3);
  });

  it('still fails when the container outlives the wait', async () => {
    const handle = await preparedHandle();
    cli.responses.unshift({ match: /^rm /, throws: new Error('Error response from daemon: conflict') });
    cli.ps = ['exited\n'];
    await expect(handle.stop('absolute-ceiling')).rejects.toMatchObject({ kind: 'unknown', retryable: false });
    // It polled for the whole window, sleeping between polls rather than blocking.
    expect(clock).toBeGreaterThanOrEqual(3_000);
    expect(sleeps.every((ms) => ms === 250)).toBe(true);
  });

  it('waits without blocking the event loop', async () => {
    Object.assign(removalWaitClock, realClock);
    const handle = await preparedHandle();
    cli.responses.unshift({ match: /^rm /, throws: new Error('Error response from daemon: conflict') });
    cli.ps = ['exited', ''];
    let ticked = false;
    setTimeout(() => (ticked = true), 0);
    await expect(handle.stop('absolute-ceiling')).resolves.toBeUndefined();
    // A timer due during the wait ran before the stop finished.
    expect(ticked).toBe(true);
  });

  it('still fails when the daemon cannot be queried', async () => {
    const handle = await preparedHandle();
    cli.responses.unshift({ match: /^(stop|rm) /, throws: new Error('Cannot connect to the Docker daemon') });
    cli.ps = [new Error('Cannot connect to the Docker daemon')];
    await expect(handle.stop('shutdown')).rejects.toMatchObject({ kind: 'runtime-unavailable' });
  });
});
