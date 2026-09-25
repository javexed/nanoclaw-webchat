/**
 * The egress filter over real sockets: a local agent's proxy client on one
 * side, a stand-in OneCLI gateway on the other.
 */
import net from 'net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProxyHead, serveProxyClient, type EgressFilterDeps } from './egress-filter.js';
import { __resetRunnerEgressForTest, __setRunnerEgressForTest, allowlistFor, listBlocked } from './egress-policy.js';

let gateway: net.Server;
let gwPort: number;
let seen: string[];
let filter: net.Server;
let filterPort: number;
let deps: EgressFilterDeps;

beforeEach(async () => {
  __resetRunnerEgressForTest();
  seen = [];
  gateway = net.createServer((sock) => {
    let head = Buffer.alloc(0);
    const onData = (d: Buffer): void => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onData);
      seen.push(head.subarray(0, end).toString());
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = head.subarray(end + 4);
      if (rest.length) sock.write(Buffer.concat([Buffer.from('echo:'), rest]));
      sock.on('data', (x) => sock.write(Buffer.concat([Buffer.from('echo:'), x])));
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
  gwPort = await new Promise<number>((r) =>
    gateway.listen(0, '127.0.0.1', () => r((gateway.address() as net.AddressInfo).port)),
  );
  deps = {
    identify: async (ip) => (ip.includes('127.0.0.1') ? { agentGroupId: 'ag-1', sessionId: 's1' } : null),
    gateway: () => ({ host: '127.0.0.1', port: gwPort }),
    mode: async () => 'host-only',
    allowlist: async () => ['registry.npmjs.org'],
  };
  filter = net.createServer((sock) => void serveProxyClient(sock, deps));
  filterPort = await new Promise<number>((r) =>
    filter.listen(0, '127.0.0.1', () => r((filter.address() as net.AddressInfo).port)),
  );
});

afterEach(() => {
  filter.close();
  gateway.close();
  __resetRunnerEgressForTest();
});

const cred = `Proxy-Authorization: Basic ${Buffer.from('x:aoc_tok').toString('base64')}`;
function ask(request: string, then?: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(filterPort, '127.0.0.1', () => c.write(request));
    let got = '';
    c.on('data', (d) => {
      got += d.toString();
      if (then && got.includes('200 Connection Established') && !got.includes('echo:')) c.write(then);
      if (got.includes('echo:')) c.end();
    });
    c.on('close', () => resolve(got));
    c.on('error', () => resolve(got));
    setTimeout(() => c.destroy(), 1500);
  });
}

describe('egress filter', () => {
  it('an allowed CONNECT reaches the gateway with the credential the container presented, and pipes both ways', async () => {
    const got = await ask(
      `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n${cred}\r\n\r\n`,
      'hello',
    );
    expect(got).toContain('200 Connection Established');
    expect(got).toContain('echo:hello');
    expect(seen[0]).toContain('CONNECT registry.npmjs.org:443 HTTP/1.1');
    expect(seen[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('x:aoc_tok').toString('base64')}`);
  });

  it('the model is always reachable under the allowlist', async () => {
    const got = await ask(`CONNECT api.anthropic.com:443 HTTP/1.1\r\n${cred}\r\n\r\n`, 'm');
    expect(got).toContain('200 Connection Established');
  });

  it('an unlisted host is refused with a 403 that names it, recorded, and the gateway is never dialled', async () => {
    const got = await ask(`CONNECT paste.example:443 HTTP/1.1\r\n${cred}\r\n\r\n`);
    expect(got).toMatch(/^HTTP\/1.1 403 Forbidden/);
    expect(got).toContain('paste.example is not on the allowlist');
    expect(seen).toEqual([]);
    expect(listBlocked().map((b) => [b.host, b.agentGroupIds])).toEqual([['paste.example', ['ag-1']]]);
  });

  it("an agent's own hosts add to the install list for that agent only", async () => {
    __setRunnerEgressForTest({ allowlist: ['registry.npmjs.org'], agentHosts: { 'ag-1': ['pkgs.example.org'] } });
    deps.allowlist = allowlistFor;
    expect(await ask(`CONNECT pkgs.example.org:443 HTTP/1.1\r\n${cred}\r\n\r\n`, 'x')).toContain(
      '200 Connection Established',
    );
    expect(await ask(`CONNECT registry.npmjs.org:443 HTTP/1.1\r\n${cred}\r\n\r\n`, 'y')).toContain(
      '200 Connection Established',
    );
    deps.identify = async () => ({ agentGroupId: 'ag-2', sessionId: 's2' });
    expect(await ask(`CONNECT pkgs.example.org:443 HTTP/1.1\r\n${cred}\r\n\r\n`)).toContain('403 Forbidden');
    // Model only ignores both lists.
    deps.identify = async () => ({ agentGroupId: 'ag-1', sessionId: 's1' });
    deps.mode = async () => 'none';
    expect(await ask(`CONNECT pkgs.example.org:443 HTTP/1.1\r\n${cred}\r\n\r\n`)).toContain('403 Forbidden');
  });

  it('model only refuses even listed hosts', async () => {
    deps.mode = async () => 'none';
    const got = await ask(`CONNECT registry.npmjs.org:443 HTTP/1.1\r\n${cred}\r\n\r\n`);
    expect(got).toContain('403 Forbidden');
    expect(got).toContain('only the model');
  });

  it('an unknown container, and a request without credentials, are refused', async () => {
    deps.identify = async () => null;
    expect(await ask(`CONNECT registry.npmjs.org:443 HTTP/1.1\r\n${cred}\r\n\r\n`)).toContain('not known to NanoClaw');
    expect(await ask(`CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n`)).toContain('407 Proxy Authentication Required');
    expect(seen).toEqual([]);
  });

  it('a plain-HTTP request goes out as origin form through the gateway, proxy headers dropped', async () => {
    deps.allowlist = async () => ['plain.example'];
    const got = await ask(
      `GET http://plain.example/pkg?x=1 HTTP/1.1\r\nHost: plain.example\r\n${cred}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    expect(seen[0]).toContain('CONNECT plain.example:80 HTTP/1.1');
    expect(got).toContain('echo:GET /pkg?x=1 HTTP/1.1\r\nHost: plain.example\r\n\r\n');
    expect(got).not.toContain('Proxy-');
  });

  it('parses what it is given and refuses what it cannot proxy', () => {
    expect(parseProxyHead('CONNECT [::1]:443 HTTP/1.1')).toMatchObject({ kind: 'connect', host: '::1', port: 443 });
    expect(parseProxyHead('GET /local HTTP/1.1')).toMatchObject({ status: '501 Not Implemented' });
  });

  it('refuses a destination that would smuggle a second line into the gateway request', () => {
    const smuggled = 'CONNECT [10.0.0.5:22 HTTP/1.1\nX: a.githubusercontent.com]:443 HTTP/1.1';
    expect(parseProxyHead(smuggled)).toHaveProperty('error');
    expect(parseProxyHead(smuggled)).not.toHaveProperty('kind');
    expect(parseProxyHead('GET http://a_b!c/ HTTP/1.1')).toMatchObject({ status: '400 Bad Request' });
  });
});
