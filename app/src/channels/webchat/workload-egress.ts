/**
 * Runtime egress for workload stacks: the proxy a running stack's services
 * use to reach the hosts an owner approved for them, and nothing else.
 *
 * A stack's network is internal (no route out), and the host rules drop new
 * connections from it to this host — except to one port, the install's
 * NANOCLAW_WORKLOAD_EGRESS_PORT, on the network's own gateway address. This
 * listens there, one listener per agent network that runs a stack declaring
 * egress (modules/workloads/egress.ts opens and closes them). Each request:
 *
 *   1. is known by its source address: the listener's own address names the
 *      agent's network, and the source must be a service address NanoClaw
 *      gave a running stack on it. Stack containers drop every capability
 *      (no NET_RAW, no NET_ADMIN), so they cannot claim another address; an
 *      agent container on the same network holds none of those addresses
 *      and is refused;
 *   2. must match what the owner approved for that service (its
 *      `x-nanoclaw-egress` list, read from the approved record, never from
 *      the agent's files) AND what the agent itself may reach now (its own
 *      allowlist or its own model, without the model floor): taking a host
 *      off the agent cuts its stacks off too. An agent on Open has no
 *      allowlist, so its approved list alone applies;
 *   3. connects directly, never through the credential gateway (which would
 *      add the agent's secrets), to the address the name resolved to, checked
 *      at that moment: never this host, loopback, link-local, the workload
 *      range, a Docker network, the publishing edge or the tailnet, and a
 *      private address only when the approved entry names it literally.
 *
 * An Ollama server is refused on the general proxy (egress-filter.ts
 * ollamaPin). Here a service whose approved list names it may send it
 * inference over plain HTTP: one request per connection, its body bounded by
 * Content-Length, read-only and inference paths only (ollama-filter.ts).
 *
 * HTTP(S) through the proxy is all there is: a client that ignores
 * HTTP(S)_PROXY, or a protocol other than HTTP, has no way out.
 */
import { execFile } from 'child_process';
import dns from 'dns/promises';
import net from 'net';
import type { Duplex } from 'stream';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';

import {
  answer,
  connectTcp,
  ollamaPin,
  parseProxyHead,
  readProxyHead,
  spliceDirect,
  type ProxyClient,
} from './egress-filter.js';
import {
  allowlistFor,
  directAddressAllowed,
  groupEgressMode,
  hostMatches,
  ownModelTargetsFor,
  parsePattern,
  recordBlocked,
  type EgressMode,
} from './egress-policy.js';
import { ollamaRequestAllowed } from './ollama-filter.js';
import { noteWorkloadEgressRefusal } from './workload-egress-refusals.js';

/** How many hosts one service may declare. */
export const MAX_WORKLOAD_EGRESS = 10;

/** The caller's session id in the egress audit: which workload and service asked. */
export const workloadSessionId = (workloadId: string, service: string): string => `workload:${workloadId}/${service}`;

/**
 * Ranges a stack may never name or reach: the workload range itself, Docker's
 * default pools, loopback, link-local (cloud metadata), the tailnet's CGNAT
 * range and "this network".
 */
export const WORKLOAD_REFUSED_CIDRS = [
  '198.18.0.0/15',
  '172.16.0.0/12',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
];

/** Names that mean this host to a container. */
const REFUSED_NAMES = ['localhost', 'host.docker.internal', 'gateway.docker.internal'];

/** Is this IPv4 address inside one of these CIDRs? */
export function inCidrs(address: string, cidrs: string[]): boolean {
  if (!net.isIPv4(address)) return false;
  const list = new net.BlockList();
  let any = false;
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const n = Number(bits);
    if (net.isIPv4(addr) && Number.isInteger(n) && n >= 0 && n <= 32) {
      list.addSubnet(addr, n, 'ipv4');
      any = true;
    }
  }
  return any && list.check(address, 'ipv4');
}

/** RFC 1918: a LAN address, which an entry may name only literally and with its port. */
const isLanV4 = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

const refusedName = (host: string): boolean =>
  REFUSED_NAMES.includes(host) || host.endsWith('.localhost') || host.endsWith('.docker.internal');

/**
 * Validate one service's `x-nanoclaw-egress` list and normalize it: `host`
 * (443 and 80), `host:port`, `*.domain` (port 443 only, stored as
 * `*.domain:443`), or a literal address. A bare `*` is refused; a LAN address
 * must be written as address:port; this host, the workload range, Docker's
 * pools, loopback, link-local, the tailnet range and `deny` (the publishing
 * edge subnet) are always refused. Pure.
 */
