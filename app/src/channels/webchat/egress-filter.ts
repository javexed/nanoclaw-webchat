/**
 * Central's egress filter for local agents.
 *
 * A local agent set to Allowlist or Model only runs on the internal lockdown
 * network (no route out). Its proxy URL names `host.docker.internal:<gateway
 * port>`, and on that network the name resolves to the network's host-side
 * bridge address, where this filter listens. The filter:
 *
 *   1. knows which agent is calling from the connection's source address —
 *      the container's own address on that network, mapped to the container
 *      and so to its session and group (never from a token: with per-member
 *      credentials one identity spans several groups);
 *   2. applies that group's policy (egress-policy.ts);
 *   3. forwards what is allowed to the OneCLI gateway with the credential the
 *      container presented, so the gateway still injects secrets and applies
 *      its own rules; refuses the rest with a 403 that names the host.
 *
 * Central's own services on `host.docker.internal` (the MCP relay) are passed
 * straight through on their own ports; models, host-local or on another
 * machine (model-relay.ts), on theirs, per caller. The OneCLI gateway is NOT
 * on the lockdown network: this filter is the only way out.
 */
import { execFile } from 'child_process';
import dns from 'dns/promises';
import net from 'net';
import type { Duplex } from 'stream';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';

import {
  allowlistFor,
  blockedMessage,
  directAddressAllowed,
  directTunnel,
  egressAllowed,
  getRunnerEgressAllowlist,
  groupEgressMode,
  hostOwnAddresses,
  isSafeEgressHost,
  modelHostsFor,
  ownModelTargetsFor,
  recordBlocked,
  type EgressMode,
} from './egress-policy.js';
import { keyTargetFor } from './egress-key-targets.js';
import { connectThroughGateway, connectToGateway } from './gateway-connect.js';
import { serveOllamaFiltered } from './ollama-filter.js';
import { noteBuildRefusal } from './build-refusals.js';
import { workloadTunnel } from './workload-tunnel.js';

const MAX_HEAD = 64 * 1024;
const IP_MAP_TTL_MS = 2_000;

export interface Caller {
  agentGroupId: string;
  sessionId: string;
}

export interface EgressFilterDeps {
  /** Which agent is calling from this address on the lockdown network, or null. */
  identify: (remoteAddress: string) => Promise<Caller | null>;
  /** Where the OneCLI gateway listens, as central reaches it. */
  gateway: () => { host: string; port: number };
  mode: (agentGroupId: string) => Promise<EgressMode>;
  allowlist: (agentGroupId: string) => Promise<string[]>;
  /** What this agent may always reach (its model's host on top of the provider floor); default: the floor only. */
  always?: (agentGroupId: string) => Promise<string[]>;
  /** This agent's own model on another machine, as host:port; default: none. */
  ownModels?: (agentGroupId: string) => Promise<string[]>;
  /** Open a direct tunnel (directTunnel in egress-policy.ts); default: a TCP connection from here. */
  direct?: (host: string, port: number, pinned?: string) => Promise<net.Socket>;
  /** The install allowlist alone, which direct tunnels need (global admins); default: none, so no direct tunnels. */
  installAllowlist?: () => Promise<string[]>;
  /** This agent's own private service addresses as CIDRs (its workload stacks), dialled directly; default: none. */
  ownNetworks?: (agentGroupId: string) => Promise<string[]>;
  /** Registries this agent's builds may reach on top of its own policy (an owner's opt-in); default: none. */
  buildRegistries?: (agentGroupId: string) => Promise<string[]>;
}

/**
 * Where an agent's own networks come from: a module that gives an agent a
 * private network (workloads) registers here, so the filter does not import it.
 * The container is already on that network; this only lets its proxy client
 * reach it too, since HTTP clients send everything to the proxy.
 */
const ownNetworkResolvers: Array<(agentGroupId: string) => Promise<string[]>> = [];
export function registerOwnNetworks(fn: (agentGroupId: string) => Promise<string[]>): void {
  ownNetworkResolvers.push(fn);
}
async function ownNetworksFor(agentGroupId: string): Promise<string[]> {
  const out: string[] = [];
  for (const fn of ownNetworkResolvers) out.push(...(await fn(agentGroupId).catch(() => [])));
  return out;
}

