/**
 * The tailnet publishing route's settings (docs/webchat/workloads.md,
 * "Tailnet route"). Off unless NANOCLAW_WORKLOAD_TAILNET=1; then checked, and
 * refused with the reason, before anything starts.
 *
 * Each published app gets a Tailscale sidecar on this install's edge network:
 * a Docker bridge of its own (not a workload network, never the host
 * network), one fixed address per sidecar. The gateway listens on the edge
 * network's host address, and believes a Tailscale identity only from the
 * address of the app's own sidecar.
 */
import { INSTALL_SLUG } from '../../../config.js';
import { sha256 } from '../docker.js';
import { pinnedImage } from '../images.js';
import { workloadSetting, type WorkloadEnvKey } from '../settings.js';

/** tailscale/tailscale v1.104.2, pinned by digest (multi-arch index). */
const DEFAULT_SIDECAR_IMAGE =
  'tailscale/tailscale:v1.104.2@sha256:b11583ad2e93e4671128538c88cf11f460444a5d7e449311dd1933a400ab849d';

/** TEST-NET-2 (RFC 5737): never routed, so it collides with nothing real. */
const DEFAULT_SUBNET = '198.51.100.0/24';
export const DEFAULT_TAG = 'tag:nanoclaw-app';

/** Bridge names of edge networks all start with `nct`: one host rule (`-i nct+`) covers every install's. */
export const EDGE_BRIDGE_PREFIX = 'nct';
export const edgeBridgeName = (): string => `${EDGE_BRIDGE_PREFIX}${sha256(INSTALL_SLUG).slice(0, 6)}`;
export const edgeNetworkName = (): string => `nc-tsedge-${INSTALL_SLUG}`;

/** <name>.ts.net: the tailnet's DNS name, as the admin console's DNS page shows it. */
export const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;
const TAG_RE = /^tag:[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/** The edge network both publishing routes' edges sit on (edge.ts). */
export interface EdgeConfig {
  /** `a.b.c.0/24`. */
  subnet: string;
  /** The host's address on it (.1): where the gateway listens for the edges. */
  gateway: string;
  /** a.b.c */
  prefix: string;
}

export interface TailnetConfig extends EdgeConfig {
  domain: string;
  tag: string;
  image: string;
}

/**
 * The edge network's subnet: NANOCLAW_WORKLOAD_EDGE_SUBNET, or the older
 * NANOCLAW_WORKLOAD_TAILNET_SUBNET, or 198.51.100.0/24. Shared by the tailnet
 * sidecars and the Cloudflare connector.
 */
export function edgeSettings(
  get: (k: WorkloadEnvKey) => string | undefined = workloadSetting,
): { ok: true; cfg: EdgeConfig } | { ok: false; reason: string } {
  const subnet = get('NANOCLAW_WORKLOAD_EDGE_SUBNET') || get('NANOCLAW_WORKLOAD_TAILNET_SUBNET') || DEFAULT_SUBNET;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(subnet);
  if (!m || m.slice(1).some((o) => Number(o) > 255))
    return { ok: false, reason: 'NANOCLAW_WORKLOAD_EDGE_SUBNET must be an IPv4 /24, e.g. 198.51.100.0/24' };
  const [a, b] = [Number(m[1]), Number(m[2])];
  // Not the workload range, loopback, or the tailnet's own CGNAT range.
  if ((a === 198 && (b === 18 || b === 19)) || a === 127 || a === 0 || (a === 100 && b >= 64 && b <= 127) || a >= 224)
    return {
      ok: false,
      reason: 'NANOCLAW_WORKLOAD_EDGE_SUBNET must not overlap the workload, loopback or tailnet ranges',
    };
  const prefix = `${m[1]}.${m[2]}.${m[3]}`;
  return { ok: true, cfg: { subnet, gateway: `${prefix}.1`, prefix } };
}

export type TailnetSettings =
  | { on: false }
  | { on: true; ok: true; cfg: TailnetConfig }
  | { on: true; ok: false; reason: string };

export function tailnetSettings(get: (k: WorkloadEnvKey) => string | undefined = workloadSetting): TailnetSettings {
  if (get('NANOCLAW_WORKLOAD_TAILNET') !== '1') return { on: false };
  const fail = (reason: string): TailnetSettings => ({ on: true, ok: false, reason });
  const domain = (get('NANOCLAW_WORKLOAD_TAILNET_DOMAIN') || '').toLowerCase().replace(/\.$/, '');
  if (!domain)
    return fail('NANOCLAW_WORKLOAD_TAILNET_DOMAIN is not set (your tailnet’s DNS name, e.g. tail1234.ts.net)');
  if (!DOMAIN_RE.test(domain))
    return fail('NANOCLAW_WORKLOAD_TAILNET_DOMAIN must be the tailnet’s DNS name, e.g. tail1234.ts.net');
  const tag = get('NANOCLAW_WORKLOAD_TAILNET_TAG') || DEFAULT_TAG;
  if (!TAG_RE.test(tag)) return fail('NANOCLAW_WORKLOAD_TAILNET_TAG must be one tag, e.g. tag:nanoclaw-app');
  const edge = edgeSettings(get);
  if (!edge.ok) return fail(edge.reason);
  let image: string;
  try {
    image = pinnedImage(
      get('NANOCLAW_WORKLOAD_TAILNET_IMAGE'),
      DEFAULT_SIDECAR_IMAGE,
      'NANOCLAW_WORKLOAD_TAILNET_IMAGE',
    );
  } catch (err) {
    return fail((err as Error).message);
  }
  return { on: true, ok: true, cfg: { domain, tag, image, ...edge.cfg } };
}

/**
 * Sidecars take fixed addresses .2 to .238; the Cloudflare connector .239;
 * Docker hands out .240–.255 (the probe's).
 */
export const FIRST_HOST = 2;
export const LAST_HOST = 238;
export const CONNECTOR_HOST = 239;
export const dynamicRange = (cfg: EdgeConfig): string => `${cfg.prefix}.240/28`;