export function parseWorkloadEgress(
  raw: unknown,
  deny: string[] = [],
): { ok: true; entries: string[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) return { ok: false, errors: ['must be a list of host names'] };
  if (raw.length > MAX_WORKLOAD_EGRESS)
    return { ok: false, errors: [`at most ${MAX_WORKLOAD_EGRESS} hosts (it lists ${raw.length})`] };
  const errors: string[] = [];
  const entries: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      errors.push('every entry must be a host name');
      continue;
    }
    const t = item.trim();
    if (t === '*' || t.startsWith('*:') || t === '*.*') {
      errors.push(`${t}: a bare * is not allowed: name each host, or *.domain for its subdomains on port 443`);
      continue;
    }
    const p = parsePattern(t);
    if (!p.ok) {
      errors.push(p.error);
      continue;
    }
    const [host, portText] = p.pattern.split(':');
    let entry = p.pattern;
    if (host.startsWith('*.')) {
      if (portText && portText !== '443') {
        errors.push(`${t}: a *.domain entry works on port 443 only`);
        continue;
      }
      const suffix = host.slice(1);
      if (REFUSED_NAMES.some((n) => `.${n}`.endsWith(suffix)) || suffix === '.internal') {
        errors.push(`${t}: names this host`);
        continue;
      }
      entry = `${host}:443`;
    } else if (net.isIPv4(host)) {
      if (inCidrs(host, [...WORKLOAD_REFUSED_CIDRS, ...deny])) {
        errors.push(`${t}: that address range is never reachable from a workload`);
        continue;
      }
      if (isLanV4(host) && !portText) {
        errors.push(`${t}: a private address needs its port, e.g. ${host}:8080`);
        continue;
      }
    } else if (refusedName(host)) {
      errors.push(`${t}: names this host`);
      continue;
    }
    if (!entries.includes(entry)) entries.push(entry);
  }
  return errors.length ? { ok: false, errors } : { ok: true, entries };
}

/** Does allowlist pattern `a` cover (host, port), where host may itself be `*.domain`? Pure. */
function patternCovers(a: string, host: string, port: number): boolean {
  if (!host.startsWith('*.')) return hostMatches(host, port, a);
  const [ah, ap] = a.split(':');
  if (ap ? Number(ap) !== port : port !== 443 && port !== 80) return false;
  if (!ah.startsWith('*.')) return false;
  const want = host.slice(1);
  const have = ah.slice(1);
  return want === have || want.endsWith(have);
}

/**
 * Is a declared entry within what the agent itself may reach? Open: anything.
 * Otherwise every port the entry stands for must be the agent's own model
 * (host:port) or, on Allowlist, covered by its allowlist (the install's plus
 * its own hosts). The model floor (api.anthropic.com and the like) never
 * counts: it is the agent's, not its stacks'. Pure.
 */
export function workloadEgressCovered(
  entry: string,
  mode: EgressMode,
  allowlist: string[],
  ownModels: string[],
): boolean {
  if (mode === 'open') return true;
  const [host, portText] = entry.split(':');
  const ports = portText ? [Number(portText)] : [443, 80];
  return ports.every(
    (port) =>
      ownModels.includes(`${host}:${port}`) ||
      (mode === 'host-only' && allowlist.some((a) => patternCovers(a, host, port))),
  );
}

/**
 * The runtime rule: in the service's approved list AND within what the agent
 * may reach now (see workloadEgressCovered). Pure.
 */
export function workloadEgressAllowed(
  host: string,
  port: number,
  approved: string[],
  mode: EgressMode,
  allowlist: string[],
  ownModels: string[],
): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!approved.some((p) => hostMatches(h, port, p))) return false;
  if (mode === 'open') return true;
  if (ownModels.includes(`${h}:${port}`)) return true;
  return mode === 'host-only' && allowlist.some((p) => hostMatches(h, port, p));
}

/**
 * May a stack's connection go to this address? Whatever a direct tunnel may
 * not (directAddressAllowed: this host, loopback, link-local, and a private
 * address unless `literal`), nor the workload range, Docker's networks, the
 * tailnet or `forbidden` (Docker's current subnets, the publishing edge).
 */
export function workloadAddressAllowed(address: string, literal: boolean, forbidden: string[] = []): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (!directAddressAllowed(a, literal)) return false;
  return !inCidrs(a, [...WORKLOAD_REFUSED_CIDRS, ...forbidden]);
}

// ── Docker's own subnets, refused as destinations ─────────────────────────────

const SUBNETS_TTL_MS = 60_000;
let subnetCache: { at: number; list: string[] } | null = null;

function runtime(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(CONTAINER_RUNTIME_BIN, args, { timeout: 10_000 }, (err, out) =>
      err ? reject(err) : resolve(String(out)),
    ),
  );
}