/**
 * An agent's workload builder (modules/workloads/builder.ts) is registered
 * under this session id. Its traffic is held to the agent's policy like the
 * agent's own, plus only the registries an owner opted this agent into
 * (registerBuildRegistries) — there is no install-wide registry list, since
 * a registry a build can pull from is one it can push to. It never goes
 * through the credential gateway (a build gets no secrets injected) and
 * connects directly, refusing this machine and private addresses
 * (connectDirect); it never reaches the agent's own workload addresses.
 */
export const BUILD_SESSION = 'workload-build';
const buildRegistryResolvers: Array<(agentGroupId: string) => Promise<string[]>> = [];
export function registerBuildRegistries(fn: (agentGroupId: string) => Promise<string[]>): void {
  buildRegistryResolvers.push(fn);
}
async function buildRegistriesFor(agentGroupId: string): Promise<string[]> {
  const out: string[] = [];
  for (const fn of buildRegistryResolvers) out.push(...(await fn(agentGroupId).catch(() => [])));
  return out;
}

/** A build's refusal: where a person turns it on (Agent → Apps), not a host command. */
function buildBlockedMessage(host: string, port: number): string {
  const where = port === 443 || port === 80 ? host : `${host}:${port}`;
  return `blocked by NanoClaw network policy: this build may not reach ${where} — an admin can turn on its source under Build sources in Agent → Apps, or allow ${where} on this agent's Network list`;
}

/** Is a literal IPv4 address inside one of these CIDRs? Names never are: no lookup can move them in. */
export function inOwnNetwork(host: string, cidrs: string[]): boolean {
  if (!net.isIPv4(host) || !cidrs.length) return false;
  const list = new net.BlockList();
  let any = false;
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const n = Number(bits);
    if (net.isIPv4(addr) && Number.isInteger(n) && n >= 8 && n <= 32) {
      list.addSubnet(addr, n, 'ipv4');
      any = true;
    }
  }
  return any && list.check(host, 'ipv4');
}

/** Pipe a client to a socket this filter opened itself (no gateway in between). */
export function spliceDirect(client: ProxyClient, req: ParsedRequest, rest: Buffer, upstream: Duplex): void {
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  if (req.kind === 'connect') client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  else upstream.write(req.originHead!);
  if (rest.length) upstream.write(rest);
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
}

/** A model listener: a host-local model's port, or the relay to a model on another machine (`remote`). */
export interface ModelListener {
  port: number;
  target: { host: string; port: number };
  remote?: boolean;
  /** An Ollama server: requests filtered to inference (ollama-filter.ts). */
  ollama?: boolean;
}

const DIRECT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Connect a direct tunnel: resolve the name once, refuse an address a direct
 * tunnel may not reach (directAddressAllowed: this machine, loopback,
 * link-local, and a private address a NAME resolves to — a listed name may
 * point there), and connect to that same address, so a second lookup cannot
 * swap it.
 */
async function connectDirect(host: string, port: number, pinned?: string, privateOk?: boolean): Promise<net.Socket> {
  const bare = host.replace(/^\[|\]$/g, '');
  // Already resolved (ollamaPin): that answer is the one checked, so it is the one dialled.
  const address = pinned ?? (await dns.lookup(bare)).address;
  // A private address: allowed when the caller says so (a deploy key's
  // target), else only when the entry names the address itself.
  if (!directAddressAllowed(address, privateOk ?? net.isIP(bare) !== 0))
    throw new Error(
      `${host} resolves to ${address}, which is not allowed directly (a private address: list the address itself)`,
    );
  return connectTcp(address, port);
}

/** A TCP connection to a literal address, with the direct-connect timeout. */
export function connectTcp(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: address, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timed out'));
    }, DIRECT_CONNECT_TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * One proxied connection: a TCP socket from the lockdown network, or a stream
 * that arrived over a container's exec pipe (exec-relay.ts), which has no
 * address.
 */
export type ProxyClient = Duplex & { remoteAddress?: string };

/** A client that sends no request head within this window is holding a socket, not talking. */
const HEAD_TIMEOUT_MS = 10_000;

