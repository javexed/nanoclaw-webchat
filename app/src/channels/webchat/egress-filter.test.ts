/**
 * The egress filter over real sockets: a local agent's proxy client on one
 * side, a stand-in OneCLI gateway on the other.
 */
import net from 'net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProxyHead, serveModelPort, serveProxyClient, type EgressFilterDeps } from './egress-filter.js';
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

describe('a host-local model port', () => {
  // A stand-in model server on the host, reached through the bridge listener.
  async function throughModelPort(d: EgressFilterDeps): Promise<string> {
    const model = net.createServer((sock) => sock.end('model-says-hi'));
    const mPort = await new Promise<number>((r) =>
      model.listen(0, '127.0.0.1', () => r((model.address() as net.AddressInfo).port)),
    );
    const bridge = net.createServer((sock) => void serveModelPort(sock, 11434, { host: '127.0.0.1', port: mPort }, d));
    const bPort = await new Promise<number>((r) =>
      bridge.listen(0, '127.0.0.1', () => r((bridge.address() as net.AddressInfo).port)),
    );
    try {
      return await new Promise<string>((resolve) => {
        let got = '';
        const c = net.connect(bPort, '127.0.0.1');
        c.on('data', (x) => (got += x.toString()));
        c.on('close', () => resolve(got));
        c.on('error', () => resolve(got));
      });
    } finally {
      bridge.close();
      model.close();
    }
  }

  it("reaches the agent's own model", async () => {
    const d = {
      ...deps,
      mode: async () => 'none' as const,
      always: async () => ['api.anthropic.com', 'host.docker.internal:11434'],
    };
    expect(await throughModelPort(d)).toBe('model-says-hi');
  });

  it('is refused to an agent whose model it is not, and recorded', async () => {
    const d = { ...deps, mode: async () => 'none' as const, always: async () => ['api.anthropic.com'] };
    expect(await throughModelPort(d)).toBe('');
    expect(listBlocked().map((b) => [b.host, b.port])).toEqual([['host.docker.internal', 11434]]);
  });

  it('is refused to a caller the filter cannot identify', async () => {
    const d = { ...deps, identify: async () => null, always: async () => ['host.docker.internal:11434'] };
    expect(await throughModelPort(d)).toBe('');
  });
});

describe('a relay to a model on another machine', () => {
  // A stand-in for the model on the LAN behind a relay port; `d` is given the model's address.
  async function throughRelay(d: (model: string) => EgressFilterDeps): Promise<string> {
    const model = net.createServer((sock) => sock.end('lan-model-says-hi'));
    const mPort = await new Promise<number>((r) =>
      model.listen(0, '127.0.0.1', () => r((model.address() as net.AddressInfo).port)),
    );
    const bridge = net.createServer(
      (sock) => void serveModelPort(sock, 47123, { host: '127.0.0.1', port: mPort }, d(`127.0.0.1:${mPort}`), true),
    );
    const bPort = await new Promise<number>((r) =>
      bridge.listen(0, '127.0.0.1', () => r((bridge.address() as net.AddressInfo).port)),
    );
    try {
      return await new Promise<string>((resolve) => {
        let got = '';
        const c = net.connect(bPort, '127.0.0.1');
        c.on('data', (x) => (got += x.toString()));
        c.on('close', () => resolve(got));
        c.on('error', () => resolve(got));
      });
    } finally {
      bridge.close();
      model.close();
    }
  }

  it('lets the agent whose model it is through, in either filtered mode', async () => {
    for (const mode of ['host-only', 'none'] as const) {
      const got = await throughRelay((m) => ({ ...deps, mode: async () => mode, ownModels: async () => [m] }));
      expect(got).toBe('lan-model-says-hi');
    }
  });

  it('refuses any other agent on the network, and records the model host it wanted', async () => {
    let wanted = '';
    const got = await throughRelay((m) => {
      wanted = m;
      return { ...deps, mode: async () => 'host-only', ownModels: async () => ['192.0.2.10:11434'] };
    });
    expect(got).toBe('');
    expect(listBlocked().map((b) => `${b.host}:${b.port}`)).toEqual([wanted]);
  });

  it('model only stays model only: an allowlisted model host is still refused to an agent it is not the model of', async () => {
    const got = await throughRelay((m) => ({
      ...deps,
      mode: async () => 'none',
      allowlist: async () => [m],
      ownModels: async () => [],
    }));
    expect(got).toBe('');
  });

  it('is refused to a caller the filter cannot identify', async () => {
    expect(await throughRelay((m) => ({ ...deps, identify: async () => null, ownModels: async () => [m] }))).toBe('');
  });
});

