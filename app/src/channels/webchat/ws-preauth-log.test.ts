/**
 * Lines logged before a caller is authenticated share one budget a minute, so a
 * scanner choosing new paths (or new anything) cannot flood the log, and the
 * header values it chose are logged clipped.
 */
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../log.js', () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./request-guard.js', () => ({ originAllowed: () => false, hostAllowed: async () => true }));

import { __resetPreAuthLogForTest, clipHeader, logPreAuth, setupWebSocket } from './ws.js';

const refusedLines = () => warn.mock.calls.filter(([msg]) => msg === 'WebSocket upgrade refused');

let server: http.Server;
let port: number;
beforeEach(async () => {
  warn.mockReset();
  __resetPreAuthLogForTest();
  server = http.createServer();
  setupWebSocket(server, { onInbound: vi.fn() }, async () => null);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

/** One cross-origin upgrade on `path`, resolved once the server has answered and hung up. */
function upgrade(path: string, origin = 'http://elsewhere.example'): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let got = '';
    sock.on('data', (d) => (got += d.toString()));
    sock.on('close', () => resolve(got));
    sock.on('error', reject);
    sock.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
  });
}

describe('refused upgrades in the log', () => {
  it('a new path per request no longer buys a new log line each: the budget is global', async () => {
    for (let i = 0; i < 40; i++) expect(await upgrade(`/scan-${i}`)).toMatch(/^HTTP\/1.1 403/);
    expect(refusedLines()).toHaveLength(30);
  });

  it('logs the Host and Origin a caller sent clipped, without control characters', async () => {
    await upgrade('/ws', `http://${'a'.repeat(300)}.example`);
    const fields = refusedLines()[0][1] as Record<string, string>;
    expect(fields.origin).toHaveLength(100);
    expect(clipHeader('evil\u001b[31m\u0007 host')).toBe('evil[31m host');
  });
});

describe('the pre-auth log budget', () => {
  it('logs up to the budget a minute, then one summary of what it held back', () => {
    for (let i = 0; i < 45; i++) logPreAuth('refused', { i }, 1_000_000 + i);
    expect(warn.mock.calls.filter(([m]) => m === 'refused')).toHaveLength(30);
    expect(warn).not.toHaveBeenCalledWith('Pre-auth log lines suppressed', expect.anything());
    logPreAuth('refused', { i: 'next minute' }, 1_000_000 + 60_000);
    expect(warn).toHaveBeenCalledWith('Pre-auth log lines suppressed', { suppressed: 15 });
    expect(warn).toHaveBeenLastCalledWith('refused', { i: 'next minute' });
  });

  it('says what it held back once the minute is out, even when nothing else arrives', () => {
    vi.useFakeTimers({ now: 5_000_000 });
    try {
      for (let i = 0; i < 31; i++) logPreAuth('refused', { i });
      expect(warn).toHaveBeenCalledTimes(30);
      vi.advanceTimersByTime(60_000);
      expect(warn).toHaveBeenLastCalledWith('Pre-auth log lines suppressed', { suppressed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
