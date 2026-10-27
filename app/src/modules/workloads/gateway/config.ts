/**
 * The inbound gateway's settings. Off unless NANOCLAW_WORKLOAD_GATEWAY_PORT is
 * set; even then it refuses to run (with the reason) where it would be unsafe:
 *
 * - It listens on one explicit address, loopback by default. A wildcard
 *   (0.0.0.0, ::) is refused: the publishing routes' edges (a tailnet sidecar,
 *   a Cloudflare connector) reach it on an address the operator names, and
 *   nothing else should.
 * - It will not run while webchat trusts proxy headers from any address
 *   (WEBCHAT_TRUSTED_PROXY_IPS=auto or *): on such an install a request that
 *   reaches a local port can claim an identity, and the gateway is one more
 *   local port.
 */
import net from 'net';

import { pinnedImage } from '../images.js';
import { workloadSetting } from '../settings.js';

/** Caddy, pinned by digest: the gateway image is never a moving tag. */
const DEFAULT_GATEWAY_IMAGE =
  'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';

export interface GatewayConfig {
  /** Where Caddy listens for app traffic. */
  bind: string;
  port: number;
  /** NanoClaw's forward_auth listener, on 127.0.0.1 only. */
  internalPort: number;
  image: string;
}

export type GatewaySettings =
  | { on: false }
  | { on: true; ok: true; cfg: GatewayConfig }
  | { on: true; ok: false; reason: string };

const port = (v: string | undefined): number | null => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

/** True for an address that means "every interface". */
export function wildcardAddress(a: string): boolean {
  const v = a.replace(/^\[|\]$/g, '').toLowerCase();
  return v === '0.0.0.0' || v === '::' || v === '0:0:0:0:0:0:0:0' || v === '*' || v === '';
}

/** The settings as the environment gives them, checked. Pure apart from reading settings. */
export function gatewaySettings(
  get: (k: Parameters<typeof workloadSetting>[0]) => string | undefined = workloadSetting,
  env: NodeJS.ProcessEnv = process.env,
): GatewaySettings {
  const rawPort = get('NANOCLAW_WORKLOAD_GATEWAY_PORT');
  if (!rawPort) return { on: false };
  const p = port(rawPort);
  if (!p) return { on: true, ok: false, reason: 'NANOCLAW_WORKLOAD_GATEWAY_PORT must be a port number' };
  const trust = (env.WEBCHAT_TRUSTED_PROXY_IPS || '').trim();
  if (trust === 'auto' || trust === '*')
    return {
      on: true,
      ok: false,
      reason:
        'the gateway does not run while WEBCHAT_TRUSTED_PROXY_IPS trusts every address: set it to the proxy’s own address',
    };
  const bind = (get('NANOCLAW_WORKLOAD_GATEWAY_BIND') || '127.0.0.1').replace(/^\[|\]$/g, '');
  if (wildcardAddress(bind))
    return {
      on: true,
      ok: false,
      reason: 'NANOCLAW_WORKLOAD_GATEWAY_BIND must be one address (loopback or the edge’s), not every interface',
    };
  if (!net.isIP(bind)) return { on: true, ok: false, reason: 'NANOCLAW_WORKLOAD_GATEWAY_BIND must be an IP address' };
  const rawInternal = get('NANOCLAW_WORKLOAD_GATEWAY_INTERNAL_PORT');
  const internalPort = rawInternal ? port(rawInternal) : p + 1 < 65536 ? p + 1 : null;
  if (!internalPort || internalPort === p)
    return { on: true, ok: false, reason: 'NANOCLAW_WORKLOAD_GATEWAY_INTERNAL_PORT must be a different port number' };
  let image: string;
  try {
    image = pinnedImage(
      get('NANOCLAW_WORKLOAD_GATEWAY_IMAGE'),
      DEFAULT_GATEWAY_IMAGE,
      'NANOCLAW_WORKLOAD_GATEWAY_IMAGE',
    );
  } catch (err) {
    return { on: true, ok: false, reason: (err as Error).message };
  }
  return { on: true, ok: true, cfg: { bind, port: p, internalPort, image } };
}
