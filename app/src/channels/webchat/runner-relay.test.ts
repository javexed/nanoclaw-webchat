/**
 * The relay's central half: it must terminate a laptop's tunnel against the
 * gateway AS the session's agent, and must refuse to do so for any session
 * that machine was not given. The credential is the whole point of the hop, so
 * the tests assert both that it is presented and that it cannot be borrowed.
 */
import net from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRunnerEgressForTest, __setRunnerEgressForTest, listBlocked } from './egress-policy.js';
import {
  __resetRelayForTest,
  closeRunnerStreams,
  connectThroughGateway,
  gatewayHostForCentral,
  handleRelayFrame,
  registerRelayTarget,
} from './runner-relay.js';

const sent: Array<{ fingerprint: string; frame: Record<string, unknown> }> = [];
vi.mock('../../onecli-settings.js', () => ({
  onecliSettings: () => ({ gateway: 'onecli', url: 'http://172.17.0.1:10254', apiKey: '' }),
}));
let mcpPort = 3102;
vi.mock('./mcp-relay.js', () => ({ mcpRelayTarget: () => ({ host: '127.0.0.1', port: mcpPort }) }));
vi.mock('./runner-transport.js', () => ({
  sendRunnerFrame: (fingerprint: string, frame: Record<string, unknown>) => {
    sent.push({ fingerprint, frame });
    return true;
  },
}));

const FP = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const key = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };

/** A stand-in for the OneCLI proxy: records the CONNECT it was given, then echoes. */
function fakeGateway(opts: { status?: number } = {}) {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      seen.push(chunk.toString());
      const status = opts.status ?? 200;
      if (status !== 200) {
        socket.end(`HTTP/1.1 ${status} Forbidden\r\n\r\n`);
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
  });
  return {
    seen,
    listen: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
      ),
    close: () => server.close(),
  };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const framesOf = (type: string) => sent.filter((s) => s.frame.type === type).map((s) => s.frame);

let gateway: ReturnType<typeof fakeGateway>;

beforeEach(() => {
  sent.length = 0;
  __resetRelayForTest();
  __resetRunnerEgressForTest();
  __setRunnerEgressForTest({ mode: 'open' }); // the policy has its own tests below
});
afterEach(() => {
  __resetRelayForTest();
  __resetRunnerEgressForTest();
  gateway?.close();
});

