/**
 * Runtime egress for workload stacks: the declaration's rules, the subset
 * and intersection with the agent's own policy, and the proxy over real
 * sockets (a stand-in service on one side, a stand-in upstream on the other).
 */
import net from 'net';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __setOllamaTargetsForTest, closeWhenIdle } from './egress-filter.js';
import { __resetRunnerEgressForTest, listBlocked } from './egress-policy.js';
import {
  __resetWorkloadEgressForTest,
  closeWorkloadEgressListener,
  MAX_PER_SOURCE,
  namedLiterally,
  openWorkloadEgressListener,
  parseWorkloadEgress,
  recheckWorkloadEgress,
  serveWorkloadEgressClient,
  workloadAddressAllowed,
  workloadEgressAllowed,
  workloadEgressConnections,
  workloadEgressCovered,
  workloadEgressListeners,
  type WorkloadEgressCaller,
  type WorkloadEgressDeps,
} from './workload-egress.js';
import { __resetWorkloadEgressRefusalsForTest, workloadEgressRefusals } from './workload-egress-refusals.js';

describe('x-nanoclaw-egress', () => {
  it('normalizes names, ports and *.domain (port 443 only)', () => {
    expect(
      parseWorkloadEgress(['API.example.com', 'https://api.example.com/v2', '*.example.org', '192.0.2.10:8080']),
    ).toEqual({ ok: true, entries: ['api.example.com', '*.example.org:443', '192.0.2.10:8080'] });
    expect(parseWorkloadEgress(['*.example.org:443'])).toEqual({ ok: true, entries: ['*.example.org:443'] });
    const r = parseWorkloadEgress(['*.example.org:80']);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('port 443 only');
  });

  it('refuses a bare *', () => {
    for (const bad of ['*', '*:443']) {
      const r = parseWorkloadEgress([bad]);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain('bare *');
    }
  });

  it('wants a LAN address literally, with its port', () => {
    expect(parseWorkloadEgress(['10.0.0.5:11434'])).toEqual({ ok: true, entries: ['10.0.0.5:11434'] });
    const r = parseWorkloadEgress(['10.0.0.5']);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('needs its port');
  });

  it('never names this host, the workload range, Docker, link-local, the tailnet or the edge', () => {
    for (const bad of [
      '198.18.0.10:80',
      '198.19.1.1:80',
      '172.17.0.1:8080',
      '127.0.0.1:80',
      '169.254.169.254:80',
      '100.100.100.200:80',
      'host.docker.internal:443',
      '*.docker.internal',
      'localhost:80',
    ])
      expect(parseWorkloadEgress([bad]).ok, bad).toBe(false);
    expect(parseWorkloadEgress(['198.51.100.7:443'], ['198.51.100.0/24']).ok).toBe(false);
    expect(parseWorkloadEgress(['198.51.100.7:443']).ok).toBe(true);
  });

  it('refuses a wildcard over numbers, which would match addresses', () => {
    for (const bad of ['*.0.5', '*.0.0.5:443', '0.5']) expect(parseWorkloadEgress([bad]).ok, bad).toBe(false);
  });

  it('refuses IPv6: the host rules are IPv4 only', () => {
    for (const bad of ['[2001:db8::1]:443', '2001:db8::1']) expect(parseWorkloadEgress([bad]).ok, bad).toBe(false);
  });

  it('caps the list and wants a list of strings', () => {
    expect(parseWorkloadEgress(Array.from({ length: 11 }, (_, i) => `h${i}.example.com`)).ok).toBe(false);
    expect(parseWorkloadEgress('api.example.com').ok).toBe(false);
    expect(parseWorkloadEgress([3]).ok).toBe(false);
  });
});

