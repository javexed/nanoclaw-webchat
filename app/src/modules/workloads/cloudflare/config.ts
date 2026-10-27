/**
 * The Cloudflare publishing route's settings (docs/webchat/workloads.md,
 * "The Cloudflare route"). Off unless NANOCLAW_WORKLOAD_CLOUDFLARE=1; then
 * checked, and refused with the reason, before anything starts.
 *
 * Apps are published at <app>.<app domain> through one `cloudflared`
 * connector on the edge network (tailnet/edge.ts) at a fixed address, which
 * reaches only the gateway on the edge network's host address. The app domain
 * must be a different site (registrable domain) from NanoClaw's own address.
 */
import { INSTALL_SLUG } from '../../../config.js';
import { pinnedImage } from '../images.js';
import { workloadSetting, type WorkloadEnvKey } from '../settings.js';
import { CONNECTOR_HOST, edgeSettings, type EdgeConfig } from '../tailnet/config.js';
import { normalizeHost, registrableDomain, sameSite } from './domain.js';

/** cloudflare/cloudflared 2026.10.3, pinned by digest (multi-arch index). */
const DEFAULT_CONNECTOR_IMAGE =
  'cloudflare/cloudflared:2026.10.3@sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39';

export const HEX32 = /^[0-9a-f]{32}$/;
export const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

export interface CloudflareConfig extends EdgeConfig {
  /** Apps are <app>.<domain>. */
  domain: string;
  accountId: string;
  zoneId: string;
  /** The Access team domain: <team>.cloudflareaccess.com (the tokens' issuer). */
  teamDomain: string;
  image: string;
  /** The connector's fixed address on the edge network. */
  connector: string;
  /** The tunnel's name in the Cloudflare account. */
  tunnelName: string;
}

export type CloudflareSettings =
  | { on: false }
  | { on: true; ok: true; cfg: CloudflareConfig }
  | { on: true; ok: false; reason: string };

/** NanoClaw's own names, as the settings give them: its public URL and allowed hosts. */
export function ownHostNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const pub = (env.WEBCHAT_PUBLIC_URL || '').trim();
  if (pub) {
    try {
      out.push(new URL(pub).hostname);
    } catch {
      /* malformed: webchat ignores it too */
    }
  }
  for (const h of (env.WEBCHAT_ALLOWED_HOSTS || '').split(',')) if (h.trim() && h.trim() !== '*') out.push(h.trim());
  return out.map(normalizeHost).filter(Boolean);
}

/** Why an app domain may not be used beside these names of NanoClaw's, or null. */
export function domainConflict(domain: string, own: string[]): string | null {
  const clash = own.find((h) => sameSite(h, domain));
  return clash
    ? `the app domain ${domain} is the same site as NanoClaw’s own ${clash} (both under ${registrableDomain(domain)}): use a different registrable domain`
    : null;
}

export function cloudflareSettings(
  get: (k: WorkloadEnvKey) => string | undefined = workloadSetting,
  env: NodeJS.ProcessEnv = process.env,
): CloudflareSettings {
  if (get('NANOCLAW_WORKLOAD_CLOUDFLARE') !== '1') return { on: false };
  const fail = (reason: string): CloudflareSettings => ({ on: true, ok: false, reason });
  const rawDomain = get('NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN') || '';
  if (!rawDomain) return fail('NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN is not set (the app domain, e.g. example-apps.net)');
  const domain = normalizeHost(rawDomain);
  if (!domain || !registrableDomain(domain))
    return fail('NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN must be a domain name you own, e.g. example-apps.net');
  const conflict = domainConflict(domain, ownHostNames(env));
  if (conflict) return fail(conflict);
  const accountId = (get('NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID') || '').toLowerCase();
  if (!HEX32.test(accountId))
    return fail('NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID must be the Cloudflare account ID (32 hex characters)');
  const zoneId = (get('NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID') || '').toLowerCase();
  if (!HEX32.test(zoneId))
    return fail('NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID must be the app domain’s zone ID (32 hex characters)');
  const teamDomain = (get('NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN') || env.WEBCHAT_CF_ACCESS_TEAM_DOMAIN || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!TEAM_RE.test(teamDomain))
    return fail(
      'NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN must be the Access team domain, e.g. myteam.cloudflareaccess.com',
    );
  const edge = edgeSettings(get);
  if (!edge.ok) return fail(edge.reason);
  let image: string;
  try {
    image = pinnedImage(
      get('NANOCLAW_WORKLOAD_CLOUDFLARE_IMAGE'),
      DEFAULT_CONNECTOR_IMAGE,
      'NANOCLAW_WORKLOAD_CLOUDFLARE_IMAGE',
    );
  } catch (err) {
    return fail((err as Error).message);
  }
  return {
    on: true,
    ok: true,
    cfg: {
      domain,
      accountId,
      zoneId,
      teamDomain,
      image,
      ...edge.cfg,
      connector: `${edge.cfg.prefix}.${CONNECTOR_HOST}`,
      tunnelName: `nanoclaw-${INSTALL_SLUG}`,
    },
  };
}