describe('relay, central half', () => {
  it('terminates the tunnel at the gateway as the session agent, then pipes both ways', async () => {
    gateway = fakeGateway();
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 's3cret' });

    handleRelayFrame(FP, { type: 'relay.open', streamId: 's1', key, host: 'api.anthropic.com', port: 443 });
    await settle();

    // The gateway saw a CONNECT for the container's target, carrying the agent credential.
    expect(gateway.seen[0]).toContain('CONNECT api.anthropic.com:443 HTTP/1.1');
    expect(gateway.seen[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('x:s3cret').toString('base64')}`);
    expect(framesOf('relay.opened')).toHaveLength(1);

    handleRelayFrame(FP, { type: 'relay.data', streamId: 's1', b64: Buffer.from('ping').toString('base64') });
    await settle();
    const back = framesOf('relay.data').map((f) => Buffer.from(String(f.b64), 'base64').toString());
    expect(back.join('')).toContain('echo:ping');
  });

  it('refuses a stream for a session this machine was not given, and never dials the gateway', async () => {
    gateway = fakeGateway();
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 's3cret' });

    handleRelayFrame(OTHER, { type: 'relay.open', streamId: 's1', key, host: 'api.anthropic.com', port: 443 });
    await settle();

    expect(gateway.seen).toHaveLength(0); // the credential was never presented on its behalf
    expect(framesOf('relay.close')[0]).toMatchObject({ error: expect.stringContaining('not placed on this machine') });
  });

  it('an unknown session, a malformed open, and a gateway refusal each close the stream with a reason', async () => {
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'a', key, host: 'h', port: 443 });
    await settle(10);
    expect(framesOf('relay.close')[0]).toMatchObject({ streamId: 'a', error: 'no relay target for that session' });

    sent.length = 0;
    registerRelayTarget(key, FP, { host: '127.0.0.1', port: 1, username: 'x', password: 'y' });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'b', key, host: '', port: 443 });
    await settle(10);
    expect(framesOf('relay.close')[0]).toMatchObject({ streamId: 'b', error: 'bad relay.open' });

    // A host that passes the allowlist's suffix match but carries a second
    // request line is refused before anything reaches the gateway.
    sent.length = 0;
    handleRelayFrame(FP, {
      type: 'relay.open',
      streamId: 'inj',
      key,
      host: '10.0.0.5:22 HTTP/1.1\r\nX: a.githubusercontent.com',
      port: 443,
    });
    await settle(10);
    expect(framesOf('relay.close')[0]).toMatchObject({ streamId: 'inj', error: 'bad relay.open' });

    sent.length = 0;
    gateway = fakeGateway({ status: 403 });
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 'y' });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'c', key, host: 'blocked.example', port: 443 });
    await settle();
    // The gateway's own verdict (an egress rule) reaches the container as a failed tunnel.
    expect(String(framesOf('relay.close')[0]?.error)).toContain('HTTP 403');
  });

  it('data that arrives while the gateway connection is still opening is held and delivered first, in order', async () => {
    gateway = fakeGateway();
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 'y' });
    // A replayed burst: open immediately followed by data, before central could CONNECT.
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'e1', key, host: 'api.anthropic.com', port: 443 });
    handleRelayFrame(FP, { type: 'relay.data', streamId: 'e1', b64: Buffer.from('CLIENT').toString('base64') });
    handleRelayFrame(FP, { type: 'relay.data', streamId: 'e1', b64: Buffer.from('HELLO').toString('base64') });
    await settle(80);
    const back = framesOf('relay.data')
      .map((f) => Buffer.from(String(f.b64), 'base64').toString())
      .join('');
    expect(back).toContain('echo:CLIENT');
    expect(back.indexOf('CLIENT')).toBeLessThan(back.indexOf('HELLO'));
  });

  it('a stream closed, or whose runner went away, while connecting is never opened', async () => {
    gateway = fakeGateway();
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 'y' });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'c1', key, host: 'api.anthropic.com', port: 443 });
    handleRelayFrame(FP, { type: 'relay.close', streamId: 'c1' });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'c2', key, host: 'api.anthropic.com', port: 443 });
    closeRunnerStreams(FP);
    await settle(80);
    expect(framesOf('relay.opened')).toEqual([]);
  });

  it("reaches central's own MCP relay directly, with no gateway hop and no agent credential", async () => {
    // A plain TCP echo stands in for the MCP relay (it speaks HTTP, not CONNECT).
    const seen: string[] = [];
    const mcp = net.createServer((sock) => {
      sock.on('data', (d) => {
        seen.push(d.toString());
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
      });
    });
    const port = await new Promise<number>((r) =>
      mcp.listen(0, '127.0.0.1', () => r((mcp.address() as net.AddressInfo).port)),
    );
    mcpPort = port;
    gateway = fakeGateway();
    const gwPort = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port: gwPort, username: 'x', password: 's3cret' });
    try {
      handleRelayFrame(FP, { type: 'relay.open', streamId: 'm1', key, host: 'host.docker.internal', port });
      await settle();
      expect(framesOf('relay.opened')).toHaveLength(1);
      expect(gateway.seen).toHaveLength(0); // never dialled, so the agent credential was never presented
      handleRelayFrame(FP, {
        type: 'relay.data',
        streamId: 'm1',
        b64: Buffer.from('POST /relay/s1 HTTP/1.1\r\n\r\n').toString('base64'),
      });
      await settle();
      expect(seen.join('')).toContain('POST /relay/s1');
      const back = framesOf('relay.data')
        .map((f) => Buffer.from(String(f.b64), 'base64').toString())
        .join('');
      expect(back).toContain('200 OK');
    } finally {
      mcp.close();
      mcpPort = 3102;
    }
  });

  it("translates the container's name for the gateway host into central's own", () => {
    expect(gatewayHostForCentral('host.docker.internal')).toBe('172.17.0.1');
    expect(gatewayHostForCentral('host.containers.internal')).toBe('172.17.0.1');
    expect(gatewayHostForCentral('proxy.corp.example')).toBe('proxy.corp.example');
  });
});

describe('relay, network policy', () => {
  it('allowlist mode: the model and listed hosts reach the gateway; anything else is refused with a reason, recorded, never dialled', async () => {
    gateway = fakeGateway();
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 's3cret' });
    __setRunnerEgressForTest({ mode: 'host-only', allowlist: ['registry.npmjs.org', '*.githubusercontent.com'] });

    handleRelayFrame(FP, { type: 'relay.open', streamId: 'm', key, host: 'api.anthropic.com', port: 443 });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'n', key, host: 'registry.npmjs.org', port: 443 });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'g', key, host: 'raw.githubusercontent.com', port: 443 });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'x', key, host: 'paste.example', port: 443 });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'p', key, host: 'registry.npmjs.org', port: 22 });
    await settle(80);

    const dialled = gateway.seen.map((l) => l.split('\r\n')[0]).sort();
    expect(dialled).toEqual([
      'CONNECT api.anthropic.com:443 HTTP/1.1',
      'CONNECT raw.githubusercontent.com:443 HTTP/1.1',
      'CONNECT registry.npmjs.org:443 HTTP/1.1',
    ]);
    const refused = framesOf('relay.close')
      .filter((f) => f.error)
      .map((f) => [f.streamId, String(f.error)]);
    expect(refused).toEqual([
      ['x', expect.stringContaining('paste.example is not on the allowlist')],
      ['p', expect.stringContaining('registry.npmjs.org:22 is not on the allowlist')],
    ]);
    expect(listBlocked().map((b) => [b.host, b.port, b.count])).toEqual([
      ['registry.npmjs.org', 22, 1],
      ['paste.example', 443, 1],
    ]);
  });

  it('model-only mode lets nothing but the model through', async () => {
    gateway = fakeGateway();
    const port = await gateway.listen();
    registerRelayTarget(key, FP, { host: '127.0.0.1', port, username: 'x', password: 's3cret' });
    __setRunnerEgressForTest({ mode: 'none', allowlist: ['registry.npmjs.org'] });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'n', key, host: 'registry.npmjs.org', port: 443 });
    handleRelayFrame(FP, { type: 'relay.open', streamId: 'm', key, host: 'api.anthropic.com', port: 443 });
    await settle(80);
    expect(gateway.seen.map((l) => l.split('\r\n')[0])).toEqual(['CONNECT api.anthropic.com:443 HTTP/1.1']);
    expect(framesOf('relay.close')[0]).toMatchObject({
      streamId: 'n',
      error: expect.stringContaining('only the model'),
    });
  });
});

describe('connectThroughGateway', () => {
  it('refuses an unsafe target before dialling the gateway', async () => {
    const target = { host: '127.0.0.1', port: 1, username: 'x', password: 'y' };
    await expect(connectThroughGateway(target, 'a.example\r\nX: y', 443)).rejects.toThrow('unsafe CONNECT target');
    await expect(connectThroughGateway(target, 'a.example', 0)).rejects.toThrow('unsafe CONNECT target');
  });
});
