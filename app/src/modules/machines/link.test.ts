/**
 * The worker link: the wire format over a real socket pair,
 * the worker's fixed jobs, and the link end to end over real mutual TLS —
 * a joined worker links, central asks it things, a revoke cuts it off.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net, { type AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import type { Duplex } from 'stream';
import type { TLSSocket } from 'tls';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb, initTestDb } from '../../db/connection.js';
import { moduleWebchatMachineMembers } from '../../channels/webchat/migration.js';
import { caPaths, ensureCa, issueMachineCert, publicKeyPin } from './ca.js';
import { __resetLinksForTest, callWorker, dropLink, isLinked } from './links.js';
import { machineHandler, upgradeLink } from './listener.js';
import { addMember, createJoinToken, getMember, revokeMember } from './members.js';
import { Mux, STREAM_WINDOW } from './mux.js';
import {
  __setIsolationForTest,
  connect,
  health,
  probeArgs,
  readProbe,
  refuseDocker,
  refuseWhileUnisolated,
  serve,
  tcpAllowed,
  workloadAddress,
} from './worker-main.js';

const until = async (ok: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Two ends of a real TCP connection. */
async function socketPair(): Promise<[net.Socket, net.Socket]> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const accepted = new Promise<net.Socket>((r) => srv.once('connection', r));
  const a = net.connect((srv.address() as AddressInfo).port, '127.0.0.1');
  const b = await accepted;
  srv.close();
  await new Promise((r) => a.once('connect', r));
  return [a, b];
}

describe('the link wire format', () => {
  it('carries requests, error replies and timeouts', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    const worker = new Mux(b, 'worker');
    worker.handle('add', (m) => Number(m.x) + Number(m.y));
    worker.handle('boom', () => {
      throw new Error('no thanks');
    });
    worker.handle('slow', () => new Promise(() => undefined));
    expect(await central.request('add', { x: 2, y: 3 })).toBe(5);
    await expect(central.request('boom')).rejects.toThrow(/no thanks/);
    await expect(central.request('nope')).rejects.toThrow(/unknown op/);
    await expect(central.request('slow', {}, 50)).rejects.toThrow(/no answer/);
    central.close();
    await until(() => worker.closed);
  });

  it('tunnels byte streams both ways, large ones in pieces', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    const worker = new Mux(b, 'worker');
    worker.onStream((meta, s) => {
      expect(meta).toEqual({ kind: 'echo' });
      s.pipe(s);
    });
    const s = central.open({ kind: 'echo' });
    const big = Buffer.alloc(300 * 1024, 7);
    const got: Buffer[] = [];
    s.on('data', (c: Buffer) => got.push(c));
    s.end(big);
    await new Promise((r) => s.once('end', r));
    expect(Buffer.concat(got).equals(big)).toBe(true);
    central.close();
  });

  it('holds a fast writer to the window while the reader is paused, then delivers everything', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    const worker = new Mux(b, 'worker');
    let inbound: Duplex | null = null;
    worker.onStream((_m, s) => {
      inbound = s;
      s.pause();
    });
    const out = central.open({ kind: 'bulk' });
    const total = 6 * STREAM_WINDOW;
    let written = 0;
    const piece = Buffer.alloc(256 * 1024, 1);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < total / piece.length; i++)
      writes.push(new Promise((r) => out.write(piece, () => ((written += piece.length), r()))));
    await new Promise((r) => setTimeout(r, 300));
    // Paused reader: no more than the window (plus one piece being queued) is let through.
    expect(written).toBeLessThanOrEqual(STREAM_WINDOW + piece.length);
    let got = 0;
    inbound!.on('data', (c: Buffer) => (got += c.length));
    inbound!.resume();
    await Promise.all(writes);
    await until(() => got === total);
    expect(written).toBe(total);
    central.close();
  });

  it('fails pending requests and streams when the link closes', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    const worker = new Mux(b, 'worker');
    worker.handle('slow', () => new Promise(() => undefined));
    worker.onStream(() => undefined);
    const pending = central.request('slow');
    const s = central.open({ kind: 'x' });
    const errored = new Promise((r) => s.once('error', r));
    b.destroy();
    await expect(pending).rejects.toThrow();
    await errored;
  });

  it('refuses streams when nothing accepts them', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    new Mux(b, 'worker');
    const s = central.open({ kind: 'tcp' });
    await expect(new Promise((_r, j) => s.once('error', j))).rejects.toThrow(/not accepted/);
    central.close();
  });
});

