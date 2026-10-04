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
  isSafeEgressHost,
  modelHostsFor,
  ownModelTargetsFor,
  recordBlocked,
  type EgressMode,
} from './egress-policy.js';
import { connectThroughGateway } from './gateway-connect.js';
import { serveOllamaFiltered } from './ollama-filter.js';

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
  direct?: (host: string, port: number) => Promise<net.Socket>;
  /** The install allowlist alone, which direct tunnels need (global admins); default: none, so no direct tunnels. */
  installAllowlist?: () => Promise<string[]>;
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
async function connectDirect(host: string, port: number): Promise<net.Socket> {
  const bare = host.replace(/^\[|\]$/g, '');
  const { address } = await dns.lookup(bare);
  if (!directAddressAllowed(address, net.isIP(bare) !== 0))
    throw new Error(
      `${host} resolves to ${address}, which is not allowed directly (a private address: list the address itself)`,
    );
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
function answer(sock: ProxyClient, status: string, message: string, extra = ''): void {
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
  username: string;
  password: string;
}

/** Parse a proxy request head (CONNECT, or absolute-form plain HTTP). */
export function parseProxyHead(head: string): ParsedRequest | { error: string; status: string } {
  const lines = head.split('\r\n');
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
    return {
      kind: 'absolute',
      host,
      port: port ? Number(port) : 80,
      originHead: `${method} ${pathPart || '/'} ${version}\r\n${kept.join('\r\n')}\r\n\r\n`,
      username,
      password,
    };
  }
  return { error: 'this proxy speaks CONNECT and absolute-form HTTP', status: '501 Not Implemented' };
}

/** Serve one proxied connection from a local agent's container. */
export async function serveProxyClient(client: ProxyClient, deps: EgressFilterDeps): Promise<void> {
  client.on('error', () => {});
  let buf = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  const head = await new Promise<{ head: string; rest: Buffer } | null>((resolve) => {
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        client.off('data', onData);
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
  const mode = await deps.mode(caller.agentGroupId);
  const always = deps.always ? await deps.always(caller.agentGroupId) : undefined;
  const allowlist = await deps.allowlist(caller.agentGroupId);
  if (!egressAllowed(mode, req.host, req.port, allowlist, always)) {
    recordBlocked(req.host, req.port, caller.agentGroupId, caller.sessionId, mode);
    return answer(client, '403 Forbidden', blockedMessage(req.host, req.port, mode));
  }
  let upstream: net.Socket;
  const install = deps.installAllowlist ? await deps.installAllowlist() : [];
  if (req.kind === 'connect' && directTunnel(mode, req.host, req.port, install)) {
    try {
      upstream = await (deps.direct ?? connectDirect)(req.host, req.port);
    } catch (err) {
      return answer(
        client,
        '502 Bad Gateway',
        `could not reach ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
    log.info('Egress filter: direct tunnel', { agentGroupId: caller.agentGroupId, host: req.host, port: req.port });
  } else {
    try {
      const gw = deps.gateway();
      upstream = await connectThroughGateway(
        { host: gw.host, port: gw.port, username: req.username, password: req.password },
        req.host,
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
let ipMap: { at: number; map: Map<string, string> } | null = null;

export function registerFilteredContainer(name: string, caller: Caller): void {
  byName.set(name, caller);
  // A new container may have been handed the address a dead one gave up; the
  // next lookup re-reads the network rather than trusting the cached map.
  ipMap = null;
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
export function containerIdentifier(network: string): (ip: string) => Promise<Caller | null> {
  return async (ip) => {
    const addr = ip.replace(/^::ffff:/, '');
    const lookup = async (fresh: boolean): Promise<string | undefined> => {
      if (fresh || !ipMap || Date.now() - ipMap.at > IP_MAP_TTL_MS) {
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
        ipMap = { at: Date.now(), map };
      }
      return ipMap.map.get(addr);
    };
    const name = (await lookup(false)) ?? (await lookup(true));
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
  return {
    identify: containerIdentifier(network),
    gateway,
    mode: groupEgressMode,
    allowlist: allowlistFor,
    installAllowlist: getRunnerEgressAllowlist,
    always: modelHostsFor,
    ownModels: ownModelTargetsFor,
  };
}
