import { execFile, execFileSync, spawnSync } from 'child_process';
import http from 'http';
import net, { type AddressInfo } from 'net';
import type { Duplex } from 'stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACH_SCRIPT,
  ContainerRelay,
  NO_DAEMON_EXIT,
  __resetExecRelayForTest,
  daemonScript,
  registerRelayedContainer,
  relayReady,
  type RelayRuntime,
} from './exec-relay.js';

/** Plays the daemon's side of the pipe: what it would send, and what it received. */
class FakeRuntime implements RelayRuntime {
  daemons = 0;
  daemonUp = false;
  received: Array<Record<string, unknown>> = [];
  /** While set, the pipe reports itself backed up. */
  blocked = false;
  /** The last sequence number this daemon sent, as its ready frame reports it. */
  seq = 0;
  #drain: (() => void) | null = null;
  #toRelay: ((line: string) => void) | null = null;
  #end: ((code: number | null) => void) | null = null;

  async startDaemon(): Promise<void> {
    this.daemons++;
    this.daemonUp = true;
  }
  attach(_c: string, onLine: (line: string) => void) {
    let end!: (code: number | null) => void;
    const done = new Promise<number | null>((r) => (end = r));
    this.#end = end;
    if (!this.daemonUp) {
      setTimeout(() => end(NO_DAEMON_EXIT), 0);
    } else {
      this.#toRelay = onLine;
    }
    return {
      write: (line: string) => {
        for (const l of line.split('\n').filter(Boolean)) {
          const f = JSON.parse(l) as Record<string, unknown>;
          this.received.push(f);
          if (f.t === 'hello')
            setTimeout(() => onLine(JSON.stringify({ t: 'ready', v: 1, seq: this.seq, inSeq: 0 })), 0);
        }
        return !this.blocked;
      },
      onDrain: (cb: () => void) => (this.#drain = cb),
      kill: () => end(null),
      done,
    };
  }
  daemonSays(f: Record<string, unknown>): void {
    if (f.t !== 'ack' && typeof f.seq === 'number') this.seq = Math.max(this.seq, f.seq);
    this.#toRelay?.(JSON.stringify(f));
  }
  dropPipe(): void {
    this.#end?.(0);
  }
  drain(): void {
    this.blocked = false;
    this.#drain?.();
  }
  /** Acknowledge every sequenced frame the relay has sent so far. */
  ackAll(): void {
    for (const f of this.received)
      if (f.t !== 'hello' && f.t !== 'ack' && typeof f.seq === 'number') this.daemonSays({ t: 'ack', seq: f.seq });
  }
  dataFrames(id: string): Array<Record<string, unknown>> {
    return this.received.filter((f) => f.t === 'data' && f.id === id);
  }
}

const SMALL = { highWaterBytes: 2_000, lowWaterBytes: 500, maxBufferBytes: 20_000 };

/** A relay with one open stream on the fake, and the route's end of it. */
async function openRelay(rt: FakeRuntime, limits = SMALL): Promise<{ relay: ContainerRelay; stream: Duplex }> {
  rt.daemonUp = true;
  const routed: Duplex[] = [];
  const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (_p, s) => routed.push(s) }, rt, limits);
  void relay.run();
  await tick();
  rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
  await tick();
  return { relay, stream: routed[0] };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => __resetExecRelayForTest());

