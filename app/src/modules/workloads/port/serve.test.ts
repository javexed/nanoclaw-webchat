import { describe, expect, it } from 'vitest';

import { readServe } from './serve.js';

const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'node.tail1.ts.net.' } });
const web = (port: number, proxy: string, extra: Record<string, unknown> = {}) => ({
  [`node.tail1.ts.net:${port}`]: { Handlers: { '/': { Proxy: proxy }, ...extra } },
});
const serve = (o: Record<string, unknown>) => JSON.stringify(o);

describe('reading what Tailscale serves', () => {
  it('a port forwarded whole to its own loopback listener is usable', () => {
    const v = readServe(
      status,
      serve({ TCP: { '9001': { HTTPS: true } }, Web: web(9001, 'http://127.0.0.1:9001') }),
      [9001, 9002],
    );
    expect(v).toEqual({ dns: 'node.tail1.ts.net', usable: [9001], problems: [], missing: [9002] });
  });

  it('never uses a port on Funnel, or one serving anything else', () => {
    const v = readServe(
      status,
      serve({
        TCP: { '9001': { HTTPS: true }, '9002': { HTTPS: true }, '9003': { HTTPS: true }, '9004': { HTTPS: true } },
        Web: {
          ...web(9001, 'http://127.0.0.1:9001'),
          ...web(9002, 'http://127.0.0.1:3000'),
          ...web(9003, 'http://127.0.0.1:9003', { '/admin': { Proxy: 'http://127.0.0.1:9' } }),
          ...web(9004, 'http://10.0.0.5:9004'),
        },
        AllowFunnel: { 'node.tail1.ts.net:9001': true },
      }),
      [9001, 9002, 9003, 9004],
    );
    expect(v.usable).toEqual([]);
    expect(v.problems.map((p) => p.port)).toEqual([9001, 9002, 9003, 9004]);
    expect(v.problems[0].problem).toMatch(/Funnel/);
  });

  it('a plain TCP forward is not HTTPS, so not usable', () => {
    const v = readServe(status, serve({ TCP: { '9001': { TCPForward: '127.0.0.1:9001' } } }), [9001]);
    expect(v.usable).toEqual([]);
    expect(v.problems).toHaveLength(1);
  });

  it('nothing is usable while Tailscale is not running', () => {
    const v = readServe(
      JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'node.tail1.ts.net.' } }),
      '{}',
      [9001],
    );
    expect(v).toEqual({ dns: null, usable: [], problems: [], missing: [9001] });
    expect(readServe('not json', '{}', [9001]).dns).toBeNull();
  });
});