describe('a direct tunnel to an explicitly listed non-web port', () => {
  let target: net.Server;
  let dialled: string[];
  beforeEach(async () => {
    dialled = [];
    target = net.createServer((sock) => {
      sock.write('SSH-2.0-test\r\n');
      sock.on('data', (x) => sock.write(Buffer.concat([Buffer.from('echo:'), x])));
      sock.on('error', () => {});
    });
    const port = await new Promise<number>((r) =>
      target.listen(0, '127.0.0.1', () => r((target.address() as net.AddressInfo).port)),
    );
    // The install list (global admins) names the direct-tunnel entries; the
    // agent's own hosts come on top in `allowlist`.
    const install = ['app.internal:22', 'api.internal:443', '127.0.0.1:5432', 'plain.internal'];
    deps.installAllowlist = async () => install;
    deps.allowlist = async () => [...install, 'own.internal:22'];
    deps.direct = async (host, p) => {
      dialled.push(`${host}:${p}`);
      return net.connect(port, '127.0.0.1');
    };
  });
  afterEach(() => target.close());

  it('connects straight to the target, past the gateway, and pipes both ways', async () => {
    const got = await ask(`CONNECT app.internal:22 HTTP/1.1\r\n${cred}\r\n\r\n`, 'hi');
    expect(got).toContain('200 Connection Established');
    expect(got).toContain('SSH-2.0-test');
    expect(got).toContain('echo:hi');
    expect(dialled).toEqual(['app.internal:22']);
    expect(seen).toEqual([]);
  });

  it('leaves web ports, loopback and unported entries to the gateway or the allowlist', async () => {
    await ask(`CONNECT api.internal:443 HTTP/1.1\r\n${cred}\r\n\r\n`, 'x');
    await ask(`CONNECT 127.0.0.1:5432 HTTP/1.1\r\n${cred}\r\n\r\n`, 'x');
    expect(dialled).toEqual([]);
    expect(seen.map((s) => s.split('\r\n')[0])).toEqual([
      'CONNECT api.internal:443 HTTP/1.1',
      'CONNECT 127.0.0.1:5432 HTTP/1.1',
    ]);
    // A host listed without a port allows 443 and 80 only.
    expect(await ask(`CONNECT plain.internal:22 HTTP/1.1\r\n${cred}\r\n\r\n`)).toMatch(/^HTTP\/1.1 403/);
  });

  it("an agent's own host:port (its scoped admins') goes to the gateway, never direct", async () => {
    await ask(`CONNECT own.internal:22 HTTP/1.1\r\n${cred}\r\n\r\n`, 'x');
    expect(dialled).toEqual([]);
    expect(seen.map((s) => s.split('\r\n')[0])).toEqual(['CONNECT own.internal:22 HTTP/1.1']);
  });

  it('is refused under model only, and a target that does not answer is a 502', async () => {
    deps.mode = async () => 'none';
    expect(await ask(`CONNECT app.internal:22 HTTP/1.1\r\n${cred}\r\n\r\n`)).toMatch(/^HTTP\/1.1 403/);
    deps.mode = async () => 'host-only';
    deps.direct = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const got = await ask(`CONNECT app.internal:22 HTTP/1.1\r\n${cred}\r\n\r\n`);
    expect(got).toMatch(/^HTTP\/1.1 502/);
    expect(got).toContain('could not reach app.internal:22');
  });
});

describe('which addresses a direct tunnel may reach', () => {
  const own = new Set(['172.17.0.1', '192.168.0.20', 'fd00::5']);

  it('refuses loopback, link-local (the metadata service) and unspecified, IPv4-mapped included', async () => {
    const { directAddressAllowed } = await import('./egress-policy.js');
    for (const a of [
      '127.0.0.1',
      '127.8.8.8',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      for (const literal of [false, true]) expect(directAddressAllowed(a, literal, own), a).toBe(false);
    for (const a of ['203.0.113.7', '2001:db8::1', '100.96.1.2'])
      expect(directAddressAllowed(a, false, own), a).toBe(true);
  });

  it('refuses this machine itself: its own addresses and the docker bridge gateway, even listed literally', async () => {
    const { directAddressAllowed, hostOwnAddresses } = await import('./egress-policy.js');
    for (const a of ['172.17.0.1', '::ffff:172.17.0.1', '192.168.0.20', 'fd00::5'])
      expect(directAddressAllowed(a, true, own), a).toBe(false);
    // The real set: the bridge gateway always, and this machine's loopback.
    const real = hostOwnAddresses();
    expect(real.has('172.17.0.1')).toBe(true);
    expect(directAddressAllowed('172.17.0.1', true)).toBe(false);
  });

  it('a private address only when the entry is that address, never by a name resolving there', async () => {
    const { directAddressAllowed } = await import('./egress-policy.js');
    for (const a of ['10.0.0.5', '172.16.0.0', '192.168.0.7', 'fd00::7', '::ffff:10.0.0.5']) {
      expect(directAddressAllowed(a, false, own), a).toBe(false);
      expect(directAddressAllowed(a, true, own), a).toBe(true);
    }
    // 172.32.x is not RFC 1918.
    expect(directAddressAllowed('172.32.0.1', false, own)).toBe(true);
  });

  it('decides by the install list alone, and refuses a literal loopback, metadata or bridge address', async () => {
    const { directTunnel } = await import('./egress-policy.js');
    expect(directTunnel('host-only', 'git.example', 22, ['git.example:22'])).toBe(true);
    expect(directTunnel('host-only', 'git.example', 22, [])).toBe(false);
    expect(directTunnel('host-only', '169.254.169.254', 80, ['169.254.169.254:80'])).toBe(false);
    expect(directTunnel('host-only', '169.254.169.254', 8080, ['169.254.169.254:8080'])).toBe(false);
    expect(directTunnel('host-only', '172.17.0.1', 5432, ['172.17.0.1:5432'])).toBe(false);
    expect(directTunnel('host-only', '10.0.0.5', 22, ['10.0.0.5:22'])).toBe(true);
    expect(directTunnel('none', 'git.example', 22, ['git.example:22'])).toBe(false);
  });
});
