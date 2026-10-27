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
}

export const PIDS_LIMIT = 1024;

export function buildOverride(services: string[], o: OverrideInput): Record<string, unknown> {
  const svc: Record<string, unknown> = {};
  for (const name of services) {
    svc[name] = {
      networks: { nanoclaw: { ipv4_address: o.addresses[name] } },
      cgroup_parent: o.slice,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      labels: { ...o.labels, 'nanoclaw.service': name },
      // pids goes under deploy: Compose refuses pids_limit next to the stack's deploy limits.
      deploy: { resources: { limits: { pids: PIDS_LIMIT } } },
    };
  }
  return {
    name: o.project,
    services: svc,
    networks: { nanoclaw: { external: true, name: o.network } },
  };
}