describe('the subset and the intersection', () => {
  it('holds a declared entry to the agent’s own reach, never its model floor', () => {
    const allow = ['api.example.com', '*.example.org', 'db.example.net:5432'];
    expect(workloadEgressCovered('api.example.com', 'host-only', allow, [])).toBe(true);
    expect(workloadEgressCovered('x.example.org', 'host-only', allow, [])).toBe(true);
    expect(workloadEgressCovered('*.example.org:443', 'host-only', allow, [])).toBe(true);
    expect(workloadEgressCovered('*.a.example.org:443', 'host-only', allow, [])).toBe(true);
    expect(workloadEgressCovered('*.example.com:443', 'host-only', allow, [])).toBe(false);
    expect(workloadEgressCovered('db.example.net:5432', 'host-only', allow, [])).toBe(true);
    expect(workloadEgressCovered('db.example.net', 'host-only', allow, [])).toBe(false);
    expect(workloadEgressCovered('api.anthropic.com', 'host-only', allow, [])).toBe(false);
    // Its own model on another machine.
    expect(workloadEgressCovered('192.0.2.69:11434', 'host-only', [], ['192.0.2.69:11434'])).toBe(true);
    expect(workloadEgressCovered('192.0.2.69:11434', 'none', [], ['192.0.2.69:11434'])).toBe(true);
    // Model only: nothing from the allowlist.
    expect(workloadEgressCovered('api.example.com', 'none', allow, [])).toBe(false);
    // Open: no allowlist to be a subset of.
    expect(workloadEgressCovered('anything.example', 'open', [], [])).toBe(true);
  });

  it('enforces the approved list AND the agent’s current list at runtime', () => {
    const approved = ['api.example.com', '*.example.org:443'];
    expect(workloadEgressAllowed('api.example.com', 443, approved, 'host-only', ['api.example.com'], [])).toBe(true);
    // Taken off the agent: cut off.
    expect(workloadEgressAllowed('api.example.com', 443, approved, 'host-only', [], [])).toBe(false);
    // On the agent, not approved for the stack.
    expect(workloadEgressAllowed('other.example.com', 443, approved, 'host-only', ['other.example.com'], [])).toBe(
      false,
    );
    expect(workloadEgressAllowed('a.example.org', 80, approved, 'host-only', ['*.example.org'], [])).toBe(false);
    expect(workloadEgressAllowed('a.example.org', 443, approved, 'host-only', ['*.example.org'], [])).toBe(true);
    // Open: the approved list alone.
    expect(workloadEgressAllowed('api.example.com', 443, approved, 'open', [], [])).toBe(true);
    expect(workloadEgressAllowed('other.example.com', 443, approved, 'open', [], [])).toBe(false);
  });

  it('refuses this host, Docker’s and the workload range, and a private address a name resolves to', () => {
    expect(workloadAddressAllowed('192.0.2.20', false)).toBe(true);
    expect(workloadAddressAllowed('10.0.0.5', false)).toBe(false);
    expect(workloadAddressAllowed('10.0.0.5', true)).toBe(true);
    expect(workloadAddressAllowed('198.18.0.10', true)).toBe(false);
    expect(workloadAddressAllowed('172.17.0.0', true)).toBe(false);
    expect(workloadAddressAllowed('127.0.0.1', true)).toBe(false);
    expect(workloadAddressAllowed('169.254.169.254', true)).toBe(false);
    expect(workloadAddressAllowed('100.96.1.2', true)).toBe(false);
    expect(workloadAddressAllowed('10.4.0.4', true, ['10.4.0.0/16'])).toBe(false);
    expect(workloadAddressAllowed('2001:db8::1', true)).toBe(false);
  });

  it('lets a private address through only when the approved entry is that address and port', () => {
    expect(namedLiterally('10.0.0.5', 8080, ['10.0.0.5:8080'])).toBe(true);
    expect(namedLiterally('10.0.0.5', 443, ['10.0.0.5:8080'])).toBe(false);
    expect(namedLiterally('10.0.0.5', 443, ['*.0.5:443'])).toBe(false);
    expect(namedLiterally('lan.example.com', 443, ['lan.example.com'])).toBe(false);
    // A wildcard stored before numbers were refused still matches no address.
    expect(workloadEgressAllowed('10.0.0.5', 443, ['*.0.5:443'], 'open', [], [])).toBe(false);
  });
});