/** Every Docker network's IPv4 subnet on this host, re-read at most once a minute (on failure: the last answer). */
export async function dockerSubnets(): Promise<string[]> {
  if (subnetCache && Date.now() - subnetCache.at < SUBNETS_TTL_MS) return subnetCache.list;
  try {
    const ids = (await runtime(['network', 'ls', '-q'])).trim().split(/\s+/).filter(Boolean);
    const out = ids.length
      ? await runtime(['network', 'inspect', ...ids, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'])
      : '';
    const list = out.split(/\s+/).filter((s) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
    subnetCache = { at: Date.now(), list };
  } catch (err) {
    log.warn('Workload egress: could not list Docker networks; keeping the last list', { err: String(err) });
    subnetCache = { at: Date.now(), list: subnetCache?.list ?? [] };
  }
  return subnetCache.list;
}

// ── the proxy ──────────────────────────────────────────────────────────────────

export interface WorkloadEgressCaller {
  agentGroupId: string;
  /** workload:<id>/<service>, or workload:unknown for an address on the network that is no service. */
  sessionId: string;
  workloadId: string | null;
  service: string | null;
  /** What the owner approved for this service; empty: nothing. */
  approved: string[];
}

export interface WorkloadEgressDeps {
  /**
   * Who is calling: `local` is the listener's own address (an agent network's
   * gateway), `remote` the source, already known to share its /24. Null: not
   * an agent network NanoClaw knows.
   */
  identify: (local: string, remote: string) => Promise<WorkloadEgressCaller | null>;
  mode?: (agentGroupId: string) => Promise<EgressMode>;
  allowlist?: (agentGroupId: string) => Promise<string[]>;
  ownModels?: (agentGroupId: string) => Promise<string[]>;
  /** Ranges no connection may go to, besides the fixed ones; default: Docker's current subnets. */
  forbidden?: () => Promise<string[]>;
  /** A name's address; default: one DNS lookup. */
  resolve?: (host: string) => Promise<string>;
  /** Open a connection to an address the checks passed; default: TCP. */
  dial?: (address: string, port: number) => Promise<Duplex>;
}

const bare = (a: string | undefined): string => (a ?? '').replace(/^::ffff:/, '');
const sameSlash24 = (a: string, b: string): boolean =>
  net.isIPv4(a) && net.isIPv4(b) && a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');

/** What a refused service is told. */
export function workloadBlockedMessage(host: string, port: number): string {
  const where = port === 443 || port === 80 ? host : `${host}:${port}`;
  return `blocked by NanoClaw network policy: this service may not reach ${where} — declare it under x-nanoclaw-egress (it needs an approval), and it must be on the agent's own Network list`;
}

/** Serve one proxied connection from a workload service. */
export async function serveWorkloadEgressClient(
  client: ProxyClient & { localAddress?: string },
  deps: WorkloadEgressDeps,
): Promise<void> {
  client.on('error', () => {});
  const head = await readProxyHead(client);
  if (!head) return void client.destroy();
  const req = parseProxyHead(head.head);
  if ('error' in req) return answer(client, req.status, req.error);
  const local = bare(client.localAddress);
  const remote = bare(client.remoteAddress);
  const caller = sameSlash24(local, remote) ? await deps.identify(local, remote) : null;
  if (!caller) {
    log.warn('Workload egress: a connection from an address that is no workload network', { local, remote });
    return answer(client, '403 Forbidden', 'blocked by NanoClaw network policy: not a workload NanoClaw knows');
  }
  const mode = await (deps.mode ?? groupEgressMode)(caller.agentGroupId);
  const refuse = (why: string, opts: { status?: string; record?: boolean } = {}): void => {
    if (opts.record !== false) recordBlocked(req.host, req.port, caller.agentGroupId, caller.sessionId, mode);
    noteWorkloadEgressRefusal(caller.agentGroupId, caller.workloadId, caller.service, req.host, req.port, why);
    log.warn('Workload egress refused', {
      agentGroupId: caller.agentGroupId,
      caller: caller.sessionId,
      host: req.host,
      port: req.port,
      why,
    });
    answer(client, opts.status ?? '403 Forbidden', why);
  };
  const allowlist = mode === 'host-only' ? await (deps.allowlist ?? allowlistFor)(caller.agentGroupId) : [];
  const own = await (deps.ownModels ?? ownModelTargetsFor)(caller.agentGroupId);
  if (!workloadEgressAllowed(req.host, req.port, caller.approved, mode, allowlist, own))
    return refuse(workloadBlockedMessage(req.host, req.port));

  const ollama = await ollamaPin(req.host, req.port);
  if ('refused' in ollama && ollama.refused === 'unresolved')
    return refuse(`${req.host} could not be resolved`, { status: '502 Bad Gateway', record: false });
  const literal = net.isIP(req.host) !== 0;
  let address: string;
  try {
    address =
      'pin' in ollama && ollama.pin
        ? ollama.pin
        : literal
          ? req.host
          : await (deps.resolve ?? (async (h: string) => (await dns.lookup(h)).address))(req.host);
  } catch {
    return refuse(`${req.host} could not be resolved`, { status: '502 Bad Gateway', record: false });
  }
  // The address checked is the one dialled: a second lookup cannot move it.
  if (!workloadAddressAllowed(address, literal, await (deps.forbidden ?? dockerSubnets)()))
    return refuse(
      `blocked by NanoClaw network policy: ${req.host} resolves to ${address}, which a workload may not reach (a private address must be listed as address:port itself)`,
    );
  const dial = deps.dial ?? connectTcp;
  if ('refused' in ollama) return serveOllama(client, req, head.rest, address, dial, refuse);
  let upstream: Duplex;
  try {
    upstream = await dial(address, req.port);
  } catch (err) {
    return refuse(`could not reach ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`, {
      status: '502 Bad Gateway',
      record: false,
    });
  }
  spliceDirect(client, req, head.rest, upstream);
}

type Parsed = Exclude<ReturnType<typeof parseProxyHead>, { error: string }>;

/** One inference request to an approved Ollama server: plain HTTP, Content-Length only, then the connection closes. */
async function serveOllama(
  client: ProxyClient,
  req: Parsed,
  rest: Buffer,
  address: string,
  dial: (address: string, port: number) => Promise<Duplex>,
  refuse: (why: string, opts?: { status?: string; record?: boolean }) => void,
): Promise<void> {
  if (req.kind !== 'absolute')
    return refuse('Ollama is reachable from a workload over plain HTTP only (an http:// URL, not a tunnel)', {
      record: false,
    });
  const lines = req.originHead!.split('\r\n').filter(Boolean);
  const [method, target] = lines[0].split(' ');
  if (!ollamaRequestAllowed(method, target))
    return refuse(
      `${method} ${target.split('?')[0]} is not available: only inference and read-only lookups reach Ollama`,
      { record: false },
    );
  // A chunked body ends where a decoder says, and a second request could follow it on the same connection.
  if (req.bodyLength === null || req.bodyLength === undefined)
    return refuse('a request to Ollama must state its Content-Length', {
      status: '411 Length Required',
      record: false,
    });
  let upstream: Duplex;
  try {
    upstream = await dial(address, req.port);
  } catch (err) {
    return refuse(`could not reach ${req.host}:${req.port}: ${String((err as Error).message).slice(0, 200)}`, {
      status: '502 Bad Gateway',
      record: false,
    });
  }
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.once('close', () => upstream.destroy());
  upstream.write(
    [lines[0], ...lines.slice(1).filter((l) => !/^(connection|keep-alive):/i.test(l)), 'Connection: close'].join(
      '\r\n',
    ) + '\r\n\r\n',
  );
  upstream.pipe(client);
  // This request's body and nothing after it.
  let left = req.bodyLength;
  const forward = (chunk: Buffer): void => {
    if (left <= 0) return;
    const part = chunk.subarray(0, left);
    left -= part.length;
    if (!upstream.write(part)) {
      client.pause();
      upstream.once('drain', () => client.resume());
    }
  };
  forward(rest);
  client.on('data', forward);
  client.resume();
}

// ── listeners ──────────────────────────────────────────────────────────────────

const listeners = new Map<string, { server: net.Server; ready: Promise<void> }>();

/**
 * Listen (idempotently) on an agent network's gateway address. Resolves once
 * listening; rejects when the address cannot be had (and forgets it, so the
 * next call tries again).
 */
export function openWorkloadEgressListener(gateway: string, port: number, deps: WorkloadEgressDeps): Promise<void> {
  const k = `${gateway}:${port}`;
  const had = listeners.get(k);
  if (had) return had.ready;
  const server = net.createServer((sock) => void serveWorkloadEgressClient(sock, deps).catch(() => sock.destroy()));
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      log.info('Workload egress listening', { gateway, port });
      resolve();
    });
    server.on('error', (err) => {
      log.error('Workload egress listener failed', { gateway, port, err: String(err) });
      if (listeners.get(k)?.server === server) listeners.delete(k);
      reject(err);
    });
  });
  // A failure nobody awaited is logged above, not thrown at the process.
  ready.catch(() => undefined);
  listeners.set(k, { server, ready });
  server.listen(port, gateway);
  return ready;
}

/** Stop listening on a gateway address (any port). */
export function closeWorkloadEgressListener(gateway: string): void {
  for (const [k, { server }] of [...listeners]) {
    if (k.slice(0, k.lastIndexOf(':')) !== gateway) continue;
    server.close();
    listeners.delete(k);
    log.info('Workload egress listener closed', { gateway });
  }
}

/** The addresses listened on now, as gateway:port. */
export const workloadEgressListeners = (): string[] => [...listeners.keys()];

export function __resetWorkloadEgressForTest(): void {
  for (const l of listeners.values()) l.server.close();
  listeners.clear();
  subnetCache = null;
}
