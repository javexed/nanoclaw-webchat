/**
 * The syslog forwarder, tested against REAL sockets — a UDP listener and a
 * TCP server bound to ephemeral ports — because the contract is wire-shaped:
 * RFC 5424 fields in order, RFC 6587 octet-counting on streams, and a down
 * collector that costs drops (counted) rather than exceptions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dgram from 'dgram';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { audit } from '../../audit.js';
import {
  configureSyslog,
  formatRfc5424,
  frameOctetCounted,
  getSyslogStatus,
  parseSyslogTarget,
  severityFor,
} from './audit-syslog.js';

const SCRATCH: string[] = [];
beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-syslog-'));
  SCRATCH.push(dir);
  vi.stubEnv('NANOCLAW_AUDIT_FILE', path.join(dir, 'audit.jsonl'));
});
afterEach(async () => {
  configureSyslog(''); // tear down sockets between tests
  vi.unstubAllEnvs();
  for (const d of SCRATCH.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseSyslogTarget', () => {
  it('accepts the three schemes with explicit ports', async () => {
    expect(parseSyslogTarget('udp://collector:514')).toEqual({ scheme: 'udp', host: 'collector', port: 514 });
    expect(parseSyslogTarget('tcp://10.0.0.5:601')).toEqual({ scheme: 'tcp', host: '10.0.0.5', port: 601 });
    expect(parseSyslogTarget('tls://siem.example.com:6514')).toEqual({
      scheme: 'tls',
      host: 'siem.example.com',
      port: 6514,
    });
  });

  it('rejects everything else', async () => {
    for (const bad of [
      '',
      'collector:514', // no scheme
      'http://collector:514', // wrong scheme
      'udp://collector', // no port — a silent wrong default is a forwarder into a void
      'udp://:514',
      'udp://collector:514/path',
      'udp://user@collector:514',
      'udp://collector:514?x=1',
      'udp://collector:99999',
      'not a url',
    ]) {
      expect(parseSyslogTarget(bad), bad).toBeNull();
    }
  });
});

describe('RFC 5424 formatting', () => {
  it('maps refusals and failures to warning, the rest to informational', async () => {
    expect(severityFor({ type: 't', effect: 'deny' })).toBe(4);
    expect(severityFor({ type: 't', effect: 'failed' })).toBe(4);
    expect(severityFor({ type: 't', effect: 'allow' })).toBe(6);
    expect(severityFor({ type: 't' })).toBe(6);
  });

  it('emits facility 13 (log audit) with the event type as MSGID', async () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const msg = formatRfc5424('{"a":1}', { type: 'role.grant', effect: 'granted' }, now);
    // 13*8+6 = 110
    expect(msg.startsWith('<110>1 2026-08-15T12:00:00.000Z ')).toBe(true);
    expect(msg).toContain(' nanoclaw-audit ');
    expect(msg).toContain(' role.grant - {"a":1}');
  });

  it('octet-counts by BYTES, not characters', async () => {
    const msg = 'héllo'; // 6 bytes, 5 chars
    expect(frameOctetCounted(msg)).toBe('6 héllo');
  });
});

describe('UDP delivery', () => {
  it('ships each audited event as one RFC 5424 datagram', async () => {
    const sock = dgram.createSocket('udp4');
    const got: string[] = [];
    sock.on('message', (m) => got.push(m.toString('utf8')));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    const port = (sock.address() as { port: number }).port;

    expect(configureSyslog(`udp://127.0.0.1:${port}`)).toBe(true);
    audit({ type: 'guard.decision', actor: 'human:webchat:probe', effect: 'deny', reason: 'nope' });

    await vi.waitFor(() => expect(got).toHaveLength(1));
    // Warning severity: 13*8+4 = 108. The JSON line rides as MSG.
    expect(got[0]).toMatch(/^<108>1 /);
    expect(got[0]).toContain('"actor":"human:webchat:probe"');
    const st = getSyslogStatus();
    expect(st.sentCount).toBe(1);
    expect(st.lastSentAt).not.toBeNull();
    sock.close();
  });
});

describe('TCP delivery', () => {
  it('frames with octet counting and reports delivery in the status', async () => {
    const chunks: Buffer[] = [];
    const server = net.createServer((c) => c.on('data', (d) => chunks.push(d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    expect(configureSyslog(`tcp://127.0.0.1:${port}`)).toBe(true);
    // DELTA against the baseline: status counters are process-global and the
    // UDP test's success would otherwise satisfy this check instantly, while
    // this test's socket is still mid-handshake — a pass that proves nothing.
    const base = getSyslogStatus().sentCount;
    // First event races the connect handshake and may be dropped by design;
    // waitFor keeps emitting until one lands.
    await vi.waitFor(
      () => {
        audit({ type: 'auth.session', effect: 'allow' });
        expect(getSyslogStatus().sentCount).toBeGreaterThan(base);
      },
      { timeout: 4000, interval: 100 },
    );
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBeGreaterThan(0));

    const wire = Buffer.concat(chunks).toString('utf8');
    // "N <PRI>1 ..." and N counts the message's bytes exactly.
    const m = wire.match(/^(\d+) (<\d+>1 .*)$/s);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(Buffer.byteLength(m![2].slice(0, Number(m![1])), 'utf8'));
    server.close();
  });

  it('a down collector costs counted drops, never an exception', async () => {
    // Grab a port that is genuinely closed: bind, note, close.
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const deadPort = (tmp.address() as net.AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));

    expect(configureSyslog(`tcp://127.0.0.1:${deadPort}`)).toBe(true);
    const before = getSyslogStatus().droppedCount;
    expect(() => {
      audit({ type: 'auth.session' });
      audit({ type: 'auth.session' });
    }).not.toThrow();
    expect(getSyslogStatus().droppedCount).toBeGreaterThan(before);
  });
});

describe('configureSyslog', () => {
  it('refuses a malformed target and leaves the previous forwarder running', async () => {
    const sock = dgram.createSocket('udp4');
    const got: string[] = [];
    sock.on('message', (m) => got.push(m.toString('utf8')));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    const port = (sock.address() as { port: number }).port;

    expect(configureSyslog(`udp://127.0.0.1:${port}`)).toBe(true);
    // A typo must not turn forwarding off.
    expect(configureSyslog('udp://typo')).toBe(false);
    audit({ type: 'auth.session' });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(getSyslogStatus().target).toBe(`udp://127.0.0.1:${port}`);
    sock.close();
  });

  it("'' disables forwarding and clears the target", async () => {
    expect(configureSyslog('')).toBe(true);
    expect(getSyslogStatus().target).toBeNull();
    // No sink: audited events only reach the file.
    expect(() => audit({ type: 'auth.session' })).not.toThrow();
  });
});