describe('the workload egress proxy', () => {
  let upstream: net.Server;
  let upPort: number;
  let received: string[];
  let proxy: net.Server;
  let proxyPort: number;
  let dialled: string[];
  let caller: WorkloadEgressCaller | null;
  let deps: WorkloadEgressDeps;

  beforeEach(async () => {
    __resetRunnerEgressForTest();
    __resetWorkloadEgressRefusalsForTest();
    received = [];
    dialled = [];
    upstream = net.createServer((sock) => {
      sock.on('data', (d) => {
        received.push(d.toString());
        sock.write(Buffer.concat([Buffer.from('echo:'), d]));
      });
      sock.on('error', () => {});
    });
    upPort = await new Promise<number>((r) =>
      upstream.listen(0, '127.0.0.1', () => r((upstream.address() as net.AddressInfo).port)),
    );
    caller = {
      agentGroupId: 'ag-1',
      sessionId: 'workload:w1/api',
      workloadId: 'w1',
      service: 'api',
      approved: ['api.example.com', '192.0.2.69:11434', '10.0.0.5:8080'],
    };
    deps = {
      identify: async () => caller,
      mode: async () => 'host-only',
      allowlist: async () => ['api.example.com', '10.0.0.5:8080'],
      ownModels: async () => ['192.0.2.69:11434'],
      forbidden: async () => [],
      resolve: async (h) =>
        h === 'api.example.com' ? '192.0.2.20' : h === 'lan.example.com' ? '10.0.0.9' : '192.0.2.30',
      ollamaTargets: async () => [],
      dial: async (address, port) => {
        dialled.push(`${address}:${port}`);
        return net.connect(upPort, '127.0.0.1');
      },
    };
    proxy = net.createServer((sock) => void serveWorkloadEgressClient(sock, deps));
    proxyPort = await new Promise<number>((r) =>
      proxy.listen(0, '127.0.0.1', () => r((proxy.address() as net.AddressInfo).port)),
    );
  });

  afterEach(() => {
    proxy.close();
    upstream.close();
    __setOllamaTargetsForTest([]);
    __resetRunnerEgressForTest();
    __resetWorkloadEgressForTest();
  });

  function ask(request: string, then?: string): Promise<string> {
    return new Promise((resolve) => {
      const c = net.connect(proxyPort, '127.0.0.1', () => c.write(request));
      let got = '';
      c.on('data', (d) => {
        got += d.toString();
        if (then && got.includes('200 Connection Established') && !got.includes('echo:')) c.write(then);
        if (got.includes('echo:')) setTimeout(() => c.end(), 30);
      });
      c.on('close', () => resolve(got));
      c.on('error', () => resolve(got));
      setTimeout(() => c.destroy(), 1500);
    });
  }

  it('tunnels an approved host the agent may reach, directly to the address it resolved to', async () => {
    const got = await ask('CONNECT api.example.com:443 HTTP/1.1\r\n\r\n', 'hello');
    expect(got).toContain('200 Connection Established');
    expect(got).toContain('echo:hello');
    expect(dialled).toEqual(['192.0.2.20:443']);
  });

  it('refuses a host it was not approved for, and records it for the agent only', async () => {
    const got = await ask('CONNECT other.example.com:443 HTTP/1.1\r\n\r\n');
    expect(got).toContain('403');
    expect(got).toContain('x-nanoclaw-egress');
    expect(dialled).toEqual([]);
    expect(workloadEgressRefusals('ag-1', 'w1')[0]).toMatchObject({ service: 'api', host: 'other.example.com' });
    // Never offered on the install-wide "Allow" list, which would open it to every agent.
    expect(listBlocked()).toEqual([]);
  });

  it('cuts a stack off when the agent loses the host', async () => {
    deps.allowlist = async () => [];
    expect(await ask('CONNECT api.example.com:443 HTTP/1.1\r\n\r\n')).toContain('403');
    deps.mode = async () => 'open';
    expect(await ask('CONNECT api.example.com:443 HTTP/1.1\r\n\r\n', 'x')).toContain('echo:x');
  });

  it('refuses a caller that is no service of a running stack', async () => {
    caller = null;
    expect(await ask('CONNECT api.example.com:443 HTTP/1.1\r\n\r\n')).toContain('403');
    caller = { agentGroupId: 'ag-1', sessionId: 'workload:unknown', workloadId: null, service: null, approved: [] };
    expect(await ask('CONNECT api.example.com:443 HTTP/1.1\r\n\r\n')).toContain('403');
    expect(dialled).toEqual([]);
  });

  it('refuses a name that resolves to a private address, but dials a listed LAN address', async () => {
    caller!.approved.push('lan.example.com');
    deps.allowlist = async () => ['lan.example.com', '10.0.0.5:8080'];
    expect(await ask('CONNECT lan.example.com:443 HTTP/1.1\r\n\r\n')).toContain('resolves to 10.0.0.9');
    expect(await ask('CONNECT 10.0.0.5:8080 HTTP/1.1\r\n\r\n', 'x')).toContain('echo:x');
    expect(dialled).toEqual(['10.0.0.5:8080']);
  });

  it('refuses a stored numeric wildcard reaching a LAN address', async () => {
    caller!.approved = ['*.0.5:443'];
    deps.mode = async () => 'open';
    expect(await ask('CONNECT 10.0.0.5:443 HTTP/1.1\r\n\r\n', 'x')).toContain('403');
    expect(dialled).toEqual([]);
  });

  it('refuses an IPv6 address', async () => {
    deps.mode = async () => 'open';
    expect(await ask('CONNECT [2001:db8::1]:443 HTTP/1.1\r\n\r\n')).toContain('IPv4');
    expect(dialled).toEqual([]);
  });

  it('fails closed on a LAN address or Ollama port until the model registry has been read', async () => {
    deps.ollamaTargets = async () => null;
    expect(await ask('CONNECT 10.0.0.5:8080 HTTP/1.1\r\n\r\n', 'x')).toContain('503');
    expect(await ask('POST http://192.0.2.69:11434/api/pull HTTP/1.1\r\nContent-Length: 0\r\n\r\n')).toContain(
      'model registry',
    );
    expect(dialled).toEqual([]);
    // A public name is not held up.
    expect(await ask('CONNECT api.example.com:443 HTTP/1.1\r\n\r\n', 'x')).toContain('echo:x');
  });

  it('knows an Ollama server from the registry when no agent filter has started', async () => {
    __setOllamaTargetsForTest([]);
    deps.ollamaTargets = async () => [{ host: '192.0.2.69', port: 11434 }];
    expect(await ask('POST http://192.0.2.69:11434/api/pull HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}')).toContain('403');
    expect(await ask('CONNECT 192.0.2.69:11434 HTTP/1.1\r\n\r\n', 'DELETE /api/delete HTTP/1.1\r\n\r\n')).toContain(
      '403',
    );
    expect(dialled).toEqual([]);
    expect(await ask('POST http://192.0.2.69:11434/api/chat HTTP/1.1\r\nContent-Length: 0\r\n\r\n')).toContain(
      'echo:POST /api/chat',
    );
  });

  it('forwards one plain-HTTP request per connection, never a pipelined second one', async () => {
    await ask('GET http://api.example.com/ HTTP/1.1\r\n\r\nGET /admin HTTP/1.1\r\nHost: other.example\r\n\r\n');
    const sent = received.join('');
    expect(sent).toContain('Connection: close');
    expect(sent).not.toContain('other.example');
    expect(sent).not.toContain('/admin');
    expect(
      await ask('POST http://api.example.com/up HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'),
    ).toContain('411');
  });

  it('sends plain HTTP in origin form', async () => {
    const got = await ask('GET http://api.example.com/cards?q=1 HTTP/1.1\r\nHost: evil.example\r\n\r\n');
    expect(got).toContain('echo:GET /cards?q=1 HTTP/1.1');
    expect(received.join('')).toContain('Host: api.example.com');
    expect(received.join('')).not.toContain('evil.example');
  });

  describe('an approved Ollama server', () => {
    beforeEach(() => __setOllamaTargetsForTest([{ host: '192.0.2.69', port: 11434 }]));

    it('takes inference over plain HTTP, one request per connection', async () => {
      const body = '{"model":"m"}';
      const got = await ask(
        `POST http://192.0.2.69:11434/api/chat HTTP/1.1\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}GET /api/delete HTTP/1.1\r\n\r\n`,
      );
      expect(got).toContain('echo:POST /api/chat HTTP/1.1');
      const sent = received.join('');
      expect(sent).toContain('Connection: close');
      expect(sent).not.toContain('keep-alive');
      expect(sent).toContain(body);
      expect(sent).not.toContain('/api/delete');
      expect(dialled).toEqual(['192.0.2.69:11434']);
    });

    it('refuses anything but inference, a tunnel, and a chunked body', async () => {
      expect(await ask('DELETE http://192.0.2.69:11434/api/delete HTTP/1.1\r\nContent-Length: 0\r\n\r\n')).toContain(
        '403',
      );
      expect(await ask('POST http://192.0.2.69:11434/api/pull HTTP/1.1\r\nContent-Length: 0\r\n\r\n')).toContain('403');
      expect(await ask('CONNECT 192.0.2.69:11434 HTTP/1.1\r\n\r\n')).toContain('403');
      expect(
        await ask('POST http://192.0.2.69:11434/api/chat HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'),
      ).toContain('411');
      expect(dialled).toEqual([]);
    });

    it('is refused when the service was not approved for it', async () => {
      caller!.approved = ['api.example.com'];
      expect(await ask('POST http://192.0.2.69:11434/api/chat HTTP/1.1\r\nContent-Length: 0\r\n\r\n')).toContain('403');
      expect(dialled).toEqual([]);
    });
  });
});

