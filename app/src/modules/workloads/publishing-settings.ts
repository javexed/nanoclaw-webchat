/**
 * Admin → Publishing (owner only): the two publishing routes' switches,
 * settings and credentials, and their status lines.
 *
 * The switches and settings ARE the `.env` keys the docs name
 * (NANOCLAW_WORKLOAD_TAILNET, NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN, …): the
 * page writes them to `.env` and to this process's environment, the same way
 * Admin → Sign-in writes its keys, so a hand edit, a restart and the page all
 * see one value. There is no second switch in the database to disagree with
 * them. Every route still runs only when its full check passes
 * (tailnetStatus / cloudflareStatus); switching one off takes its apps down
 * at the next sweep.
 *
 * Connect hands a credential straight to the OneCLI vault
 * (connectTailnetClient / connectCloudflareToken). NanoClaw never stores it
 * and the page never shows it again.
 */
import { removeEnv, upsertEnv } from '../../channels/webchat/env-write.js';
import { tailnetHostNames } from '../../channels/webchat/request-guard.js';
import { realOnecliAdmin, type OnecliAdmin } from '../user-credentials/onecli-admin.js';
import { cloudflareStatus, refreshCloudflareStatus, type CloudflareStatus } from './cloudflare/index.js';
import { domainConflict, HEX32, ownHostNames, TEAM_RE } from './cloudflare/config.js';
import { connectCloudflareToken } from './cloudflare/credential.js';
import { normalizeHost, registrableDomain } from './cloudflare/domain.js';
import { gatewayState } from './gateway/index.js';
import { lastPreflight, OFF_REASON } from './preflight.js';
import { workloadSetting, workloadsSwitchedOn, type WorkloadEnvKey } from './settings.js';
import { DOMAIN_RE } from './tailnet/config.js';
import { connectTailnetClient } from './tailnet/credential.js';
import { refreshTailnetStatus, tailnetStatus, type TailnetStatus } from './tailnet/index.js';

type RouteStatus = TailnetStatus | CloudflareStatus;

export interface StatusLine {
  /** `Connected`, `Off`, `Not connected`, or the one thing missing in a few words. */
  text: string;
  ok: boolean;
  /** The credential is not in the vault yet: Connect is what is missing. */
  needsConnect: boolean;
  /** The full reason, for a tooltip and the log: the setting or command that fixes it. */
  detail: string;
  /** Short, each with its full text in `detail` order. */
  warnings: Array<{ text: string; detail: string }>;
}

/** The reasons the routes give, in a few words. First match wins; the full text stays in `detail`. */
const SHORT: Array<[RegExp, string]> = [
  [/not in the vault|identity is missing in OneCLI|not assigned to nanoclaw-/i, 'Not connected'],
  [/must be in selective secret mode/i, 'OneCLI identity not selective'],
  [/OneCLI identit(y is|ies are) in "all" secret mode/i, 'OneCLI identities in all mode'],
  [/OneCLI could not be asked/i, 'OneCLI not reachable'],
  [/workloads are off/i, 'Workloads off'],
  [/app gateway is off/i, 'App gateway off'],
  [/app gateway must listen on the edge address/i, 'App gateway bind address wrong'],
  [/GATEWAY_BIND|GATEWAY_PORT|TRUSTED_PROXY_IPS/i, 'App gateway not running'],
  [/host rules for the edge network are missing/i, 'Host rules missing'],
  [/edge network check could not run/i, 'Edge network check failed'],
  [/TAILNET_DOMAIN is not set/i, 'Tailnet name missing'],
  [/TAILNET_DOMAIN must be/i, 'Tailnet name not valid'],
  [/TAILNET_TAG/i, 'Tag not valid'],
  [/CLOUDFLARE_DOMAIN is not set/i, 'App domain missing'],
  [/same site as NanoClaw/i, 'App domain is NanoClaw’s own site'],
  [/CLOUDFLARE_DOMAIN must be/i, 'App domain not valid'],
  [/ACCOUNT_ID/i, 'Account ID missing'],
  [/ZONE_ID/i, 'Zone ID missing'],
  [/TEAM_DOMAIN/i, 'Team domain missing'],
  [/WEBCHAT_CF_ACCESS_AUD/i, 'Access audience clash'],
  [/EDGE_SUBNET|TAILNET_SUBNET/i, 'Edge network setting not valid'],
  [/_IMAGE/i, 'Image setting not valid'],
  [/the tunnel is /i, 'Tunnel not healthy'],
  [/still to be (deleted|removed)/i, 'Clean-up pending'],
];

