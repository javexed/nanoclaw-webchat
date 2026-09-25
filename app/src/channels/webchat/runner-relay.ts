/**
 * The relay's central half.
 *
 * A container placed on a laptop holds no credential and has no route to the
 * gateway: central stripped the proxy URL during transit and left a sentinel.
 * The runner substitutes its own local port, so the container's proxy traffic
 * arrives here as streams, and central terminates each one against the OneCLI
 * gateway **adding the agent's token**. The key therefore exists only on
 * central, and OneCLI's host/path rules apply unchanged. Before any of that,
 * the group's network mode decides whether the destination may be reached at
 * all (egress-policy.ts) — the gateway itself would go anywhere.
 *
 * Frames (both directions over the runner socket):
 *   runner  → central   relay.open  { streamId, key, host, port }
 *                       relay.data  { streamId, b64 }
 *                       relay.close { streamId, error? }
 *   central → runner    relay.opened{ streamId }
 *                       relay.data  { streamId, b64 }
 *                       relay.close { streamId, error? }
 *
 * A runner may only open a stream for a session THIS central placed on it: the
 * target registry is keyed by session and records the fingerprint it was
 * placed on. Without that check a paired machine could borrow another
 * machine's agent credential by naming its session.
 */
import net from 'net';

import { audit } from '../../audit.js';
import type { SessionKey } from '../../drivers/types.js';
import { log } from '../../log.js';
import { onecliSettings } from '../../onecli-settings.js';

import {
  allowlistFor,
  blockedMessage,
  egressAllowed,
  groupEgressMode,
  isSafeEgressHost,
  modelHostsFor,
  recordBlocked,
} from './egress-policy.js';

import { mailboxEndpointTarget, MAILBOX_ENDPOINT_PORT } from './runner-mailbox-endpoint.js';
import { mcpRelayTarget } from './mcp-relay.js';
import { sendRunnerFrame } from './runner-transport.js';

export interface RelayTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** How much a single stream may carry before central closes it, and how long it may idle. */
const MAX_STREAM_BYTES = 512 * 1024 * 1024;
const IDLE_MS = 10 * 60 * 1000;
const MAX_STREAMS_PER_RUNNER = 64;
const CONNECT_TIMEOUT_MS = 20_000;

interface Stream {
  fingerprint: string;
  socket: net.Socket;
  bytes: number;
}

const targets = new Map<string, { fingerprint: string; target: RelayTarget }>();
const streams = new Map<string, Stream>();
/** Streams whose gateway connection is in flight, with the data that arrived too early for it. */
const opening = new Map<string, Buffer[]>();
let lateDropLogAt = 0;
function droppedLate(fingerprint: string, id: string): void {
  const now = Date.now();
  if (now - lateDropLogAt < 10_000) return; // one line per ten seconds is plenty
  lateDropLogAt = now;
  log.info('Relay: data for an unknown stream dropped', { fingerprint: fingerprint.slice(0, 12), streamId: id });
}

const keyId = (k: SessionKey): string => `${k.installSlug} ${k.agentGroupId} ${k.sessionId}`;
const streamId = (fingerprint: string, id: string): string => `${fingerprint}:${id}`;

/** Called when a session is realized on a runner: where its tunnels terminate, and as whom. */
export function registerRelayTarget(key: SessionKey, fingerprint: string, target: RelayTarget | null): void {
  if (!target) {
    targets.delete(keyId(key));
    return;
  }
  targets.set(keyId(key), { fingerprint, target });
}

export function clearRelayTarget(key: SessionKey): void {
  targets.delete(keyId(key));
}

/** Drop every stream a runner owns — its socket went away, so nothing can be delivered. */
export function closeRunnerStreams(fingerprint: string): void {
  for (const sid of opening.keys()) if (sid.startsWith(`${fingerprint}:`)) opening.delete(sid);
  for (const [id, s] of streams) {
    if (s.fingerprint !== fingerprint) continue;
    s.socket.destroy();
    streams.delete(id);
  }
}

export function __resetRelayForTest(): void {
  opening.clear();
  for (const s of streams.values()) s.socket.destroy();
  streams.clear();
  targets.clear();
}