describe('the listeners', () => {
  afterEach(() => __resetWorkloadEgressForTest());

  it('refuse a source holding too many connections', async () => {
    const probe = net.createServer();
    const port = await new Promise<number>((r) =>
      probe.listen(0, '127.0.0.1', () => r((probe.address() as net.AddressInfo).port)),
    );
    await new Promise((r) => probe.close(r));
    await openWorkloadEgressListener('127.0.0.1', port, { identify: async () => null });
    const open: net.Socket[] = [];
    try {
      for (let i = 0; i < MAX_PER_SOURCE; i++) {
        const c = net.connect(port, '127.0.0.1');
        c.on('error', () => {});
        open.push(c);
        await new Promise((r) => c.once('connect', r));
      }
      const extra = await new Promise<string>((resolve) => {
        const c = net.connect(port, '127.0.0.1');
        let got = '';
        c.on('data', (d) => (got += d.toString()));
        c.on('close', () => resolve(got));
        c.on('error', () => resolve(got));
      });
      expect(extra).toContain('429');
    } finally {
      for (const c of open) c.destroy();
    }
  });

  it('close a tunnel that carries nothing for the idle window', async () => {
    const a = new PassThrough();
    const b = new PassThrough();
    closeWhenIdle(a, b, 60);
    a.on('data', () => {});
    b.on('data', () => {});
    await new Promise((r) => setTimeout(r, 40));
    a.write('x');
    await new Promise((r) => setTimeout(r, 40));
    expect(a.destroyed || b.destroyed).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(a.destroyed && b.destroyed).toBe(true);
  });

  it('open once per address, report a port they cannot have, and close', async () => {
    const held = net.createServer();
    const port = await new Promise<number>((r) =>
      held.listen(0, '127.0.0.1', () => r((held.address() as net.AddressInfo).port)),
    );
    const deps: WorkloadEgressDeps = { identify: async () => null };
    await expect(openWorkloadEgressListener('127.0.0.1', port, deps)).rejects.toThrow(/EADDRINUSE/);
    expect(workloadEgressListeners()).toEqual([]);
    await new Promise((r) => held.close(r));
    const first = openWorkloadEgressListener('127.0.0.1', port, deps);
    expect(openWorkloadEgressListener('127.0.0.1', port, deps)).toBe(first);
    await first;
    expect(workloadEgressListeners()).toEqual([`127.0.0.1:${port}`]);
    closeWorkloadEgressListener('127.0.0.1');
    expect(workloadEgressListeners()).toEqual([]);
  });
});