describe('a workload reached over the link', () => {
  it('carries an HTTP request and its answer, as the /apps/ proxy sends it', async () => {
    const app = http.createServer((req, res) => res.end(`app saw ${req.method} ${req.url} host=${req.headers.host}`));
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const appPort = (app.address() as AddressInfo).port;
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    const worker = new Mux(b, 'worker');
    // Stand-in for the worker's tcp job (worker-main serve): here it reaches a local app.
    worker.onStream((meta, s) => {
      expect(meta).toEqual({ kind: 'tcp', host: '198.18.1.10', port: 80 });
      const up = net.connect(appPort, '127.0.0.1');
      s.pipe(up);
      up.pipe(s);
    });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '198.18.1.10',
          port: 80,
          path: '/hello?x=1',
          headers: { host: 'demo.apps.internal' },
          timeout: 5000,
          createConnection: () => central.open({ kind: 'tcp', host: '198.18.1.10', port: 80 }) as never,
        },
        (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve(t));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('app saw GET /hello?x=1 host=demo.apps.internal');
    central.close();
    app.close();
  });

  it('the worker refuses volume streams for volumes outside the project, and unknown file jobs', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    serve(new Mux(b, 'worker'));
    const bad = [
      { kind: 'vol-out', project: 'nc-x-y-demo', volume: 'other_data', image: 'alpine:3.21' },
      { kind: 'vol-in', project: 'evil', volume: 'evil_data', image: 'alpine:3.21' },
      { kind: 'vol-out', project: 'nc-x-y-demo', volume: 'nc-x-y-demo_data', image: 'Bad Image' },
    ];
    for (const meta of bad) {
      const s = central.open(meta);
      await expect(new Promise((_r, j) => s.once('error', j))).rejects.toThrow(/refused/);
    }
    central.close();
  });
});

