// The relay's laptop half is a reliable pipe to a daemon inside the container:
// frames carry sequence numbers, are acknowledged, and are replayed after a
// dropped pipe. Nothing listens on the developer's machine. These tests pin
// the protocol the extension speaks; the daemon itself runs only in a real
// container (see the harness).
import { describe, expect, it } from 'vitest';
import type { Cli } from './docker.js';
import { DAEMON_VERSION, RELAY_NO_DAEMON_EXIT, SessionRelay, __embeddedScripts } from './relay.js';

const key = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };

function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const written: string[] = [];
  const runs: string[][] = [];
  let emit: (line: string) => void = () => {};
  let finish: (code: number) => void = () => {};
  let started: string[] = [];
  const cli: Cli = {
    run: async (args) => {
      runs.push(args);
      return '';
    },
    start: (args, onLine) => {
      started = args;
      emit = (l) => onLine?.(l);
      return {
        done: new Promise<number | null>((r) => {
          finish = r;
        }),
        kill: () => {},
        write: (s) => written.push(s),
      };
    },
  };
  const relay = new SessionRelay(key, { send: (f) => sent.push(f), log: (l) => logs.push(l) });
  const exit = relay.attach(cli, 'ncl-spike-s1')!;
  const lines = () => written.map((w) => JSON.parse(w) as Record<string, unknown>);
  return {
    relay,
    cli,
    sent,
    logs,
    written,
    runs,
    lines,
    emit: (l: string) => emit(l),
    finish: (c: number) => finish(c),
    exit,
    args: () => started,
  };
}
const ready = (h: ReturnType<typeof harness>, inSeq = 0) =>
  h.emit(JSON.stringify({ t: 'ready', v: DAEMON_VERSION, port: 18080, seq: 0, inSeq }));