describe('open connections', () => {
  let upstream: net.Server;
  let upPort: number;
  let port: number;
  let caller: WorkloadEgressCaller | null;
  let allowlist: string[];
  let deps: WorkloadEgressDeps;
  const clients: net.Socket[] = [];

  beforeEach(async () => {
    __resetRunnerEgressForTest();
    __resetWorkloadEgressRefusalsForTest();
    upstream = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('echo:'), d])));
      sock.on('error', () => {});
    });
    upPort = await new Promise<number>((r) =>
      upstream.listen(0, '127.0.0.1', () => r((upstream.address() as net.AddressInfo).port)),
    );
    const free = net.createServer();
    port = await new Promise<number>((r) =>
      free.listen(0, '127.0.0.1', () => r((free.address() as net.AddressInfo).port)),
    );
    await new Promise((r) => free.close(r));
    caller = {
      agentGroupId: 'ag-1',
      sessionId: 'workload:w1/api',
      workloadId: 'w1',
      service: 'api',
      approved: ['api.example.com', 'b.example.com'],
    };
    allowlist = ['api.example.com', 'b.example.com'];
    deps = {
      identify: async () => caller,
      mode: async () => 'host-only',
      allowlist: async () => allowlist,
      ownModels: async () => [],
      forbidden: async () => [],
      resolve: async () => '192.0.2.20',
      ollamaTargets: async () => [],
      dial: async () => net.connect(upPort, '127.0.0.1'),
    };
    await openWorkloadEgressListener('127.0.0.1', port, deps);
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    upstream.close();
    __resetRunnerEgressForTest();
    __resetWorkloadEgressForTest();
  });

  /** Open a tunnel through the listener; resolves once it carries data, with a promise for its close. */
  async function tunnel(host: string): Promise<{ sock: net.Socket; closed: Promise<void> }> {
    const sock = net.connect(port, '127.0.0.1');
    clients.push(sock);
    sock.on('error', () => {});
    const closed = new Promise<void>((r) => sock.once('close', () => r()));
    await new Promise<void>((resolve, reject) => {
      let got = '';
      sock.on('data', (d) => {
        got += d.toString();
        if (got.includes('200 Connection Established') && !got.includes('echo:')) sock.write('ping');
        if (got.includes('echo:ping')) resolve();
      });
      sock.once('close', () => reject(new Error(`closed early: ${got}`)));
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
    });
    return { sock, closed };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('are kept while still permitted', async () => {
    const t = await tunnel('api.example.com');
    expect(workloadEgressConnections()).toBe(1);
    expect(await recheckWorkloadEgress()).toBe(0);
    await settle();
    expect(t.sock.destroyed).toBe(false);
  });

  it('close when the approved list no longer names the host', async () => {
    const keep = await tunnel('b.example.com');
    const t = await tunnel('api.example.com');
    caller = { ...caller!, approved: ['b.example.com'] };
    expect(await recheckWorkloadEgress()).toBe(1);
    await t.closed;
    expect(keep.sock.destroyed).toBe(false);
    expect(workloadEgressConnections()).toBe(1);
    expect(workloadEgressRefusals('ag-1', 'w1')[0]).toMatchObject({ host: 'api.example.com', port: 443 });
    expect(workloadEgressRefusals('ag-1', 'w1')[0].reason).toMatch(/open connection was closed/);
  });

  it('close when the agent loses the host', async () => {
    const t = await tunnel('api.example.com');
    allowlist = [];
    expect(await recheckWorkloadEgress()).toBe(1);
    await t.closed;
  });

  it('close when the service no longer runs', async () => {
    const t = await tunnel('api.example.com');
    caller = { agentGroupId: 'ag-1', sessionId: 'workload:unknown', workloadId: null, service: null, approved: [] };
    expect(await recheckWorkloadEgress()).toBe(1);
    await t.closed;
  });

  it('close when another stack holds the address now', async () => {
    const t = await tunnel('api.example.com');
    caller = { ...caller!, workloadId: 'w2', sessionId: 'workload:w2/api' };
    expect(await recheckWorkloadEgress()).toBe(1);
    await t.closed;
  });

  it('are kept for a pass when the caller cannot be looked up', async () => {
    const t = await tunnel('api.example.com');
    deps.identify = async () => {
      throw new Error('store busy');
    };
    expect(await recheckWorkloadEgress()).toBe(0);
    await settle();
    expect(t.sock.destroyed).toBe(false);
  });

  it('all close with their listener', async () => {
    const a = await tunnel('api.example.com');
    const b = await tunnel('b.example.com');
    closeWorkloadEgressListener('127.0.0.1');
    await Promise.all([a.closed, b.closed]);
    expect(workloadEgressConnections()).toBe(0);
  });
});
