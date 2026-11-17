/**
 * The Compose override NanoClaw lays over an agent's stack. The agent never
 * sees or edits it; it is what makes "under the agent" true: one private
 * internal network (no internet), a fixed address per service, NanoClaw's
 * memory ceiling (the systemd slice), every capability dropped (a service may
 * add back a few, policy.ts), no privilege escalation, bounded logs and
 * ownership labels. Pure: tested on its own.
 *
 * No ports are published. The host reaches a service at its fixed address on
 * the agent's network; an internal Docker network still routes from the host,
 * it only stops traffic leaving it. Traffic from a workload TO the host is
 * dropped by the host rules (deploy/workloads-host-rules.sh), which the
 * preflight checks (preflight.ts).
 *
 * A service an owner approved runtime egress for (x-nanoclaw-egress) gets
 * HTTP(S)_PROXY pointing at its egress proxy on the network's gateway
 * (channels/webchat/workload-egress.ts), and NO_PROXY for its own stack.
 * This file is applied after the stack's own, so these values win.
 */

/** Agent networks are /24s carved from 198.18.0.0/15, reserved for benchmarking, so they clash with nothing real. */
export const SUBNET_BASE = [198, 18] as const;
/** The last /24 (198.19.255.0/24) is the isolation probe's (preflight.ts). */
export const MAX_NETWORKS = 511;
export const PROBE_INDEX = 511;
/** Services take .10–.127; dynamic joiners (the agent's own container) .128–.254. */
const FIRST_SERVICE = 10;
const LAST_SERVICE = 127;

export function subnetFor(index: number): { subnet: string; ipRange: string; prefix: string; gateway: string } {
  if (!Number.isInteger(index) || index < 0 || index > PROBE_INDEX)
    throw new Error(`network index ${index} out of range`);
  const prefix = `${SUBNET_BASE[0]}.${SUBNET_BASE[1] + Math.floor(index / 256)}.${index % 256}`;
  return { subnet: `${prefix}.0/24`, ipRange: `${prefix}.128/25`, prefix, gateway: `${prefix}.1` };
}

const ipv4ToInt = (ip: string): number | null => {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.some((x) => x > 255) ? null : ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
};

/**
 * Network indexes whose /24 overlaps any of these subnets (CIDR strings; IPv6
 * and junk are ignored). Another install on the same host numbers its networks
 * from 0 too, so its subnets must be skipped, not collided with.
 */
export function overlappingIndexes(subnets: Iterable<string>): Set<number> {
  const base = ((SUBNET_BASE[0] << 24) >>> 0) + (SUBNET_BASE[1] << 16);
  const out = new Set<number>();
  for (const cidr of subnets) {
    const [ip, bits] = cidr.split('/');
    const start = ipv4ToInt(ip ?? '');
    const len = Number(bits);
    if (start === null || !Number.isInteger(len) || len < 0 || len > 32) continue;
    const size = 2 ** (32 - len);
    const lo = start - (start % size);
    const hi = lo + size - 1;
    const first = Math.max(0, Math.floor((lo - base) / 256));
    const last = Math.min(MAX_NETWORKS - 1, Math.floor((hi - base) / 256));
    for (let i = first; i <= last; i++) if (hi >= base + i * 256 && lo <= base + i * 256 + 255) out.add(i);
  }
  return out;
}

/**
 * A fixed address per service. Services keep what they had (`keep`), so a
 * redeploy that adds one does not move the others; new services take the
 * lowest free addresses, skipping `taken` (the agent's other stacks share its
 * network).
 */
export function serviceAddresses(
  prefix: string,
  services: string[],
  keep: Record<string, string> = {},
  taken: Iterable<string> = [],
): Record<string, string> {
  const used = new Set(taken);
  const out: Record<string, string> = {};
  for (const n of services) {
    const a = keep[n];
    if (a && a.startsWith(`${prefix}.`) && !used.has(a)) {
      out[n] = a;
      used.add(a);
    }
  }
  let next = FIRST_SERVICE;
  for (const n of [...services].sort()) {
    if (out[n]) continue;
    while (next <= LAST_SERVICE && used.has(`${prefix}.${next}`)) next++;
    if (next > LAST_SERVICE) throw new Error('no addresses left on your workload network');
    out[n] = `${prefix}.${next}`;
    used.add(out[n]);
  }
  return out;
}

export interface OverrideInput {
  /** Compose project name; also prefixes volumes and containers. */
  project: string;
  /** The agent's workload network (created by NanoClaw, internal). */
  network: string;
  /** systemd slice every container runs under (the node's memory ceiling). */
  slice: string;
  labels: Record<string, string>;
  addresses: Record<string, string>;
  /** Extra names per service on the stack network (translate.ts: container_name, links, network aliases). */
  aliases?: Record<string, string[]>;
  /** Runtime egress: the proxy's address and port, the network's subnet, and the services approved for it. */
  egress?: { gateway: string; port: number; subnet: string; services: string[] };
}

/**
 * The environment a service with runtime egress runs with. The credential is
 * a placeholder (the proxy knows the caller by its address): HTTP clients
 * want one in the URL to send Proxy-Authorization at all. NO_PROXY keeps the
 * stack's own traffic off the proxy; NODE_USE_ENV_PROXY makes Node's own
 * fetch and http honour the proxy. Pure.
 */
export function egressEnvironment(gateway: string, port: number, noProxy: string[]): Record<string, string> {
  const proxy = `http://workload:workload@${gateway}:${port}`;
  const bypass = [...new Set(['localhost', '127.0.0.1', ...noProxy])].join(',');
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: bypass,
    no_proxy: bypass,
    NODE_USE_ENV_PROXY: '1',
  };
}

export const PIDS_LIMIT = 1024;

export function buildOverride(services: string[], o: OverrideInput): Record<string, unknown> {
  const svc: Record<string, unknown> = {};
  // Everything on the stack's own network bypasses the proxy: its subnet, every service's name, alias and address.
  const env = o.egress?.services.length
    ? egressEnvironment(o.egress.gateway, o.egress.port, [
        o.egress.subnet,
        ...services,
        ...Object.values(o.aliases ?? {}).flat(),
        ...services.map((n) => o.addresses[n]).filter(Boolean),
      ])
    : null;
  for (const name of services) {
    svc[name] = {
      networks: {
        nanoclaw: {
          ipv4_address: o.addresses[name],
          ...(o.aliases?.[name]?.length ? { aliases: o.aliases[name] } : {}),
        },
      },
      cgroup_parent: o.slice,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      labels: { ...o.labels, 'nanoclaw.service': name },
      // pids goes under deploy: Compose refuses pids_limit next to the stack's deploy limits.
      deploy: { resources: { limits: { pids: PIDS_LIMIT } } },
      ...(env && o.egress!.services.includes(name) ? { environment: env } : {}),
    };
  }
  return {
    name: o.project,
    services: svc,
    networks: { nanoclaw: { external: true, name: o.network } },
  };
}
