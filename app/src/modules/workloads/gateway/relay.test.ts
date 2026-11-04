/**
 * Apps of stacks on workers: Caddy dials a loopback relay, whose connections
 * go over the worker's link to the workload's address there.
 */
import net from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

const { __resetRelaysForTest, isRelayTarget, keepRelays, relayFor } = await import('./relay.js');
const { validSite } = await import('./caddy.js');

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
    expect(target).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(await relayFor('m-0000aaaa', '198.18.1.10:80')).toBe(target);
    const site = { id: '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11', hostname: 'notes.example.com', target };
    expect(isRelayTarget(target)).toBe(true);
    expect(validSite(site)).toBe(true);
    const got = await new Promise<string>((resolve) => {
      const c = net.connect(Number(target.split(':')[1]), '127.0.0.1', () => c.write('hi'));
      let t = '';
      c.on('data', (d) => (t += d.toString()));
      c.on('end', () => resolve(t));
    });
    expect(got).toBe('app:hi');
    expect(opened).toEqual(['m-0000aaaa 198.18.1.10:80']);
    keepRelays(new Set());
    expect(isRelayTarget(target)).toBe(false);
    expect(validSite(site)).toBe(false);
    app.close();
  });
});