describe('ContainerRelay', () => {
  it('starts the daemon when there is none, then carries a stream both ways to the route', async () => {
    const rt = new FakeRuntime();
    const routed: Array<{ port: number; stream: Duplex }> = [];
    const relay = new ContainerRelay(
      'ncl-x',
      { ports: [10255], route: (port, stream) => routed.push({ port, stream }) },
      rt,
    );
    void relay.run();
    await new Promise((r) => setTimeout(r, 400));
    expect(rt.daemons).toBe(1);
    expect(relay.ready).toBe(true);

    rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
    rt.daemonSays({ t: 'data', id: 's0', b64: Buffer.from('CONNECT a:443').toString('base64'), seq: 2 });
    await tick();
    expect(routed).toHaveLength(1);
    expect(routed[0].port).toBe(10255);
    const got: Buffer[] = [];
    routed[0].stream.on('data', (d: Buffer) => got.push(d));
    await tick();
    expect(Buffer.concat(got).toString()).toBe('CONNECT a:443');
    // Every daemon frame is acknowledged.
    expect(rt.received.filter((f) => f.t === 'ack').map((f) => f.seq)).toEqual([1, 2]);

    // The route answers: the bytes go back as a data frame for that stream.
    routed[0].stream.write('HTTP/1.1 200 OK\r\n\r\n');
    await tick();
    const back = rt.received.find((f) => f.t === 'data');
    expect(back?.id).toBe('s0');
    expect(Buffer.from(String(back?.b64), 'base64').toString()).toBe('HTTP/1.1 200 OK\r\n\r\n');

    // The agent closes: the route's end sees it.
    let ended = false;
    routed[0].stream.on('end', () => (ended = true));
    rt.daemonSays({ t: 'close', id: 's0', seq: 3 });
    await tick();
    expect(ended).toBe(true);
    expect(relay.streamCount).toBe(0);
    relay.close();
  });

  it('refuses a port it was not told about, and ignores a replayed frame', async () => {
    const rt = new FakeRuntime();
    rt.daemonUp = true;
    const routed: number[] = [];
    const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (port) => routed.push(port) }, rt);
    void relay.run();
    await tick();
    rt.daemonSays({ t: 'open', id: 's0', port: 22, seq: 1 });
    rt.daemonSays({ t: 'open', id: 's1', port: 10255, seq: 2 });
    rt.daemonSays({ t: 'open', id: 's1', port: 10255, seq: 2 }); // a replay after a re-attach
    await tick();
    expect(routed).toEqual([10255]);
    // The refused stream is closed back to the daemon.
    expect(rt.received.some((f) => f.t === 'close' && f.id === 's0')).toBe(true);
    relay.close();
  });

  it("closes the agent's connection when whoever serves the port destroys its end", async () => {
    const rt = new FakeRuntime();
    rt.daemonUp = true;
    const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (_p, s) => s.destroy() }, rt);
    void relay.run();
    await tick();
    rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
    await tick();
    expect(rt.received.some((f) => f.t === 'close' && f.id === 's0')).toBe(true);
    expect(relay.streamCount).toBe(0);
    relay.close();
  });

  it('re-attaches when the pipe drops, and replays what the daemon had not acknowledged', async () => {
    const rt = new FakeRuntime();
    rt.daemonUp = true;
    const routed: Duplex[] = [];
    const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (_p, s) => routed.push(s) }, rt);
    void relay.run();
    await tick();
    rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
    await tick();
    rt.dropPipe();
    routed[0].write('while detached'); // held for replay
    await new Promise((r) => setTimeout(r, 400));
    expect(relay.ready).toBe(true);
    const hellos = rt.received.filter((f) => f.t === 'hello');
    expect(hellos.length).toBe(2);
    expect(hellos[1].ack).toBe(1); // tells the new pipe what it already saw
    const replayed = rt.received.filter((f) => f.t === 'data' && f.id === 's0');
    expect(Buffer.from(String(replayed.at(-1)?.b64), 'base64').toString()).toBe('while detached');
    relay.close();
  });
});

describe('ContainerRelay backpressure', () => {
  it('pauses the streams past the high-water mark and resumes them once acks bring it under the low one', async () => {
    const rt = new FakeRuntime();
    const { relay, stream } = await openRelay(rt);
    for (let i = 0; i < 10; i++) stream.write(Buffer.alloc(600, 65 + i));
    await tick();
    expect(relay.paused).toBe(true);
    // One frame of overshoot at most; the rest waits in the stream.
    expect(relay.pendingBytes).toBeLessThan(SMALL.highWaterBytes + 1_000);
    const sent = rt.dataFrames('s0').length;
    expect(sent).toBeLessThan(10);
    await tick();
    expect(rt.dataFrames('s0').length).toBe(sent);

    // Each round of acks lets more through, until everything has gone.
    for (let i = 0; i < 10 && rt.dataFrames('s0').length < 10; i++) {
      rt.ackAll();
      await tick();
    }
    expect(rt.dataFrames('s0').length).toBe(10);
    rt.ackAll();
    await tick();
    expect(relay.pendingBytes).toBe(0);
    expect(relay.paused).toBe(false);
    relay.close();
  });

  it('holds the streams while the pipe is backed up, until it drains', async () => {
    const rt = new FakeRuntime();
    const { relay, stream } = await openRelay(rt);
    rt.blocked = true;
    stream.write('first');
    await tick();
    expect(relay.paused).toBe(true);
    stream.write('second');
    await tick();
    expect(rt.dataFrames('s0').map((f) => Buffer.from(String(f.b64), 'base64').toString())).toEqual(['first']);

    rt.drain();
    await tick();
    expect(relay.paused).toBe(false);
    expect(rt.dataFrames('s0').map((f) => Buffer.from(String(f.b64), 'base64').toString())).toEqual([
      'first',
      'second',
    ]);
    relay.close();
  });

  it('resets the tunnels rather than queue past the hard cap', async () => {
    const rt = new FakeRuntime();
    const { relay, stream } = await openRelay(rt);
    let closed = false;
    stream.on('close', () => (closed = true));
    stream.write(Buffer.alloc(SMALL.maxBufferBytes, 66));
    await tick();
    expect(closed).toBe(true);
    expect(relay.streamCount).toBe(0);
    // Only the close frame telling the daemon is left in the queue.
    expect(relay.pendingBytes).toBeLessThan(100);
    expect(rt.received.at(-1)).toMatchObject({ t: 'close', id: 's0' });
    expect(relay.paused).toBe(false);
    relay.close();
  });

  it('replays in order across a re-attach while held, then resumes once the replay is acknowledged', async () => {
    const rt = new FakeRuntime();
    const { relay, stream } = await openRelay(rt);
    const chunks = Array.from({ length: 8 }, (_, i) => Buffer.alloc(700, 97 + i));
    for (const c of chunks) stream.write(c);
    await tick();
    expect(relay.paused).toBe(true);
    const before = rt.dataFrames('s0').length;

    rt.dropPipe();
    await new Promise((r) => setTimeout(r, 400));
    expect(relay.ready).toBe(true);
    // Everything unacknowledged went again, in order, and the streams stay held.
    const hello = rt.received.map((f) => f.t).lastIndexOf('hello');
    const replay = rt.received.slice(hello).filter((f) => f.t === 'data');
    expect(replay.length).toBe(before);
    const seqs = replay.map((f) => Number(f.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(relay.paused).toBe(true);

    for (let i = 0; i < 10 && relay.pendingBytes > 0; i++) {
      rt.ackAll();
      await tick();
    }
    expect(relay.paused).toBe(false);
    const bySeq = new Map(rt.dataFrames('s0').map((f) => [Number(f.seq), String(f.b64)]));
    const all = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, b64]) => Buffer.from(b64, 'base64'));
    expect(Buffer.concat(all).equals(Buffer.concat(chunks))).toBe(true);
    relay.close();
  });
});