/** Answer a proxy client and close. */
export function answer(sock: ProxyClient, status: string, message: string, extra = ''): void {
  const body = `${message}\n`;
  sock.end(
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`,
  );
}

interface ParsedRequest {
  kind: 'connect' | 'absolute';
  host: string;
  port: number;
  /** For an absolute-form request: the request re-written in origin form, proxy headers dropped. */
  originHead?: string;
  /**
   * For an absolute-form request: the head as the gateway is sent it, still
   * absolute-form, proxy and connection headers dropped and `Connection: close`
   * added (the caller adds the credentials). One request per connection: a
   * kept-alive one would carry the next request, to any host, past the check.
   */
  gatewayHead?: string;
  /** Its body's length: Content-Length, 0 without one, null when chunked (streamed, bounded by the close). */
  bodyLength?: number | null;
  username: string;
  password: string;
}

/** Parse a proxy request head (CONNECT, or absolute-form plain HTTP). */
export function parseProxyHead(head: string): ParsedRequest | { error: string; status: string } {
  const lines = head.split('\r\n');
  // Every line ends in CRLF and nothing else. A bare CR or LF inside a line is a
  // header the checks below would not see but a lenient parser downstream would
  // (a hidden Transfer-Encoding, a second request): refuse the request outright.
  if (lines.some((l) => /[\r\n\0]/.test(l))) return { error: 'malformed request head', status: '400 Bad Request' };
  const first = lines[0] ?? '';
  let username = '';
  let password = '';
  const kept: string[] = [];
  for (const l of lines.slice(1)) {
    const m = /^proxy-authorization:\s*basic\s+(\S+)/i.exec(l);
    if (m) {
      const dec = Buffer.from(m[1], 'base64').toString('utf8');
      const i = dec.indexOf(':');
      username = i >= 0 ? dec.slice(0, i) : dec;
      password = i >= 0 ? dec.slice(i + 1) : '';
      continue;
    }
    if (/^proxy-(connection|authorization):/i.test(l)) continue;
    if (l) kept.push(l);
  }
  // A header folded onto a second line, or with space before its colon, is one
  // the checks below would not see but a lenient parser downstream might
  // (RFC 9112 rejects both): refuse it rather than guess.
  if (kept.some((l) => /^[ \t]/.test(l) || /^[^:]*[ \t]:/.test(l)))
    return { error: 'malformed request head', status: '400 Bad Request' };
  const bad = { error: 'bad destination host', status: '400 Bad Request' };
  const connect = /^CONNECT\s+(\[[0-9a-f:.]+\]|[^\s:]+):(\d{1,5})\s+HTTP\/1\.[01]$/i.exec(first);
  if (connect) {
    const host = connect[1].replace(/^\[|\]$/g, '');
    if (!isSafeEgressHost(host)) return bad;
    return { kind: 'connect', host, port: Number(connect[2]), username, password };
  }
  const abs = /^([A-Z]+)\s+http:\/\/([^\s/:]+)(?::(\d{1,5}))?(\/\S*)?\s+(HTTP\/1\.[01])$/i.exec(first);
  if (abs) {
    const [, method, host, port, pathPart, version] = abs;
    if (!isSafeEgressHost(host)) return bad;
    const authority = port ? `${host}:${port}` : host;
    // The policy checked the request line's host, so that is the host the
    // request goes as: the client's own Host header is replaced, never trusted.
    // A Host that disagreed with the checked target could otherwise steer
    // whatever reads it (the gateway choosing a credential, a virtual host)
    // to somewhere the allowlist never approved.
    const headers = [`Host: ${authority}`, ...kept.filter((l) => !/^host:/i.test(l))];
    // One framing, stated once: two Content-Lengths, one that is not a number,
    // or Content-Length beside Transfer-Encoding let this side and the far end
    // disagree on where the body ends — a second request hidden in the first.
    const lengths = headers.filter((l) => /^content-length:/i.test(l));
    const encodings = headers.filter((l) => /^transfer-encoding:/i.test(l));
    const framing = { error: 'ambiguous body length', status: '400 Bad Request' };
    if (lengths.length > 1 || encodings.length > 1 || (lengths.length && encodings.length)) return framing;
    if (lengths.length && !/^content-length:\s*\d+\s*$/i.test(lengths[0])) return framing;
    // Chunked alone. Any other coding ("gzip", "gzip, chunked", "chunked,
    // gzip") leaves the body's end to a decoder this side does not run, and
    // RFC 9112 makes a request whose last coding is not chunked a 400.
    if (encodings.length && !/^transfer-encoding:[ \t]*chunked[ \t]*$/i.test(encodings[0])) return framing;
    const chunked = encodings.length > 0;
    const length = /^content-length:\s*(\d+)\s*$/im.exec(headers.join('\n'));
    const forGateway = headers.filter((l) => !/^connection:/i.test(l));
    return {
      kind: 'absolute',
      host,
      port: port ? Number(port) : 80,
      originHead: `${method} ${pathPart || '/'} ${version}\r\n${headers.join('\r\n')}\r\n\r\n`,
      gatewayHead: `${method} http://${authority}${pathPart || '/'} ${version}\r\n${[...forGateway, 'Connection: close'].join('\r\n')}\r\n`,
      bodyLength: chunked ? null : length ? Number(length[1]) : 0,
      username,
      password,
    };
  }
  return { error: 'this proxy speaks CONNECT and absolute-form HTTP', status: '501 Not Implemented' };
}