export function shortReason(kind: 'tailnet' | 'cloudflare', reason: string): string {
  for (const [re, text] of SHORT) if (re.test(reason)) return text;
  return kind === 'tailnet' ? 'Tailscale API not answering' : 'Cloudflare API not answering';
}

const sentence = (m: string): string => {
  const t = m.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function statusLine(kind: 'tailnet' | 'cloudflare', s: RouteStatus): StatusLine {
  const warnings = s.warnings.map((w) => ({ text: shortReason(kind, w), detail: sentence(w) }));
  if (s.state === 'connected') return { text: 'Connected', ok: true, needsConnect: false, detail: '', warnings };
  if (s.state === 'off') return { text: 'Off', ok: false, needsConnect: false, detail: '', warnings };
  const text = shortReason(kind, s.missing);
  return { text, ok: false, needsConnect: text === 'Not connected', detail: sentence(s.missing), warnings };
}

/** Workloads are not usable on this host: a few words, and the full reason. */
export function workloadsGate(): { text: string; detail: string } | null {
  if (!workloadsSwitchedOn()) return { text: 'Workloads off on this host', detail: sentence(OFF_REASON) };
  const p = lastPreflight();
  if (!p) return { text: 'Workloads still being checked', detail: '' };
  if (!p.ok)
    return {
      text: p.isolationOpen ? 'Workload host rules missing' : 'Workloads not available on this host',
      detail: sentence(p.reason),
    };
  return null;
}

export interface PublishingView {
  /** Why workloads cannot run here, or null. */
  gate: { text: string; detail: string } | null;
  tailnet: { on: boolean; domain: string; status: StatusLine };
  cloudflare: {
    on: boolean;
    domain: string;
    accountId: string;
    zoneId: string;
    teamDomain: string;
    status: StatusLine;
  };
}

export function publishingView(get: (k: WorkloadEnvKey) => string | undefined = workloadSetting): PublishingView {
  const g = gatewayState();
  return {
    gate:
      workloadsGate() ??
      (g.on && !g.ok && g.reason ? { text: 'App gateway not running', detail: sentence(g.reason) } : null),
    tailnet: {
      on: get('NANOCLAW_WORKLOAD_TAILNET') === '1',
      domain: get('NANOCLAW_WORKLOAD_TAILNET_DOMAIN') ?? '',
      status: statusLine('tailnet', tailnetStatus()),
    },
    cloudflare: {
      on: get('NANOCLAW_WORKLOAD_CLOUDFLARE') === '1',
      domain: get('NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN') ?? '',
      accountId: get('NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID') ?? '',
      zoneId: get('NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID') ?? '',
      teamDomain: get('NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN') ?? '',
      status: statusLine('cloudflare', cloudflareStatus()),
    },
  };
}

/** A setting the owner typed that cannot be used, with which field. */
export class SettingRefused extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

type Env = NodeJS.ProcessEnv;

function put(root: string, env: Env, key: WorkloadEnvKey, val: string): void {
  upsertEnv(root, key, val);
  env[key] = val;
}
function drop(root: string, env: Env, key: WorkloadEnvKey): void {
  removeEnv(root, key);
  delete env[key];
}
function setOrDrop(root: string, env: Env, key: WorkloadEnvKey, val: string): void {
  if (val) put(root, env, key, val);
  else drop(root, env, key);
}

const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw new SettingRefused(field, 'Must be text');
  return v.trim();
};

export interface TailnetInput {
  on?: unknown;
  domain?: unknown;
}

export function validateTailnet(i: TailnetInput): { on?: boolean; domain?: string } {
  const out: { on?: boolean; domain?: string } = {};
  if (i.on !== undefined) {
    if (typeof i.on !== 'boolean') throw new SettingRefused('on', 'Must be on or off');
    out.on = i.on;
  }
  if (i.domain !== undefined) {
    const d = text(i.domain, 'domain').toLowerCase().replace(/\.$/, '');
    if (d && !DOMAIN_RE.test(d)) throw new SettingRefused('domain', 'Not a tailnet name, e.g. tail1234.ts.net');
    out.domain = d;
  }
  return out;
}

