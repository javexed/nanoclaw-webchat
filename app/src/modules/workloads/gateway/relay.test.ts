/**
 * Apps of stacks on workers: Caddy dials a loopback relay, whose connections
 * go over the worker's link to the workload's address there.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const linked = new Set<string>();
const opened: string[] = [];
let appPort = 0;

vi.mock('../../machines/links.js', () => ({
  isLinked: (id: string) => linked.has(id),
  // Stand-in for the link: a TCP connection to a local "app".
  openWorkerTcp: (node: string, host: string, port: number) => {
    opened.push(`${node} ${host}:${port}`);
    return net.connect(appPort, '127.0.0.1');
  },
}));

const { __resetRelaysForTest, __setRelayDirForTest, isRelayTarget, keepRelays, relayFile, relayFor } =
  await import('./relay.js');
const { validSite } = await import('./caddy.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-relay-'));
beforeAll(() => __setRelayDirForTest(dir));
afterAll(() => {
  __setRelayDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  __resetRelaysForTest();
  linked.clear();
  opened.length = 0;
});

describe('the gateway relay to a stack on a worker', () => {
  it('is only made for a linked worker', async () => {
    expect(await relayFor('m-0000aaaa', '198.18.1.10:80')).toBeNull();
  });

  it('carries a connection over the link, and is a valid site target only while open', async () => {
    const app = net.createServer((s) => s.once('data', (d) => s.end(`app:${d.toString()}`)));
    appPort = await new Promise<number>((r) =>
      app.listen(0, '127.0.0.1', () => r((app.address() as net.AddressInfo).port)),
    );
    linked.add('m-0000aaaa');
    const target = (await relayFor('m-0000aaaa', '198.18.1.10:80'))!;
    // What Caddy dials: a socket in its own mounted run folder, never a TCP port.
    expect(target).toMatch(/^unix\/\/run\/gw\/r-[0-9a-f]{16}\.sock$/);
    expect(await relayFor('m-0000aaaa', '198.18.1.10:80')).toBe(target);
    const site = { id: '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11', hostname: 'notes.example.com', target };
    expect(isRelayTarget(target)).toBe(true);
    expect(validSite(site)).toBe(true);
    const file = relayFile(target)!;
    expect(path.dirname(file)).toBe(dir);
    // Only NanoClaw's own user: the socket 0600 in a 0700 folder.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const got = await new Promise<string>((resolve) => {
      const c = net.connect(file, () => c.write('hi'));
      let t = '';
      c.on('data', (d) => (t += d.toString()));
      c.on('end', () => resolve(t));
    });
    expect(got).toBe('app:hi');
    expect(opened).toEqual(['m-0000aaaa 198.18.1.10:80']);
    keepRelays(new Set());
    expect(isRelayTarget(target)).toBe(false);
    expect(validSite(site)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    app.close();
  });

  it('opens no TCP port, takes no forged target, and clears sockets a previous run left', async () => {
    fs.writeFileSync(path.join(dir, `r-${'a'.repeat(16)}.sock`), '');
    __setRelayDirForTest(dir);
    linked.add('m-0000aaaa');
    const target = (await relayFor('m-0000aaaa', '198.18.1.11:80'))!;
    expect(fs.existsSync(path.join(dir, `r-${'a'.repeat(16)}.sock`))).toBe(false);
    for (const forged of [
      '127.0.0.1:8080',
      `unix//run/gw/r-${'b'.repeat(16)}.sock`,
      'unix//var/run/docker.sock',
      `${target}x`,
    ])
      expect(isRelayTarget(forged)).toBe(false);
  });
});