/**
 * Read a proxy request's head (up to the blank line), or null: too long, the
 * client went away, or it sent nothing in time. The client is left paused,
 * with whatever followed the head in `rest`.
 */
export async function readProxyHead(client: ProxyClient): Promise<{ head: string; rest: Buffer } | null> {
  let buf = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  const head = await new Promise<{ head: string; rest: Buffer } | null>((resolve) => {
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        client.off('data', onData);
        // Held until a forwarder is attached: the checks below await, and a
        // flowing socket with no listener drops what arrives meanwhile — a
        // plain-HTTP body past its first chunk, so the gateway waited forever
        // for the rest (a resumed Claude session hung for an hour).
        client.pause();
        resolve({ head: buf.subarray(0, end).toString('latin1'), rest: buf.subarray(end + 4) });
      } else if (buf.length > MAX_HEAD) {
        client.off('data', onData);
        resolve(null);
      }
    };
    client.on('data', onData);
    client.once('close', () => resolve(null));
    timer = setTimeout(() => resolve(null), HEAD_TIMEOUT_MS);
  });
  clearTimeout(timer);
  return head;
}

/** Serve one proxied connection from a local agent's container. */
export async function serveProxyClient(client: ProxyClient, deps: EgressFilterDeps): Promise<void> {
  client.on('error', () => {});
  const head = await readProxyHead(client);
  if (!head) return void client.destroy();
  const req = parseProxyHead(head.head);
  if ('error' in req) return answer(client, req.status, req.error);
  if (!req.password)
    return answer(
      client,
      '407 Proxy Authentication Required',
      'proxy credentials required',
      'Proxy-Authenticate: Basic realm="nanoclaw"\r\n',
    );

  const caller = await deps.identify(client.remoteAddress ?? '');
  if (!caller) {
    log.warn('Egress filter: a connection from an unknown address on the lockdown network', {
      remote: client.remoteAddress,
    });
    return answer(
      client,
      '403 Forbidden',
      'blocked by NanoClaw network policy: this container is not known to NanoClaw',
    );
  }
  // On an Ollama port the name is resolved once, here, and every connection
  // below goes to that address: a second lookup (the gateway's, or a direct
  // dial's) could answer with the Ollama server this one did not.
  const ollama = await ollamaPin(req.host, req.port);
  if ('refused' in ollama) {
    log.warn('Egress filter: Ollama refused through the proxy (model port only)', {
      agentGroupId: caller.agentGroupId,
      host: req.host,
      port: req.port,
      reason: ollama.refused,
    });
    return answer(
      client,
      '403 Forbidden',
      ollama.refused === 'unresolved'
        ? `${req.host} could not be resolved`
        : 'Ollama is reachable only through its model port',
    );
  }
  const pinned = ollama.pin ?? undefined;
  /** Where a connection goes: the pinned address when there is one, else the name. */
  const dialHost = pinned ?? req.host;
  const building = caller.sessionId === BUILD_SESSION;
  // The agent's own workload services: on its own network, so dialled directly
  // whatever its policy (they are its own), never through the gateway.
  if (!building && deps.ownNetworks && inOwnNetwork(req.host, await deps.ownNetworks(caller.agentGroupId))) {
    let own: Duplex;
    try {
      // A stack on a worker is reached over that worker's link (workload-tunnel.ts).
      const tunnel = await workloadTunnel(req.host, req.port);
      own = tunnel ? tunnel() : await connectTcp(req.host, req.port);
    } catch (err) {
      return answer(
        client,
        '502 Bad Gateway',
        `could not reach ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
    return spliceDirect(client, req, head.rest, own);
  }
  const mode = await deps.mode(caller.agentGroupId);
  // A deploy key's target, for the agent holding the key (Allowlist mode).
  const keyTarget =
    !building && req.kind === 'connect' && mode === 'host-only'
      ? await keyTargetFor(caller.agentGroupId, req.host, req.port)
      : null;
  if (keyTarget) {
    let upstream: net.Socket;
    try {
      upstream = deps.direct
        ? await deps.direct(req.host, req.port, pinned)
        : await connectDirect(req.host, req.port, pinned, keyTarget.allowPrivate);
    } catch (err) {
      return answer(
        client,
        '502 Bad Gateway',
        `could not reach ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
    log.info('Egress filter: deploy key tunnel', { agentGroupId: caller.agentGroupId, host: req.host, port: req.port });
    return spliceDirect(client, req, head.rest, upstream);
  }
  const alwaysBase = deps.always ? await deps.always(caller.agentGroupId) : undefined;
  const always =
    building && deps.buildRegistries
      ? [...(alwaysBase ?? []), ...(await deps.buildRegistries(caller.agentGroupId))]
      : alwaysBase;
  const allowlist = await deps.allowlist(caller.agentGroupId);
  if (!egressAllowed(mode, req.host, req.port, allowlist, always)) {
    recordBlocked(req.host, req.port, caller.agentGroupId, caller.sessionId, mode);
    const why = building ? buildBlockedMessage(req.host, req.port) : blockedMessage(req.host, req.port, mode);
    // A build's failure says what was blocked (build-refusals.ts): BuildKit shows only "Forbidden".
    if (building) noteBuildRefusal(caller.agentGroupId, req.host, req.port, why);
    return answer(client, '403 Forbidden', why);
  }
  if (building) {
    let upstream: net.Socket;
    try {
      upstream = await (deps.direct ?? connectDirect)(req.host, req.port, pinned);
    } catch (err) {
      const why = String((err as Error).message).slice(0, 200);
      noteBuildRefusal(caller.agentGroupId, req.host, req.port, `could not connect: ${why}`);
      return answer(client, '502 Bad Gateway', `could not reach ${req.host}:${req.port}: ${why}`);
    }
    return spliceDirect(client, req, head.rest, upstream);
  }
  let upstream: net.Socket;
  const install = deps.installAllowlist ? await deps.installAllowlist() : [];
  if (req.kind === 'connect' && directTunnel(mode, req.host, req.port, install)) {
    try {
      upstream = await (deps.direct ?? connectDirect)(req.host, req.port, pinned);
    } catch (err) {
      return answer(
        client,
        '502 Bad Gateway',
        `could not reach ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
    log.info('Egress filter: direct tunnel', { agentGroupId: caller.agentGroupId, host: req.host, port: req.port });
  } else if (req.kind === 'absolute') {
    // Plain HTTP (the router behind the gateway, a package index): sent to the
    // gateway as to any proxy, with the agent's own credentials, so it adds
    // what it holds for that host. One request, then the connection closes.
    try {
      upstream = await connectToGateway(deps.gateway());
    } catch (err) {
      return answer(
        client,
        '502 Bad Gateway',
        `the credential gateway is unreachable: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
    const auth = Buffer.from(`${req.username}:${req.password}`).toString('base64');
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    const gatewayHead = pinned ? pinGatewayHead(req.gatewayHead!, req.host, pinned) : req.gatewayHead!;
    upstream.write(`${gatewayHead}Proxy-Authorization: Basic ${auth}\r\n\r\n`);
    upstream.pipe(client);
    if (req.bodyLength === null || req.bodyLength === undefined) {
      if (head.rest.length) upstream.write(head.rest);
      client.pipe(upstream);
      return;
    }
    // This request's body and nothing after it: a second request on the same
    // connection would reach the gateway unchecked.
    let left = req.bodyLength;
    // A client that goes away mid-body must not leave the gateway waiting on
    // the rest; and a body faster than the gateway drains it waits for the
    // drain instead of piling up in this process.
    client.once('close', () => upstream.destroy());
    const forward = (chunk: Buffer): void => {
      if (left <= 0) return;
      const part = chunk.subarray(0, left);
      left -= part.length;
      if (!upstream.write(part)) {
        client.pause();
        upstream.once('drain', () => client.resume());
      }
    };
    forward(head.rest);
    client.on('data', forward);
    client.resume();
    return;
  } else {
    try {
      const gw = deps.gateway();
      upstream = await connectThroughGateway(
        { host: gw.host, port: gw.port, username: req.username, password: req.password },
        dialHost,
        req.port,
      );
    } catch (err) {
      return answer(
        client,
        '502 Bad Gateway',
        `the credential gateway refused ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
  }
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  if (req.kind === 'connect') client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  else upstream.write(req.originHead!);
  if (head.rest.length) upstream.write(head.rest);
  client.pipe(upstream);
  upstream.pipe(client);
}

// ── listeners ──────────────────────────────────────────────────────────────────

const servers = new Map<string, net.Server>();

function listenOnce(host: string, port: number, onConn: (sock: net.Socket) => void, what: string): void {
  const k = `${host}:${port}`;
  if (servers.has(k)) return;
  const server = net.createServer(onConn);
  server.on('error', (err) => {
    log.error('Egress filter listener failed', { what, host, port, err: String(err) });
    servers.delete(k);
  });
  server.listen(port, host, () => log.info('Egress filter listening', { what, host, port }));
  servers.set(k, server);
}

/** Central's host name as a container on the lockdown network dials it: a host-local model is reached under it. */
const HOST_NAME = 'host.docker.internal';

/**
 * A model's port on the bridge. Unlike central's own services it is NOT for
 * every agent on the network: each connection is identified like a proxied
 * one and held to the caller's policy — its own model, the allowlist where
 * the mode allows it, anything when Open. Otherwise a localhost model added
 * for one agent would be open to every Model-only agent, arriving from
 * 127.0.0.1, which that server may trust. A `remote` port relays to a model
 * on another machine and is checked against that machine.
 */
export async function serveModelPort(
  client: ProxyClient,
  port: number,
  target: { host: string; port: number },
  deps: EgressFilterDeps,
  remote = false,
  ollama = false,
): Promise<void> {
  client.on('error', () => {});
  const caller = await deps.identify(client.remoteAddress ?? '');
  if (!caller) {
    log.warn('Egress filter: a model connection from an unknown address on the lockdown network', {
      remote: client.remoteAddress,
      port,
    });
    return void client.destroy();
  }
  const mode = await deps.mode(caller.agentGroupId);
  const always = deps.always ? await deps.always(caller.agentGroupId) : undefined;
  const [host, checked] = remote ? [target.host, target.port] : [HOST_NAME, port];
  const own = remote && deps.ownModels ? await deps.ownModels(caller.agentGroupId) : [];
  if (
    !own.includes(`${host}:${checked}`) &&
    !egressAllowed(mode, host, checked, await deps.allowlist(caller.agentGroupId), always)
  ) {
    recordBlocked(host, checked, caller.agentGroupId, caller.sessionId, mode);
    return void client.destroy();
  }
  // Ollama has no authentication: inference only, never pull, delete or create.
  if (ollama) {
    serveOllamaFiltered(client, target, (method, path) =>
      log.warn('Egress filter: an Ollama request refused (inference only)', {
        agentGroupId: caller.agentGroupId,
        method,
        path,
        target: `${target.host}:${target.port}`,
      }),
    );
    return;
  }
  const up = net.connect(target);
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
  client.pipe(up);
  up.pipe(client);
}

/**
 * Ollama servers behind a model port (host:port as the host reaches them). The
 * model port filters each request to inference; the general proxy must not be
 * a second, unfiltered way in (pull, delete, create), whatever the agent's
 * egress allows — so it refuses these targets outright.
 */
const ollamaTargets = new Map<string, Array<{ host: string; port: number }>>();

export function __setOllamaTargetsForTest(targets: Array<{ host: string; port: number }>): void {
  ollamaTargets.clear();
  if (targets.length) ollamaTargets.set('test', targets);
}

const LOCAL_NAMES = new Set([HOST_NAME, 'localhost']);
const isLocal = (host: string, own: Set<string>): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_NAMES.has(h) || h === '::1' || h.startsWith('127.') || own.has(h);
};

type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);
let resolveAll: Resolver = systemResolver;

/** Tests: answer lookups from `fn` (null: the system resolver again). */
export function __setResolverForTest(fn: Resolver | null): void {
  resolveAll = fn ?? systemResolver;
}

async function addressesOf(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  try {
    return await resolveAll(host);
  } catch {
    return [];
  }
}

/**
 * Whether a proxy request may go on, for Ollama's sake: refused when it names
 * an Ollama server (by name, by address, or as this host for a local one), or
 * when its port is an Ollama server's and its name does not resolve. Else the
 * address to dial: on an Ollama port a name is resolved here once and the
 * connection pinned to that answer (null: nothing to pin — another port, or a
 * literal address).
 */
export async function ollamaPin(
  host: string,
  port: number,
  targets: Array<{ host: string; port: number }> = [...ollamaTargets.values()].flat(),
  own: Set<string> = hostOwnAddresses(),
): Promise<{ pin: string | null } | { refused: 'ollama' | 'unresolved' }> {
  const same = targets.filter((t) => t.port === port);
  if (!same.length) return { pin: null };
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  for (const t of same) {
    if (t.host.toLowerCase() === h) return { refused: 'ollama' };
    if (isLocal(t.host, own) && isLocal(h, own)) return { refused: 'ollama' };
  }
  const literal = net.isIP(h) !== 0;
  const mine = literal ? [h] : await addressesOf(h);
  if (!mine.length) return { refused: 'unresolved' };
  if (same.some((t) => isLocal(t.host, own)) && mine.some((a) => isLocal(a, own))) return { refused: 'ollama' };
  for (const t of same) {
    const theirs = await addressesOf(t.host);
    if (mine.some((a) => theirs.includes(a))) return { refused: 'ollama' };
  }
  return { pin: literal ? null : mine[0] };
}

/** Whether a proxy request names an Ollama server (see ollamaPin). */
export async function isOllamaTarget(
  host: string,
  port: number,
  targets?: Array<{ host: string; port: number }>,
  own?: Set<string>,
): Promise<boolean> {
  const r = await ollamaPin(host, port, targets, own);
  return 'refused' in r && r.refused === 'ollama';
}

/**
 * The gateway's request head sent to the pinned address: the request line's
 * authority becomes the address, the Host header keeps the name.
 */
function pinGatewayHead(head: string, host: string, pinned: string): string {
  const addr = net.isIPv6(pinned) ? `[${pinned}]` : pinned;
  const end = head.indexOf('\r\n');
  const line = head.slice(0, end).replace(`http://${host}`, `http://${addr}`);
  return line + head.slice(end);
}

/** Model listeners by bridge (port → target), so one whose model was removed or moved is closed at the next spawn. */
const modelPorts = new Map<string, Map<number, string>>();

/**
 * Start (idempotently) the filter on the lockdown network's host address,
 * central's own services passed straight through, and models behind the
 * per-agent check above.
 */
export function ensureEgressFilter(
  bridgeIp: string,
  gatewayPort: number,
  deps: EgressFilterDeps,
  passthrough: Array<{ port: number; target: { host: string; port: number } }> = [],
  models: ModelListener[] = [],
): void {
  listenOnce(bridgeIp, gatewayPort, (sock) => void serveProxyClient(sock, deps).catch(() => sock.destroy()), 'proxy');
  for (const p of passthrough) {
    listenOnce(
      bridgeIp,
      p.port,
      (sock) => {
        const up = net.connect(p.target);
        up.on('error', () => sock.destroy());
        sock.on('error', () => up.destroy());
        sock.pipe(up);
        up.pipe(sock);
      },
      `passthrough:${p.port}`,
    );
  }
  ollamaTargets.set(
    bridgeIp,
    models.filter((m) => m.ollama).map((m) => m.target),
  );
  // Keyed with the Ollama flag too: a port whose filtering changed is reopened.
  const wanted = new Map(models.map((m) => [m.port, `${m.target.host}:${m.target.port}${m.ollama ? ' ollama' : ''}`]));
  const had = modelPorts.get(bridgeIp) ?? new Map<number, string>();
  for (const [port, target] of had) {
    if (wanted.get(port) === target) continue;
    const k = `${bridgeIp}:${port}`;
    servers.get(k)?.close();
    servers.delete(k);
    log.info('Egress filter: closed a model port no model uses any more', { host: bridgeIp, port });
  }
  modelPorts.set(bridgeIp, wanted);
  for (const m of models) {
    listenOnce(
      bridgeIp,
      m.port,
      (sock) => void serveModelPort(sock, m.port, m.target, deps, m.remote, m.ollama).catch(() => sock.destroy()),
      `model:${m.port}`,
    );
  }
}

// ── who is calling ─────────────────────────────────────────────────────────────

/** Containers placed on the lockdown network at spawn, by name — the resolver registers them. */
const byName = new Map<string, Caller>();
/** Per network: source address → container name, re-read at most every IP_MAP_TTL_MS and on a miss. */
const ipMaps = new Map<string, { at: number; map: Map<string, string> }>();

/**
 * Docker's default bridge: an agent in Open mode with a stack on a worker
 * stays there (its own connections unfiltered) but uses this filter as its
 * proxy, so it can reach that stack (container-egress openViaFilter).
 */
export const DEFAULT_BRIDGE = 'bridge';

export function registerFilteredContainer(name: string, caller: Caller): void {
  byName.set(name, caller);
  // A new container may have been handed the address a dead one gave up; the
  // next lookup re-reads the network rather than trusting the cached map.
  ipMaps.clear();
}

function runtime(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(CONTAINER_RUNTIME_BIN, args, { timeout: 10_000 }, (err, out) =>
      err ? reject(err) : resolve(String(out)),
    ),
  );
}

/**
 * Map a source address on the lockdown network to its container, then to the
 * agent. Refreshed at most every two seconds and on a miss, so an address a
 * dead container gave up is re-read rather than trusted.
 */
export function containerIdentifier(network: string): (ip: string, allowRefresh?: boolean) => Promise<Caller | null> {
  return async (ip, allowRefresh = true) => {
    const addr = ip.replace(/^::ffff:/, '');
    const lookup = async (fresh: boolean): Promise<string | undefined> => {
      const cached = ipMaps.get(network);
      if (fresh || !cached || Date.now() - cached.at > IP_MAP_TTL_MS) {
        const out = await runtime([
          'network',
          'inspect',
          network,
          '--format',
          '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}',
        ]).catch(() => '');
        const map = new Map<string, string>();
        for (const pair of out.trim().split(/\s+/)) {
          const [name, cidr] = pair.split('=');
          if (name && cidr) map.set(cidr.split('/')[0], name);
        }
        ipMaps.set(network, { at: Date.now(), map });
      }
      return ipMaps.get(network)!.map.get(addr);
    };
    const name = (await lookup(false)) ?? (allowRefresh ? await lookup(true) : undefined);
    if (!name) return null;
    const known = byName.get(name);
    if (known) return known;
    // A container adopted after a restart was never registered: read its labels.
    const labels = await runtime([
      'inspect',
      '--format',
      '{{index .Config.Labels "nanoclaw-group"}}|{{index .Config.Labels "nanoclaw-session"}}',
      name,
    ]).catch(() => '');
    const [group, session] = labels.trim().split('|');
    if (!group || group === '<no value>') return null;
    const caller = { agentGroupId: group, sessionId: session && session !== '<no value>' ? session : '' };
    byName.set(name, caller);
    return caller;
  };
}

/** The default dependencies: the policy's own readers. */
export function defaultFilterDeps(network: string, gateway: () => { host: string; port: number }): EgressFilterDeps {
  const onNetwork = containerIdentifier(network);
  // An Open agent on the default bridge that uses this filter as its proxy;
  // only containers with NanoClaw's agent labels are known (anything else: null).
  const onBridge = network === DEFAULT_BRIDGE ? null : containerIdentifier(DEFAULT_BRIDGE);
  return {
    // Both cached maps first: a miss on one network re-reads it (a docker call),
    // which a caller on the other must not pay on every connection.
    identify: async (ip) =>
      (await onNetwork(ip, false)) ??
      (onBridge ? await onBridge(ip, false) : null) ??
      (await onNetwork(ip)) ??
      (onBridge ? await onBridge(ip) : null),
    gateway,
    mode: groupEgressMode,
    allowlist: allowlistFor,
    installAllowlist: getRunnerEgressAllowlist,
    always: modelHostsFor,
    ownModels: ownModelTargetsFor,
    ownNetworks: ownNetworksFor,
    buildRegistries: buildRegistriesFor,
  };
}