describe('the container ticker', () => {
  it('skips a container whose probe is still out, without holding back the others', async () => {
    vi.useFakeTimers();
    try {
      const calls: Record<string, number> = {};
      let releaseSlow!: () => void;
      __resetExecRelayForTest((name) => {
        calls[name] = (calls[name] ?? 0) + 1;
        if (name === 'slow' && calls[name] === 1) return new Promise((r) => (releaseSlow = () => r('other')));
        return Promise.resolve('other');
      });
      const route = () => {};
      registerRelayedContainer('slow', { ports: [1], route });
      registerRelayedContainer('fast', { ports: [1], route });
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.slow).toBe(1);
      expect(calls.fast).toBe(5);
      releaseSlow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.slow).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the embedded scripts', () => {
  it('parse', () => {
    expect(() => new Function(daemonScript([10255, 3001]))).not.toThrow();
    expect(() => new Function(ATTACH_SCRIPT)).not.toThrow();
  });
});

/**
 * End to end on a real engine, opt-in (RUN_DOCKER_TESTS=1 and an agent image in
 * NANOCLAW_TEST_AGENT_IMAGE): a container with no network reaches a server on
 * this machine only through the relay.
 */
const image = process.env.NANOCLAW_TEST_AGENT_IMAGE ?? '';
const docker = process.env.RUN_DOCKER_TESTS === '1' && image !== '';
describe.skipIf(!docker)('on a real engine', () => {
  const name = `ncl-exec-relay-test-${process.pid}`;
  afterEach(() => {
    spawnSync('docker', ['rm', '-f', name]);
  });

  it("a --network none container's request to host.docker.internal arrives through the pipe", async () => {
    const server = http.createServer((req, res) => res.end(`hello from the host: ${req.url}`));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const hostPort = (server.address() as AddressInfo).port;
    const containerPort = 18181;
    try {
      execFileSync('docker', [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '--network',
        'none',
        '--add-host=host.docker.internal:127.0.0.1',
        '--entrypoint',
        'sleep',
        image,
        'infinity',
      ]);
      registerRelayedContainer(name, {
        ports: [containerPort],
        route: (_port, stream) => {
          const up = net.connect({ host: '127.0.0.1', port: hostPort });
          stream.pipe(up);
          up.pipe(stream);
          up.on('error', () => stream.destroy());
        },
      });
      for (let i = 0; i < 100 && !relayReady(name); i++) await new Promise((r) => setTimeout(r, 200));
      expect(relayReady(name)).toBe(true);
      // Asynchronously: the relay runs on this event loop, which a synchronous exec would freeze.
      const inContainer = (script: string): Promise<{ ok: boolean; out: string }> =>
        new Promise((resolve) =>
          execFile('docker', ['exec', name, 'bun', '-e', script], { timeout: 20_000 }, (err, out) =>
            resolve({ ok: !err, out: String(out) }),
          ),
        );
      const viaRelay = await inContainer(
        `const r = await fetch('http://host.docker.internal:${containerPort}/via-relay'); console.log(await r.text());`,
      );
      expect(viaRelay.out.trim()).toBe('hello from the host: /via-relay');
      // And the container has no other way out.
      const direct = await inContainer("await fetch('http://1.1.1.1', {signal: AbortSignal.timeout(3000)})");
      expect(direct.ok).toBe(false);
    } finally {
      server.close();
    }
  }, 60_000);
});
