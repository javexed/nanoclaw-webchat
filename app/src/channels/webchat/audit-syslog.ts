/**
 * Syslog forwarding for the audit log — RFC 5424 over UDP, TCP or TLS.
 *
 * This is the FORWARDER, not the record. logs/audit.jsonl (src/audit.ts) is
 * the always-on floor; this ships a copy of each line to a collector, because
 * off-box delivery is the only tamper resistance any of this has — an actor
 * who owns the box can edit the local file, but not the copy that already
 * left. Delivery is best-effort by design: a down collector drops events
 * (counted, surfaced in the health status) rather than blocking or buffering
 * unboundedly. The floor never drops.
 *
 * Targets are URLs: udp://host:514, tcp://host:601, tls://host:6514.
 * TLS verifies the collector's certificate — there is deliberately no
 * "insecure" switch. An audit trail delivered over an unverified channel to
 * an unauthenticated endpoint is theater; use tcp:// inside a trusted
 * network instead and say so.
 *
 * Framing: RFC 5424 message, octet-counted per RFC 6587 on stream
 * transports ("123 <134>1 ..."), bare datagram on UDP. Facility 13 — the
 * RFC's "log audit" facility, which is exactly what this is. Severity maps
 * from the event's effect: refusals and failures are warnings, the rest
 * informational.
 *
 * No dependency: dgram/net/tls are Node builtins and the whole protocol fits
 * in a screen of code. A syslog library would be the largest new attack
 * surface in this file's blast radius, guarding the audit trail with it.
 */
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import tls from 'tls';

import { setAuditSinks, type AuditEvent } from '../../audit.js';
import { log } from '../../log.js';

export interface SyslogTarget {
  scheme: 'udp' | 'tcp' | 'tls';
  host: string;
  port: number;
}

export interface SyslogStatus {
  target: string | null;
  /** Last time a message was handed to the transport successfully. For UDP
   *  this means "sent" — datagrams carry no delivery confirmation. */
  lastSentAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  sentCount: number;
  droppedCount: number;
}

/** Parse and validate a target URL. Returns null for anything malformed. */
export function parseSyslogTarget(raw: string): SyslogTarget | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'udp' && scheme !== 'tcp' && scheme !== 'tls') return null;
  if (!url.hostname) return null;
  // No default port on purpose: 514/601/6514 differ per transport and a wrong
  // silent default is a forwarder that "works" into a void. Make it explicit.
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // A path/user/query smells like a pasted HTTP URL, not a syslog endpoint.
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.username || url.search) return null;
  return { scheme, host: url.hostname, port };
}

const FACILITY_LOG_AUDIT = 13;

/** RFC 5424 severity from the event's outcome. */
export function severityFor(event: AuditEvent): number {
  return event.effect === 'deny' || event.effect === 'failed' ? 4 /* warning */ : 6 /* informational */;
}

/** One RFC 5424 message. MSGID is the event type, SD is nil, MSG the JSON line. */
export function formatRfc5424(line: string, event: AuditEvent, now = new Date()): string {
  const pri = FACILITY_LOG_AUDIT * 8 + severityFor(event);
  const msgid = (event.type || '-').slice(0, 32);
  return `<${pri}>1 ${now.toISOString()} ${os.hostname()} nanoclaw-audit ${process.pid} ${msgid} - ${line}`;
}

/** RFC 6587 octet-counting frame for stream transports. */
export function frameOctetCounted(msg: string): string {
  const bytes = Buffer.byteLength(msg, 'utf8');
  return `${bytes} ${msg}`;
}

// ── Live forwarder state (one per process, matching the single sink slot) ──

let current: {
  target: SyslogTarget;
  raw: string;
  udp?: dgram.Socket;
  stream?: net.Socket | tls.TLSSocket;
  streamUp: boolean;
  lastAttemptAt: number;
} | null = null;

const status: SyslogStatus = {
  target: null,
  lastSentAt: null,
  lastErrorAt: null,
  lastError: null,
  sentCount: 0,
  droppedCount: 0,
};

export function getSyslogStatus(): SyslogStatus {
  return { ...status };
}

function noteError(err: unknown): void {
  status.lastErrorAt = new Date().toISOString();
  status.lastError = err instanceof Error ? err.message : String(err);
}

function noteSent(): void {
  status.sentCount++;
  status.lastSentAt = new Date().toISOString();
}

/** Reconnect no more than once per 5s — a dead collector must cost one
 *  socket attempt per window, not one per audited event. */
const RECONNECT_MIN_MS = 5_000;

function ensureStream(c: NonNullable<typeof current>): net.Socket | tls.TLSSocket | null {
  if (c.stream && c.streamUp) return c.stream;
  if (Date.now() - c.lastAttemptAt < RECONNECT_MIN_MS) return null;
  c.lastAttemptAt = Date.now();
  try {
    c.stream?.destroy();
    const sock =
      c.target.scheme === 'tls'
        ? tls.connect({ host: c.target.host, port: c.target.port })
        : net.connect({ host: c.target.host, port: c.target.port });
    sock.setNoDelay(true);
    c.streamUp = false;
    sock.on(c.target.scheme === 'tls' ? 'secureConnect' : 'connect', () => {
      c.streamUp = true;
    });
    sock.on('error', (err) => {
      c.streamUp = false;
      noteError(err);
    });
    sock.on('close', () => {
      c.streamUp = false;
    });
    c.stream = sock;
    // Not up until the handshake completes; this event is dropped, counted.
    return null;
  } catch (err) {
    noteError(err);
    return null;
  }
}

function deliver(line: string, event: AuditEvent): void {
  const c = current;
  if (!c) return;
  const msg = formatRfc5424(line, event);
  if (c.target.scheme === 'udp') {
    if (!c.udp) c.udp = dgram.createSocket('udp4');
    c.udp.send(Buffer.from(msg, 'utf8'), c.target.port, c.target.host, (err) => {
      if (err) {
        status.droppedCount++;
        noteError(err);
      } else {
        noteSent();
      }
    });
    return;
  }
  const sock = ensureStream(c);
  if (!sock) {
    status.droppedCount++;
    return;
  }
  try {
    sock.write(frameOctetCounted(msg), (err) => {
      if (err) {
        status.droppedCount++;
        noteError(err);
      } else {
        noteSent();
      }
    });
  } catch (err) {
    status.droppedCount++;
    noteError(err);
  }
}

function teardown(): void {
  if (!current) return;
  try {
    current.udp?.close();
  } catch {
    /* already closed */
  }
  try {
    current.stream?.destroy();
  } catch {
    /* already gone */
  }
  current = null;
}

/**
 * Apply a target ('' disables). Returns false for a malformed target, leaving
 * the previous forwarder untouched — a typo must not silently turn
 * forwarding OFF.
 */
export function configureSyslog(rawTarget: string): boolean {
  const trimmed = (rawTarget || '').trim();
  if (!trimmed) {
    teardown();
    status.target = null;
    setAuditSinks([]);
    return true;
  }
  const target = parseSyslogTarget(trimmed);
  if (!target) return false;
  teardown();
  current = { target, raw: trimmed, streamUp: false, lastAttemptAt: 0 };
  status.target = trimmed;
  setAuditSinks([deliver]);
  log.info('audit: syslog forwarding configured', { target: trimmed });
  return true;
}