describe("the worker's fixed jobs", () => {
  it('allows only NanoClaw Compose projects, its networks and images', () => {
    const ok = [
      ['compose', '-p', 'nc-2e60-abc-demo', '-f', 'stack.yml', '-f', 'override.yml', 'up', '-d', '--pull', 'never'],
      ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', '-f', 'override.yml', 'exec', '-T', 'web', 'ls'],
      ['network', 'create', '--internal', '--subnet', '198.18.1.0/24', 'nc-wl-2e60-1'],
      ['network', 'inspect', 'bridge'],
      ['network', 'ls', '--format', '{{.Name}}'],
      ['image', 'inspect', 'nginx'],
      ['image', 'prune', '-f', '--filter', 'label=x'],
      ['version'],
    ];
    for (const a of ok) expect(refuseDocker(a)).toBeNull();
    const bad: unknown[] = [
      ['run', '--privileged', 'alpine'],
      ['exec', 'x', 'sh'],
      ['compose', '-p', 'evil', '-f', 'stack.yml', 'up'],
      ['compose', '-p', 'nc-x', '-f', 'stack.yml', 'up', '-d'],
      ['compose', '-p', 'nc-x', '-f', 'stack.yml', 'pull'],
      ['compose', '-p', 'nc-x', '-f', '/etc/passwd', 'up'],
      ['compose', '-p', 'nc-x', '-f', 'stack.yml', 'build'],
      ['compose', '-p', 'nc-x', '--project-directory', '/', 'up'],
      ['network', 'create', 'host-net'],
      ['image', 'rm', 'nginx'],
      ['cp', 'a', 'b'],
      [1, 2],
      'compose up',
    ];
    for (const a of bad) expect(refuseDocker(a)).not.toBeNull();
  });

  it('tunnels only to workload addresses', () => {
    expect(workloadAddress('198.18.1.10')).toBe(true);
    expect(workloadAddress('198.19.44.5')).toBe(true);
    for (const h of ['127.0.0.1', '10.0.0.1', '198.20.0.1', '169.254.169.254', 'localhost', 42])
      expect(workloadAddress(h)).toBe(false);
  });

  it("tunnels only to a workload service's own address: never the gateway .1, nothing not running here", () => {
    const held = new Set(['198.18.1.10', '198.18.1.11']);
    expect(tcpAllowed('198.18.1.10', 80, held)).toBe(true);
    expect(tcpAllowed('198.18.1.11', 5432, held)).toBe(true);
    for (const [h, p] of [
      ['198.18.1.1', 22], // the gateway: this machine itself
      ['198.18.1.1', 80],
      ['198.18.1.12', 80], // in the range, but no service of ours holds it
      ['198.18.1.200', 80], // a dynamic joiner's range
      ['198.18.1.10', 0],
      ['198.18.1.10', 70000],
      ['10.0.0.1', 80],
    ] as const)
      expect(tcpAllowed(h, p, new Set([...held, '198.18.1.1', '198.18.1.200']))).toBe(false);
  });

  it('the tcp job refuses the gateway even when asked over the link', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    serve(new Mux(b, 'worker'));
    const s = central.open({ kind: 'tcp', host: '198.18.1.1', port: 22 });
    await expect(new Promise((_r, j) => s.once('error', j))).rejects.toThrow(/refused/);
    central.close();
  });

  it('refuses compose up/start/restart until the isolation check passes; the rest still runs', () => {
    const up = ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', '-f', 'override.yml', 'up', '-d', '--pull', 'never'];
    const start = ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', 'start'];
    const restart = ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', 'restart'];
    expect(refuseWhileUnisolated(up, 'open')).toMatch(/host rules/);
    expect(refuseWhileUnisolated(up, 'unknown')).toMatch(/has not passed/);
    expect(refuseWhileUnisolated(start, 'open')).not.toBeNull();
    expect(refuseWhileUnisolated(restart, 'unknown')).not.toBeNull();
    expect(refuseWhileUnisolated(up, 'ok')).toBeNull();
    for (const args of [
      ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', 'stop'],
      ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', 'down', '--remove-orphans'],
      ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', 'ps', '--all'],
      ['network', 'ls'],
    ])
      expect(refuseWhileUnisolated(args, 'open')).toBeNull();
  });

  it('the docker job itself refuses compose up while the check has not passed', async () => {
    const [a, b] = await socketPair();
    const central = new Mux(a, 'central');
    serve(new Mux(b, 'worker'));
    const args = ['compose', '-p', 'nc-x-y', '-f', 'stack.yml', '-f', 'override.yml', 'up', '-d', '--pull', 'never'];
    __setIsolationForTest('open');
    await expect(central.request('docker', { args }, 5000)).rejects.toThrow(/refused: workloads are stopped/);
    __setIsolationForTest('unknown');
    await expect(central.request('docker', { args }, 5000)).rejects.toThrow(/refused: the workload isolation check/);
    central.close();
  });

  it('reads the probe container: the token back means open, a failed request means blocked', () => {
    expect(readProbe('abc123 rc=0\n', 'abc123')).toBe('open');
    expect(readProbe(' rc=1\n', 'abc123')).toBe('blocked');
    expect(readProbe(' rc=4\n', 'abc123')).toBe('blocked');
    expect(readProbe('docker: no such image\n', 'abc123')).toBeNull();
    const args = probeArgs('nc-worker-probe', 'busybox:1', 'http://198.19.255.1:4242/');
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--pull', 'never']);
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--network', 'nc-worker-probe']));
    expect(args.at(-1)).toContain('http://198.19.255.1:4242/');
  });

  it("reports health as the report script does, NanoClaw's slices apart", () => {
    const files: Record<string, string> = {
      '/proc/meminfo': 'MemTotal:       16384000 kB\nMemAvailable:    6144000 kB\n',
      '/proc/stat': 'cpu  100 0 100 800 0 0 0 0 0 0\n',
    };
    const h = health((p) => {
      if (p in files) return files[p];
      throw new Error('no such file');
    });
    expect(h.memTotalMb).toBe(16000);
    expect(h.memUsedMb).toBe(10000);
    expect(h.memNanoclawMb).toBe(0);
    expect(h.agentVersion).toBe('5');
    __setIsolationForTest('ok', Date.now() - 90_000);
    const h2 = health((p) => {
      if (p in files) return files[p];
      throw new Error('no such file');
    });
    expect(h2.isolation).toBe('ok');
    expect(h2.isolationAgeMs).toBeGreaterThanOrEqual(90_000);
    expect(h2.isolationAgeMs).toBeLessThan(100_000);
  });
});