describe('SessionRelay (reliable pipe to the in-container daemon)', () => {
  it("attaches through an exec pipe, says hello with what it has seen, and is ready on the daemon's word", () => {
    const h = harness();
    expect(h.args().slice(0, 4)).toEqual(['exec', '-i', 'ncl-spike-s1', 'bun']);
    expect(h.lines()[0]).toEqual({ t: 'hello', ack: 0, seq: 0 });
    expect(h.relay.ready).toBe(false);
    ready(h);
    expect(h.relay.ready).toBe(true);
    expect(h.logs.some((l) => l.includes('relay attached inside the container'))).toBe(true);
  });

  it("turns the daemon's sequenced tunnel frames into central's frames, acknowledging each once", () => {
    const h = harness();
    ready(h);
    h.emit(JSON.stringify({ t: 'open', id: 's0', host: 'api.anthropic.com', port: 443, seq: 1 }));
    h.emit(JSON.stringify({ t: 'data', id: 's0', b64: 'aGVsbG8=', seq: 2 }));
    h.emit(JSON.stringify({ t: 'data', id: 's0', b64: 'aGVsbG8=', seq: 2 })); // a replayed duplicate
    h.emit(JSON.stringify({ t: 'close', id: 's0', seq: 3 }));
    expect(h.sent).toEqual([
      { type: 'relay.open', streamId: 's0', key, host: 'api.anthropic.com', port: 443 },
      { type: 'relay.data', streamId: 's0', b64: 'aGVsbG8=' },
      { type: 'relay.close', streamId: 's0' },
    ]);
    expect(
      h
        .lines()
        .filter((l) => l.t === 'ack')
        .map((l) => l.seq),
    ).toEqual([1, 2, 2, 3]); // duplicate is re-acked, not re-sent
  });

  it("sequences central's frames, holds them until acknowledged, and replays the unacknowledged after a re-attach", async () => {
    const h = harness();
    ready(h);
    expect(h.relay.handleFrame({ type: 'relay.opened', streamId: 's0' })).toBe(true);
    expect(h.relay.handleFrame({ type: 'relay.data', streamId: 's0', b64: 'aGk=' })).toBe(true);
    expect(
      h.relay.handleFrame({ type: 'relay.close', streamId: 's0', error: 'gateway refused the tunnel (HTTP 403)' }),
    ).toBe(true);
    expect(h.relay.handleFrame({ type: 'something.else' })).toBe(false);
    const out = h.lines().filter((l) => l.t !== 'hello');
    expect(out).toEqual([
      { t: 'opened', id: 's0', seq: 1 },
      { t: 'data', id: 's0', b64: 'aGk=', seq: 2 },
      { t: 'close', id: 's0', error: 'gateway refused the tunnel (HTTP 403)', seq: 3 },
    ]);
    expect(h.logs.some((l) => l.includes('HTTP 403'))).toBe(true);
    h.emit(JSON.stringify({ t: 'ack', seq: 1 }));
    expect(h.relay.pendingCount).toBe(2);

    // The pipe drops. Frames 2 and 3 were never acknowledged.
    h.finish(125);
    expect(await h.exit).toBe(125);
    expect(h.relay.ready).toBe(false);
    expect(h.logs.some((l) => l.includes('2 frame(s) held for replay'))).toBe(true);

    // Re-attach: hello carries what we saw; the daemon says it processed up to
    // our seq 2 already, so only seq 3 is replayed.
    h.written.length = 0;
    h.relay.attach(h.cli, 'ncl-spike-s1');
    expect(h.lines()[0]).toEqual({ t: 'hello', ack: 0, seq: 3 }); // what we saw, and how far our own counter got
    ready(h, 2);
    const replayed = h.lines().filter((l) => l.t !== 'hello');
    expect(replayed).toEqual([{ t: 'close', id: 's0', error: 'gateway refused the tunnel (HTTP 403)', seq: 3 }]);
    expect(h.relay.pendingCount).toBe(1);
    expect(h.logs.some((l) => l.includes('(replayed 1)'))).toBe(true);
  });

  it('a frame from central while detached is held, not lost, and goes out once attached', () => {
    const h = harness();
    // not ready yet
    h.relay.handleFrame({ type: 'relay.data', streamId: 's1', b64: 'eA==' });
    expect(h.lines().filter((l) => l.t === 'data')).toEqual([]);
    ready(h);
    expect(h.lines().filter((l) => l.t === 'data')).toEqual([{ t: 'data', id: 's1', b64: 'eA==', seq: 1 }]);
  });

  it('reports a missing daemon by exit code and keeps non-frame output so an exit explains itself', async () => {
    const h = harness();
    h.emit(JSON.stringify({ t: 'no-daemon', why: 'ENOENT' }));
    h.finish(RELAY_NO_DAEMON_EXIT);
    expect(await h.exit).toBe(RELAY_NO_DAEMON_EXIT);
    expect(h.logs.some((l) => l.includes('relay pipe'))).toBe(false); // expected, not noise-worthy
    await h.relay.startDaemon(h.cli, 'ncl-spike-s1');
    expect(h.runs[0].slice(0, 5)).toEqual(['exec', '-d', 'ncl-spike-s1', 'bun', '-e']);

    const h2 = harness();
    h2.emit('Error: container is not running');
    expect(h2.sent).toEqual([]);
    h2.finish(125);
    expect(await h2.exit).toBe(125);
    expect(h2.logs.some((l) => l.includes('ended (125): Error: container is not running'))).toBe(true);
    expect(h2.relay.attach(h2.cli, 'ncl-spike-s1')).not.toBeNull();
  });

  it('a replaced daemon (counter behind ours) resets the channel instead of being mistaken for a replay', async () => {
    const h = harness();
    ready(h);
    h.emit(JSON.stringify({ t: 'open', id: 's0', host: 'h', port: 443, seq: 7 }));
    h.relay.handleFrame({ type: 'relay.opened', streamId: 's0' }); // pending seq 1
    h.finish(125);
    await h.exit;
    h.written.length = 0;
    h.sent.length = 0;
    h.relay.attach(h.cli, 'ncl-spike-s1');
    h.emit(JSON.stringify({ t: 'ready', v: DAEMON_VERSION, port: 18080, seq: 0, inSeq: 0 })); // fresh daemon
    expect(h.logs.some((l) => l.includes('daemon was replaced'))).toBe(true);
    expect(h.relay.pendingCount).toBe(0); // the old tunnel's frames are not replayed at a daemon that never knew it
    h.emit(JSON.stringify({ t: 'open', id: 's0', host: 'h2', port: 443, seq: 1 })); // would have been "duplicate" of seq 7 before
    expect(h.sent).toEqual([{ type: 'relay.open', streamId: 's0', key, host: 'h2', port: 443 }]);
  });

  it('a reconnected central link makes the relay reset the daemon’s tunnels (now if ready, else right after ready) and drop held frames', () => {
    const h = harness();
    h.relay.handleFrame({ type: 'relay.data', streamId: 's9', b64: 'eA==' }); // held: not ready
    h.relay.linkReconnected();
    expect(h.relay.pendingCount).toBe(0); // frames for streams central just closed are not worth keeping
    expect(h.lines().some((l) => l.t === 'reset-all')).toBe(false); // not attached yet
    ready(h);
    const seqs = h.lines().filter((l) => l.t === 'reset-all');
    expect(seqs).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('resetting the container'))).toBe(true);
    // Already ready: goes out immediately, once per reconnect.
    h.relay.linkReconnected();
    expect(h.lines().filter((l) => l.t === 'reset-all')).toHaveLength(2);
  });

  it('the embedded daemon and attach scripts parse as JavaScript', () => {
    // A newline escape rendered literally, or an unbalanced brace, would only
    // surface as "relay never ready" on a laptop. Compile both here.
    for (const [name, src] of Object.entries(__embeddedScripts)) {
      expect(() => new Function(src), name).not.toThrow(); // a literal newline inside a string is a syntax error here
    }
  });

  it('a daemon of another version is evicted on attach instead of being served, so the loop starts the right one', async () => {
    const h = harness();
    h.emit(JSON.stringify({ t: 'ready', v: 1, port: 18080, seq: 40, inSeq: 3 }));
    expect(h.relay.ready).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    const kill = h.runs.find((r) => r[0] === 'exec' && r[2] === 'sh');
    expect(kill).toBeDefined();
    expect(kill![4]).toContain('nanoclaw relay tunnels CONNECT only');
    expect(h.logs.some((l) => l.includes('version 1') && l.includes('replacing'))).toBe(true);
  });
});
