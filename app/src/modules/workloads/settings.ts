/**
 * The workloads settings an operator sets in `.env` (or the service's
 * environment, which wins). Read when asked, not at import, so tests and a
 * changed `.env` see the current value. See docs/webchat/workloads.md.
 */
import { readEnvFile } from '../../env.js';

export const WORKLOAD_ENV_KEYS = [
  'NANOCLAW_WORKLOADS',
  'NANOCLAW_WORKLOAD_CONFINED_BUILDS',
  'NANOCLAW_WORKLOAD_BUILDER_RUNTIME',
  'NANOCLAW_WORKLOAD_HELPER_IMAGE',
  'NANOCLAW_WORKLOAD_BUILDKIT_IMAGE',
  'NANOCLAW_WORKLOAD_SLICE',
  'NANOCLAW_WORKLOAD_BUILD_MIN',
  'NANOCLAW_WORKLOAD_BUILDER_CACHE_MB',
  'NANOCLAW_WORKLOAD_SLEEP_H',
  'NANOCLAW_WORKLOAD_GATEWAY_PORT',
  'NANOCLAW_WORKLOAD_GATEWAY_BIND',
  'NANOCLAW_WORKLOAD_GATEWAY_INTERNAL_PORT',
  'NANOCLAW_WORKLOAD_GATEWAY_IMAGE',
  'NANOCLAW_WORKLOAD_TAILNET',
  'NANOCLAW_WORKLOAD_TAILNET_DOMAIN',
  'NANOCLAW_WORKLOAD_TAILNET_TAG',
  'NANOCLAW_WORKLOAD_TAILNET_SUBNET',
  'NANOCLAW_WORKLOAD_TAILNET_IMAGE',
  'NANOCLAW_WORKLOAD_EDGE_SUBNET',
  'NANOCLAW_WORKLOAD_CLOUDFLARE',
  'NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN',
  'NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID',
  'NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID',
  'NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN',
  'NANOCLAW_WORKLOAD_CLOUDFLARE_IMAGE',
  'NANOCLAW_WORKLOAD_PORTS',
  'NANOCLAW_WORKLOAD_EGRESS_PORT',
] as const;

export type WorkloadEnvKey = (typeof WORKLOAD_ENV_KEYS)[number];

export function workloadSetting(key: WorkloadEnvKey): string | undefined {
  const v = process.env[key];
  if (v !== undefined) return v.trim();
  if (process.env.VITEST) return undefined;
  return readEnvFile([key])[key]?.trim();
}

/** Workloads run only where the operator turned them on (and the preflight passes, preflight.ts). */
export const workloadsSwitchedOn = (): boolean => workloadSetting('NANOCLAW_WORKLOADS') === '1';

/** Builds run only in confined builders (rootless BuildKit in gVisor, builder.ts); otherwise `build:` is refused. */
export const confinedBuildsOn = (): boolean => workloadSetting('NANOCLAW_WORKLOAD_CONFINED_BUILDS') === '1';

/**
 * The port running stacks reach their egress proxy on, at their network's
 * gateway address (channels/webchat/workload-egress.ts); null while unset or
 * not a port, which keeps runtime egress off: a stack that declares
 * `x-nanoclaw-egress` is then refused. The host rules must let it through
 * (deploy/workloads-host-rules.sh --stack-egress-port).
 */
export function workloadEgressPort(): number | null {
  const v = workloadSetting('NANOCLAW_WORKLOAD_EGRESS_PORT');
  if (!v || !/^\d{1,5}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : null;
}