/** Route a relay frame. Returns true when the frame belonged to the relay. */
export function handleRelayFrame(fingerprint: string, frame: Record<string, unknown>): boolean {
  switch (frame.type) {
    case 'relay.open':
      void openStream(fingerprint, frame);
      return true;
    case 'relay.data': {
      const sid = streamId(fingerprint, String(frame.streamId));
      const s = streams.get(sid);
      if (!s) {
        // The stream may still be connecting to the gateway (open is async).
        // Bytes that arrive meanwhile — a burst replayed after a re-attach —
        // belong to it and must wait, not vanish: dropping them left the
        // gateway with half a TLS handshake.
        const early = opening.get(sid);
        if (early) early.push(Buffer.from(String(frame.b64 ?? ''), 'base64'));
        else droppedLate(fingerprint, String(frame.streamId));
        return true;
      }
      const chunk = Buffer.from(String(frame.b64 ?? ''), 'base64');
      s.bytes += chunk.length;
      if (s.bytes > MAX_STREAM_BYTES) {
        closeStream(fingerprint, String(frame.streamId), 'stream exceeded its byte budget');
        return true;
      }
      s.socket.write(chunk);
      return true;
    }
    case 'relay.close':
      closeStream(fingerprint, String(frame.streamId));
      return true;
    default:
      return false;
  }
}

async function openStream(fingerprint: string, frame: Record<string, unknown>): Promise<void> {
  const id = String(frame.streamId ?? '');
  const host = String(frame.host ?? '');
  const port = Number(frame.port ?? 0);
  const key = frame.key as SessionKey | undefined;
  const refuse = (reason: string): void => {
    sendRunnerFrame(fingerprint, { type: 'relay.close', streamId: id, error: reason });
  };
  if (!id || !isSafeEgressHost(host) || !Number.isInteger(port) || port <= 0 || port > 65535)
    return refuse('bad relay.open');
  if (!key || typeof key.agentGroupId !== 'string' || typeof key.sessionId !== 'string')
    return refuse('bad session key');

  const entry = targets.get(keyId(key));
  if (!entry) return refuse('no relay target for that session');
  if (entry.fingerprint !== fingerprint) {
    // A machine naming another machine's session would otherwise borrow its
    // agent credential. Audited: this is an attempt to act as someone else.
    audit({
      type: 'runner.relay.refused',
      actor: `machine:${fingerprint}`,
      effect: 'deny',
      detail: { reason: 'session-not-placed-here', agentGroupId: key.agentGroupId, sessionId: key.sessionId },
    });
    return refuse('that session is not placed on this machine');
  }
  const mine = [...streams.values()].filter((s) => s.fingerprint === fingerprint).length;
  if (mine >= MAX_STREAMS_PER_RUNNER) return refuse('too many open streams');

  // Central's own MCP relay is a destination in its own right: it is already
  // token-gated per (group, server) and injects the real credential itself,
  // so it is reached directly rather than through the egress gateway. Every
  // other destination goes out as this session's agent — if its policy allows.
  const internal = centralService(host, port);
  const sid = streamId(fingerprint, id);
  opening.set(sid, []); // before any await: frames arriving meanwhile are held, not dropped
  if (!internal) {
    const mode = await groupEgressMode(key.agentGroupId);
    if (!egressAllowed(mode, host, port, await allowlistFor(key.agentGroupId), await modelHostsFor(key.agentGroupId))) {
      opening.delete(sid);
      recordBlocked(host, port, key.agentGroupId, key.sessionId, mode);
      return refuse(blockedMessage(host, port, mode));
    }
  }

  let socket: net.Socket;
  try {
    socket = internal ? await connectDirect(internal) : await connectThroughGateway(entry.target, host, port);
  } catch (err) {
    opening.delete(sid);
    log.warn('Relay: gateway CONNECT failed', {
      agentGroupId: key.agentGroupId,
      sessionId: key.sessionId,
      target: `${host}:${port}`,
      err,
    });
    return refuse(err instanceof Error ? err.message : 'gateway refused the tunnel');
  }
  if (!opening.has(sid)) {
    // Closed by the runner, or the runner went away, while we were connecting.
    socket.destroy();
    return;
  }
  if (!streams.has(sid)) streams.set(sid, { fingerprint, socket, bytes: 0 });
  // Whatever arrived while we were connecting goes first, in order.
  const early = opening.get(sid) ?? [];
  opening.delete(sid);
  for (const chunk of early) {
    streams.get(sid)!.bytes += chunk.length;
    socket.write(chunk);
  }

  socket.setTimeout(IDLE_MS, () => closeStream(fingerprint, id, 'idle'));
  socket.on('data', (chunk: Buffer) =>
    sendRunnerFrame(fingerprint, { type: 'relay.data', streamId: id, b64: chunk.toString('base64') }),
  );
  socket.on('error', (err) => closeStream(fingerprint, id, err.message));
  socket.on('close', () => closeStream(fingerprint, id));
  sendRunnerFrame(fingerprint, { type: 'relay.opened', streamId: id });
}