describe('the link end to end (mutual TLS)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-link-'));
  const paths = caPaths(path.join(tmp, 'ca'));
  let server: https.Server;
  let port = 0;
  let pin = '';
  const openssl = (args: string[]): string => execFileSync('openssl', args, { encoding: 'utf8' });

  async function joinWorker(): Promise<{ id: string; key: string; cert: string }> {
    const keyFile = path.join(tmp, `${Math.random().toString(36).slice(2)}.key`);
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile]);
    const csr = openssl(['req', '-new', '-key', keyFile, '-subj', '/CN=nanoclaw-machine']);
    const { token } = await createJoinToken('worker', 'webchat:owner');
    const cert = issueMachineCert(csr, paths);
    const m = await addMember(token, 'worker', { cpus: 2, memTotalMb: 4096 }, cert);
    return { id: m.id, key: fs.readFileSync(keyFile, 'utf8'), cert: cert.cert };
  }

  beforeAll(async () => {
    ensureCa(paths, ['127.0.0.1']);
    pin = publicKeyPin(fs.readFileSync(paths.serverCert, 'utf8'));
    const handler = machineHandler({ port: 0, bind: '127.0.0.1', address: '127.0.0.1' }, paths);
    server = https.createServer(
      {
        key: fs.readFileSync(paths.serverKey),
        cert: fs.readFileSync(paths.serverCert),
        ca: fs.readFileSync(paths.caCert),
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => void handler(req, res),
    );
    server.on('upgrade', (req, socket) => void upgradeLink(req, socket as TLSSocket));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await initTestDb();
    await moduleWebchatMachineMembers.up(getDb() as never);
    await getDb().exec('DELETE FROM machine_members; DELETE FROM machine_join_tokens;');
  });
  afterEach(() => __resetLinksForTest());

  it('links a joined worker; central asks, the worker answers; health is recorded', async () => {
    const w = await joinWorker();
    const mux = await connect({ host: '127.0.0.1', port, pin, key: w.key, cert: w.cert });
    mux.handle('echo', (m) => m.x);
    await until(() => isLinked(w.id));
    expect(await callWorker(w.id, 'echo', { x: 'hello' })).toBe('hello');
    mux.send({
      t: 'health',
      data: {
        cpus: 2,
        memTotalMb: 4096,
        memUsedMb: 1000,
        memNanoclawMb: 0,
        cpuUsed: 0.5,
        cpuNanoclaw: 0,
        diskTotalGb: 30,
        diskFreeGb: 10,
      },
    });
    await until(async () => (await getMember(w.id))?.lastReport != null);
    expect((await getMember(w.id))?.health?.memUsedMb).toBe(1000);
    mux.close();
    await until(() => !isLinked(w.id));
  });

  it('serves the worker installer to a joined machine only', async () => {
    const w = await joinWorker();
    const get = (client?: { key: string; cert: string }) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = https.request(
          { host: '127.0.0.1', port, path: '/worker/install.sh', rejectUnauthorized: false, ...(client ?? {}) },
          (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect((await get()).status).toBe(403);
    const ok = await get({ key: w.key, cert: w.cert });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('NanoClaw worker service installer');
  });

  it("refuses a connection that does not pin central's key", async () => {
    const w = await joinWorker();
    await expect(connect({ host: '127.0.0.1', port, pin: 'AAAA', key: w.key, cert: w.cert })).rejects.toThrow(/pin/);
  });

  it('refuses a machine without a certificate of ours', async () => {
    const keyFile = path.join(tmp, 'stranger.key');
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile]);
    const self = openssl(['req', '-new', '-x509', '-key', keyFile, '-subj', '/CN=x', '-days', '1']);
    await expect(
      connect({ host: '127.0.0.1', port, pin, key: fs.readFileSync(keyFile, 'utf8'), cert: self }),
    ).rejects.toThrow(/refused the link: HTTP\/1.1 403/);
  });

  it('cuts the link at once on revoke, and refuses the revoked machine afterwards', async () => {
    const w = await joinWorker();
    const mux = await connect({ host: '127.0.0.1', port, pin, key: w.key, cert: w.cert });
    await until(() => isLinked(w.id));
    await revokeMember(w.id);
    dropLink(w.id);
    await until(() => mux.closed);
    await expect(callWorker(w.id, 'echo')).rejects.toThrow(/not connected/);
    await expect(connect({ host: '127.0.0.1', port, pin, key: w.key, cert: w.cert })).rejects.toThrow(/403/);
  });
});