export async function applyTailnet(root: string, i: TailnetInput, env: Env = process.env): Promise<void> {
  const v = validateTailnet(i);
  if (v.domain !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_TAILNET_DOMAIN', v.domain);
  if (v.on !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_TAILNET', v.on ? '1' : '');
  await refreshTailnetStatus().catch(() => undefined);
}

export interface CloudflareInput {
  on?: unknown;
  domain?: unknown;
  accountId?: unknown;
  zoneId?: unknown;
  teamDomain?: unknown;
}

export interface CloudflareFields {
  on?: boolean;
  domain?: string;
  accountId?: string;
  zoneId?: string;
  teamDomain?: string;
}

/**
 * Check what the owner typed. The app domain may not share a registrable
 * domain with NanoClaw's own names (its public URL, allowed hosts, tailnet
 * names): the same rule the route enforces (cloudflare/config.ts).
 */
export function validateCloudflare(i: CloudflareInput, own: string[]): CloudflareFields {
  const out: CloudflareFields = {};
  if (i.on !== undefined) {
    if (typeof i.on !== 'boolean') throw new SettingRefused('on', 'Must be on or off');
    out.on = i.on;
  }
  if (i.domain !== undefined) {
    const d = normalizeHost(text(i.domain, 'domain'));
    if (d) {
      if (!registrableDomain(d)) throw new SettingRefused('domain', 'Not a domain name');
      const clash = own.find((h) => domainConflict(d, [h]));
      if (clash) throw new SettingRefused('domain', `Same site as NanoClaw (${registrableDomain(clash)})`);
    }
    out.domain = d;
  }
  for (const [field, label] of [
    ['accountId', 'account ID'],
    ['zoneId', 'zone ID'],
  ] as const) {
    if (i[field] === undefined) continue;
    const v = text(i[field], field).toLowerCase();
    if (v && !HEX32.test(v)) throw new SettingRefused(field, `The ${label} is 32 hex characters`);
    out[field] = v;
  }
  if (i.teamDomain !== undefined) {
    const t = text(i.teamDomain, 'teamDomain')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    if (t && !TEAM_RE.test(t))
      throw new SettingRefused('teamDomain', 'Not a team domain, e.g. myteam.cloudflareaccess.com');
    out.teamDomain = t;
  }
  return out;
}

export async function applyCloudflare(root: string, i: CloudflareInput, env: Env = process.env): Promise<void> {
  const own = [...ownHostNames(env), ...(await tailnetHostNames().catch(() => []))];
  const v = validateCloudflare(i, own);
  if (v.domain !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN', v.domain);
  if (v.accountId !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID', v.accountId);
  if (v.zoneId !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID', v.zoneId);
  if (v.teamDomain !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN', v.teamDomain);
  if (v.on !== undefined) setOrDrop(root, env, 'NANOCLAW_WORKLOAD_CLOUDFLARE', v.on ? '1' : '');
  await refreshCloudflareStatus().catch(() => undefined);
}

/** An error from the vault, with anything the owner typed cut out: the secret is never shown again. */
export function scrubbed(err: unknown, typed: string[]): string {
  let m = String((err as Error)?.message ?? err);
  for (const t of typed.map((x) => x.trim()).filter((x) => x.length >= 4)) m = m.split(t).join('…');
  for (const t of typed.map((x) => x.trim()).filter((x) => x.length >= 4))
    m = m.split(Buffer.from(t).toString('base64')).join('…');
  return m.slice(0, 300);
}

/** Connect: the OAuth client goes to the vault, never kept here. */
export async function connectTailnet(
  i: { clientId?: unknown; clientSecret?: unknown },
  admin: OnecliAdmin = realOnecliAdmin,
): Promise<void> {
  if (typeof i.clientId !== 'string' || typeof i.clientSecret !== 'string')
    throw new SettingRefused('clientId', 'Enter the client ID and secret');
  try {
    await connectTailnetClient(admin, i.clientId, i.clientSecret);
  } catch (err) {
    const m = scrubbed(err, [i.clientSecret, `${i.clientId.trim()}:${i.clientSecret.trim()}`]);
    throw new SettingRefused(/secret/i.test(m) ? 'clientSecret' : 'clientId', m);
  }
  await refreshTailnetStatus().catch(() => undefined);
}

/** Connect: the API token goes to the vault, never kept here. */
export async function connectCloudflare(i: { token?: unknown }, admin: OnecliAdmin = realOnecliAdmin): Promise<void> {
  if (typeof i.token !== 'string') throw new SettingRefused('token', 'Enter the API token');
  try {
    await connectCloudflareToken(admin, i.token);
  } catch (err) {
    throw new SettingRefused('token', scrubbed(err, [i.token]));
  }
  await refreshCloudflareStatus().catch(() => undefined);
}