function closeStream(fingerprint: string, id: string, error?: string): void {
  const sid = streamId(fingerprint, id);
  opening.delete(sid);
  const s = streams.get(sid);
  if (s) {
    streams.delete(sid);
    s.socket.destroy();
  }
  sendRunnerFrame(fingerprint, { type: 'relay.close', streamId: id, ...(error ? { error } : {}) });
}

/**
 * Open a tunnel through the gateway as the session's agent. The credential is
 * applied here and nowhere else — it is never written into a spec, a frame, or
 * a log line.
 */
/**
 * The spec names the gateway the way a CONTAINER reaches it (`host.docker.internal`);
 * this process is not a container and cannot resolve that. Central reaches the
 * same gateway at the address ONECLI_URL is configured with.
 */
export function gatewayHostForCentral(host: string): string {
  if (host !== 'host.docker.internal' && host !== 'host.containers.internal') return host;
  // A gateway the container reaches as "the host" is a port on central's own
  // machine. OneCLI may be bound to a specific address (ONECLI_URL); any other
  // gateway, or OneCLI without a URL, is reached on loopback.
  const { gateway, url } = onecliSettings();
  if (gateway === 'onecli' && url) {
    try {
      return new URL(url).hostname || '127.0.0.1';
    } catch {
      /* fall through */
    }
  }
  return '127.0.0.1';
}

/**
 * Central's own services, which a container addresses exactly as a local agent
 * does. They are reached directly: each authenticates the caller itself (the
 * MCP relay by its per-(group,server) token, the mailbox by its per-session
 * token), so the agent's egress credential is neither needed nor presented.
 */
function centralService(host: string, port: number): { host: string; port: number } | null {
  if (host !== 'host.docker.internal' && host !== 'host.containers.internal') return null;
  if (port === mcpRelayTarget().port) return mcpRelayTarget();
  if (port === MAILBOX_ENDPOINT_PORT) return mailboxEndpointTarget();
  return null;
}

function connectDirect(target: { host: string; port: number }): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the MCP relay did not accept a connection in time'));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export function connectThroughGateway(target: RelayTarget, host: string, port: number): Promise<net.Socket> {
  if (!isSafeEgressHost(host) || !Number.isInteger(port) || port <= 0 || port > 65535)
    return Promise.reject(new Error('refusing an unsafe CONNECT target'));
  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: gatewayHostForCentral(target.host), port: target.port });
    const fail = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('gateway did not answer CONNECT in time')), CONNECT_TIMEOUT_MS);
    socket.once('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    socket.once('connect', () => {
      const auth = Buffer.from(`${target.username}:${target.password}`).toString('base64');
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    let preamble = '';
    const onData = (chunk: Buffer): void => {
      preamble += chunk.toString('latin1');
      const end = preamble.indexOf('\r\n\r\n');
      if (end === -1) {
        if (preamble.length > 16 * 1024) fail(new Error('gateway sent no CONNECT response'));
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(preamble)?.[1] ?? 0);
      if (status !== 200) {
        // The gateway's own refusal (a blocked host, a rate limit, a bad
        // token). Report the status, never the body — it may echo the request.
        return fail(new Error(`gateway refused the tunnel (HTTP ${status || 'malformed'})`));
      }
      // Anything the gateway already sent past the header belongs to the tunnel.
      const rest = Buffer.from(preamble.slice(end + 4), 'latin1');
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}
