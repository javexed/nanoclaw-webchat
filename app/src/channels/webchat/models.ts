/**
 * Models — orchestration helpers around the webchat_models registry.
 *
 *   1. Container plumbing — an assigned model becomes an env override block in
 *      the agent's already-mounted settings.json (writeAgentSettingsForAssignedModel),
 *      so the container.json schema stays untouched.
 *   2. External I/O — Ollama discovery + health checks, best-effort and
 *      fail-soft so an unreachable endpoint doesn't block save/discover.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import dns from 'node:dns/promises';
import net from 'node:net';

import { DATA_DIR } from '../../config.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';
import { log } from '../../log.js';
import { readEnvFile } from '../../env.js';
import { getAssignedModelForAgent, getEffectiveModelForAgent, type WebchatModel } from './db.js';
import { agentRouterBase, CLOUD_PROVIDERS, cloudModelMaxOutput, routerAuthHeaders } from './cloud-models.js';
import { upsertEnv } from './env-write.js';
import { isMovedOffHost, spawnModel } from './model-host-health.js';
import { agentModelUrl, RELAY_HOST, remoteModelTarget } from './model-relay.js';
import { fetchOllamaModelMeta, servedModelLimits } from './ollama-context.js';
import { refreshOllamaLenient } from './ollama-lenient.js';

// ─── SSRF defense for owner-supplied probe/discover/validate URLs ─────────
// Probe, Ollama discovery and openai-compat reachability all fetch() an
// operator-typed URL. Ungated, an owner (or whoever races the first-login
// owner grant) could reach host-internal services — above all cloud metadata
// (169.254.169.254): the probe is blind, but timing confirms reachability and
// any future body surfacing would make it a read primitive.
//
// Always blocked: link-local (all cloud metadata IPs), 0.0.0.0/8, multicast,
// non-http(s) schemes. NOT blocked by default: loopback, RFC1918, CGNAT
// (Tailscale) — the legit Ollama-on-LAN destinations. Hardened installs opt
// into blocking those with `WEBCHAT_BLOCK_PRIVATE_IPS=true`.
const BLOCKED_HOSTNAME_SUFFIXES = ['metadata.google.internal', 'metadata.azure.com', 'metadata.azure.internal'];

interface IpRange {
  cidr: string;
  test: (ip: string) => boolean;
}

const ALWAYS_BLOCKED_RANGES: IpRange[] = [
  // Link-local IPv4 — includes cloud metadata (AWS/GCP at 169.254.169.254,
  // Azure at 169.254.169.254 too, Alibaba at 100.100.100.200 — that one's
  // CGNAT not link-local, the env opt-in covers it).
  { cidr: '169.254.0.0/16', test: (ip) => ip.startsWith('169.254.') },
  // 0.0.0.0/8 — "this network", invalid as a fetch target but some hosts
  // resolve "this host" to 0.0.0.0 which fetches the bound-to-all listener.
  { cidr: '0.0.0.0/8', test: (ip) => ip.startsWith('0.') },
  // Multicast — never a legit unicast HTTP destination.
  {
    cidr: '224.0.0.0/4',
    test: (ip) => {
      const first = parseInt(ip.split('.')[0], 10);
      return first >= 224 && first <= 239;
    },
  },
  // Link-local IPv6 (fe80::/10) and unspecified.
  {
    cidr: 'fe80::/10',
    test: (ip) =>
      ip.toLowerCase().startsWith('fe80:') ||
      ip.toLowerCase().startsWith('fe9') ||
      ip.toLowerCase().startsWith('fea') ||
      ip.toLowerCase().startsWith('feb'),
  },
  { cidr: '::', test: (ip) => ip === '::' || ip === '::0' },
];

const PRIVATE_RANGES: IpRange[] = [
  { cidr: '127.0.0.0/8', test: (ip) => ip.startsWith('127.') },
  { cidr: '10.0.0.0/8', test: (ip) => ip.startsWith('10.') },
  {
    cidr: '172.16.0.0/12',
    test: (ip) => {
      if (!ip.startsWith('172.')) return false;
      const n = parseInt(ip.split('.')[1], 10);
      return n >= 16 && n <= 31;
    },
  },
  { cidr: '192.168.0.0/16', test: (ip) => ip.startsWith('192.168.') },
  // CGNAT (Tailscale uses 100.64.0.0/10)
  {
    cidr: '100.64.0.0/10',
    test: (ip) => {
      if (!ip.startsWith('100.')) return false;
      const n = parseInt(ip.split('.')[1], 10);
      return n >= 64 && n <= 127;
    },
  },
  // Loopback / unique-local / site-local IPv6
  { cidr: '::1', test: (ip) => ip === '::1' },
  { cidr: 'fc00::/7', test: (ip) => /^f[cd]/.test(ip.toLowerCase()) },
];

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(ip: string): number[] | null {
  if (net.isIPv6(ip) === false) return null;
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address an IPv6 one carries, if any: IPv4-mapped (::ffff:a.b.c.d),
 * IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4
 * (2002:aabb:ccdd::). Each reaches the IPv4 host, so each is judged as it.
 */
function embeddedIpv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

function isBlockedIp(ip: string): { blocked: boolean; reason?: string } {
  const inner = embeddedIpv4(ip);
  if (inner) {
    const check = isBlockedIp(inner);
    return check.blocked ? { blocked: true, reason: `${check.reason} (inside ${ip})` } : check;
  }
  for (const r of ALWAYS_BLOCKED_RANGES) {
    if (r.test(ip)) return { blocked: true, reason: `IP ${ip} is in always-blocked range ${r.cidr}` };
  }
  if (process.env.WEBCHAT_BLOCK_PRIVATE_IPS === 'true') {
    for (const r of PRIVATE_RANGES) {
      if (r.test(ip))
        return { blocked: true, reason: `IP ${ip} is in private range ${r.cidr} (WEBCHAT_BLOCK_PRIVATE_IPS=true)` };
    }
  }
  return { blocked: false };
}

/**
 * Validate that a URL is safe to fetch from the host process. Throws on:
 *   - invalid URL or non-http(s) scheme
 *   - hostname matching a known cloud-metadata FQDN
 *   - hostname resolving to an always-blocked IP range
 *   - (with WEBCHAT_BLOCK_PRIVATE_IPS=true) hostname resolving to a
 *     private/loopback/CGNAT range
 *
 * Resolves via OS DNS (the same resolver fetch() uses), then iterates all
 * resolved addresses — DNS rebinding defense is best-effort here since
 * fetch() may resolve again, but a TTL=0 race is a known limit of any
 * in-process SSRF gate.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid URL: ${rawUrl}`, { cause: err });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http/https URLs allowed; got ${url.protocol}`);
  }
  // An IPv6 literal keeps its brackets in URL.hostname, and dns.lookup can't
  // resolve the bracketed form — strip them so the literal is checked.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const check = isBlockedIp(host);
    if (check.blocked) throw new Error(check.reason ?? `IP ${host} blocked`);
    return;
  }
  for (const suf of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host === suf || host.endsWith('.' + suf)) {
      throw new Error(`Blocked hostname: ${host}`);
    }
  }
  // dns.lookup uses the OS resolver — same one fetch() consults.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    // Fail closed: a name this resolver can't vouch for is not fetched.
    throw new Error(`Could not resolve ${host}`, { cause: err });
  }
  for (const a of addrs) {
    const check = isBlockedIp(a.address);
    if (check.blocked) throw new Error(check.reason ?? `IP ${a.address} blocked`);
  }
}

// Endpoints are registered as reachable FROM THE HOST (probe, save-validation)
// but consumed FROM INSIDE DOCKER: loopback is a different machine in each, and
// host.docker.internal resolves only in containers (the --add-host alias).
/** Container-facing form: loopback → host.docker.internal. For env writes. */
export function containerReachableUrl(url: string): string {
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, '$1host.docker.internal');
}

/** Host-facing form: host.docker.internal → 127.0.0.1. For host-side fetches. */
export function hostReachableUrl(url: string): string {
  return url.replace(/^(https?:\/\/)host\.docker\.internal(?=[:/]|$)/, '$1127.0.0.1');
}

/**
 * Drop-in fetch wrapper that runs assertSafeOutboundUrl first. Throws the
 * same errors fetch would for unreachable hosts plus our SSRF rejections.
 * Use this for ANY fetch where the URL came from operator input.
 *
 * Fetches run on the host, so the container-only alias is translated to
 * loopback first — an operator can paste either form and both probe and
 * save-validation just work.
 */
/**
 * The provider's own complaint inside an error body, in a few words: LiteLLM
 * wraps it ("…Exception - {"message":"model 'x' not found…"}"), others give
 * error.message or a bare string.
 */
export function shortModelError(status: number, text: string): string {
  let msg = text;
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    const e = j.error as { message?: unknown } | string | undefined;
    msg = String((typeof e === 'object' && e?.message) || (typeof e === 'string' && e) || j.message || text);
  } catch {
    /* plain text */
  }
  const inner = [...msg.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].pop()?.[1];
  if (inner) msg = inner.replace(/\\"/g, '"');
  msg = msg.replace(/^litellm\.\w+:\s*/i, '').replace(/^\w+Exception\s*-\s*/, '');
  msg = msg
    .split(/(?<=[a-z0-9'])\.\s/i)[0]
    .trim()
    .replace(/\.$/, '');
  return (msg || `HTTP ${status}`).slice(0, 120);
}

/**
 * One tiny completion through a model's endpoint (OpenAI chat shape, which
 * Ollama and LiteLLM both serve): proof the model answers, the key included.
 */
export async function testModel(m: { kind: string; endpoint: string | null; model_id: string }): Promise<{
  ok: boolean;
  ms?: number;
  error?: string;
}> {
  if (m.kind === 'anthropic' || !m.endpoint) return { ok: false, error: 'Not testable' };
  const base = m.endpoint.replace(/\/+$/, '');
  const url = `${/\/v1$/.test(base) ? base : `${base}/v1`}/chat/completions`;
  const started = Date.now();
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m.model_id, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return { ok: true, ms: Date.now() - started };
    return { ok: false, error: shortModelError(res.status, await res.text()) };
  } catch (err) {
    return { ok: false, error: shortModelError(0, String((err as Error)?.message ?? err)) };
  }
}

function headersObject(h: RequestInit['headers']): Record<string, string> {
  return h ? Object.fromEntries(new Headers(h).entries()) : {};
}

export interface SafeFetchOptions {
  /**
   * 'refuse' treats any 3xx as an error instead of following it. For requests
   * that carry a credential (a token grant, a client registration): even a
   * re-validated 307/308 would replay that body to a host the caller never
   * chose.
   */
  redirects?: 'follow' | 'refuse';
  /** false never adds the local router's master key, whatever the target. */
  routerAuth?: boolean;
}

export async function safeFetch(url: string, init?: RequestInit, opts: SafeFetchOptions = {}): Promise<Response> {
  const MAX_HOPS = 5;
  let target = hostReachableUrl(url);
  let reqInit: RequestInit = { ...init };
  // The router on loopback wants its master key (cloud models); nothing else
  // gets it. Decided once, from the URL the caller chose: a redirect hop never
  // carries it, wherever it points — the router's port included, so a
  // redirect from elsewhere cannot steer the key there, and one from the
  // router cannot carry it away.
  const routerAuth = opts.routerAuth === false ? {} : routerAuthHeaders(target);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // Re-run the SSRF gate on EVERY hop. `redirect: 'manual'` stops fetch from
    // silently following a 3xx to 169.254.169.254 / a private host without a
    // check — the whole point of the gate. (Node/undici exposes the redirect
    // status + Location header under 'manual'.)
    await assertSafeOutboundUrl(target);
    const auth = hop === 0 ? routerAuth : {};
    const headers = Object.keys(auth).length ? { ...headersObject(reqInit.headers), ...auth } : reqInit.headers;
    const res = await fetch(target, { ...reqInit, headers, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res; // not a redirect → done
    if (opts.redirects === 'refuse')
      throw new Error(`safeFetch: refusing a redirect (HTTP ${res.status}) from ${target}`);
    const location = res.headers.get('location');
    if (!location) throw new Error(`safeFetch: refusing an un-inspectable redirect from ${target}`);
    target = new URL(location, target).toString();
    // 307/308 preserve method + body; 301/302/303 downgrade to a bodyless GET
    // (standard redirect semantics) so a POST body isn't replayed to a new host.
    if (res.status !== 307 && res.status !== 308) reqInit = { ...reqInit, method: 'GET', body: undefined };
  }
  throw new Error(`safeFetch: too many redirects starting at ${url}`);
}

// Anthropic model ids — a SUGGESTION source for the pickers, never a gate: an
// install outlives this list, and refusing a model Anthropic has since shipped
// is worse than accepting a typo (which surfaces on the agent's next turn).
// Update when Anthropic ships new models.
export const KNOWN_ANTHROPIC_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

/**
 * Shape gate for an operator-supplied Anthropic model id, used by the agent
 * "Anthropic model" field. Deliberately permissive about WHICH model (see
 * KNOWN_ANTHROPIC_MODELS) and strict only about the characters, so a stray
 * shell fragment or a pasted URL can't land in container_configs.model — the
 * value is handed to the Claude Agent SDK as its `model` option.
 */
export function isPlausibleAnthropicModelId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,72}(\[[a-z0-9]{1,8}\])?$/.test(id);
}

/**
 * Container-reachable learning-classifier params for a roster model, or null if
 * the model can't serve one (anthropic kind, or no endpoint). The classifier
 * runner makes an OpenAI-format `/v1/chat/completions` call, so 127.0.0.1/
 * localhost is rewritten to the docker host-gateway. Shared by the Settings
 * override (explicit pick) and the auto-default resolver (agent's own model).
 */
export function classifierParamsForModel(model: WebchatModel | null): { url: string; model: string } | null {
  if (!model || (model.kind !== 'ollama' && model.kind !== 'openai-compatible') || !model.endpoint) return null;
  const reachable = model.endpoint
    .replace(/\/+$/, '')
    .replace(/\/\/(127\.0\.0\.1|localhost)(:|\/|$)/, '//host.docker.internal$2');
  const url = /\/v1(\/|$)/.test(reachable)
    ? `${reachable.replace(/\/v1.*$/, '')}/v1/chat/completions`
    : `${reachable}/v1/chat/completions`;
  return { url, model: model.model_id };
}

/**
 * Claude Code's model aliases, all pointed at a local or cloud model. A pinned
 * alias (a runner's "sonnet", container_configs.model) reaches the SDK as an
 * explicit model and outranks ANTHROPIC_MODEL, and the background calls go to
 * the haiku alias: unmapped, both ask this endpoint for a Claude model it does
 * not serve.
 */
function aliasEnv(modelId: string): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
  };
}

/**
 * The env-var overrides for a model; empty when nothing needs to change (the
 * caller uses that to wipe the env block).
 *
 *   anthropic          → ANTHROPIC_MODEL.
 *   ollama             → ANTHROPIC_BASE_URL at the Ollama root (it serves the
 *                        Anthropic API at /v1/messages) + ANTHROPIC_MODEL + NO_PROXY.
 *   openai-compatible  → ANTHROPIC_BASE_URL at the router (LiteLLM serves the
 *                        Anthropic spec) + ANTHROPIC_MODEL + NO_PROXY.
 * Both endpoint kinds also map Claude Code's aliases to the model (aliasEnv).
 */
export function envForModel(model: WebchatModel | null): Record<string, string> {
  if (!model) return {};
  if (model.kind === 'anthropic') {
    return { ANTHROPIC_MODEL: model.model_id };
  }
  if (model.kind === 'ollama') {
    if (!model.endpoint) return {};
    // ANTHROPIC_BASE_URL must be the bare Ollama root: the SDK appends the full
    // `/v1/messages` path itself, so a `/v1` here 404s as `/v1/v1/messages`.
    const base = containerReachableUrl(model.endpoint.replace(/\/+$/, ''));
    // The container routes model calls through the OneCLI credential proxy
    // (HTTP_PROXY/HTTPS_PROXY from the gateway env). A redirected Ollama
    // endpoint must BYPASS it — the proxy only fronts known providers and
    // resets anything else (surfaces as "API Error: ECONNRESET" from the
    // agent). Same requirement as /add-ollama-provider; see docs/ollama.md.
    let host = 'host.docker.internal';
    try {
      host = new URL(base).hostname;
    } catch {
      /* keep the default alias */
    }
    return {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_MODEL: model.model_id,
      ...aliasEnv(model.model_id),
      NO_PROXY: host,
      no_proxy: host,
    };
  }
  if (model.kind === 'openai-compatible') {
    // Direct path — no OpenCode hop. LiteLLM serves the Anthropic-spec
    // /v1/messages endpoint for every model it fronts, so the default Claude
    // SDK talks to it natively: same contract as the `ollama` kind above.
    // Registry endpoints conventionally carry their OpenAI-format `/v1`
    // suffix; strip it — the SDK appends the full `/v1/messages` path itself
    // (LiteLLM serves it at the root, like Ollama).
    if (!model.endpoint) return {};
    // A cloud model (Models → Cloud model) refuses a reply longer than its
    // provider allows, and Claude Code asks for 32k unless told.
    const maxOutput = cloudModelMaxOutput(model.model_id, model.endpoint);
    // The router behind the gateway (it serves cloud models): dialed by its
    // container name THROUGH the gateway, which adds the router's key. No
    // bypass, or the request would go out without it.
    const viaGateway = agentRouterBase(model.endpoint);
    if (viaGateway) {
      return {
        ANTHROPIC_BASE_URL: viaGateway,
        ANTHROPIC_MODEL: model.model_id,
        ...aliasEnv(model.model_id),
        ...(maxOutput ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput) } : {}),
      };
    }
    const base = containerReachableUrl(model.endpoint.replace(/\/+$/, '').replace(/\/v1$/, ''));
    let host = 'host.docker.internal';
    try {
      host = new URL(base).hostname;
    } catch {
      /* keep the default alias */
    }
    return {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_MODEL: model.model_id,
      ...aliasEnv(model.model_id),
      // Bypass the OneCLI credential proxy for the local router — same
      // requirement (and same failure mode) as the ollama kind.
      NO_PROXY: host,
      no_proxy: host,
      ...(maxOutput ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput) } : {}),
    };
  }
  return {};
}

function agentSettingsPath(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'settings.json');
}

/** The model env settings.json should carry for this agent now, and the model it is for. */
async function modelSettingsEnv(
  agentGroupId: string,
): Promise<{ model: WebchatModel | null; overrides: Record<string, string> }> {
  // Per-agent assignment wins; a claude-family group WITHOUT one falls back to
  // the workspace default model (wizard "default engine = Ollama"). Groups on
  // a non-default provider (e.g. codex) never inherit the fallback — their
  // harness doesn't read the ANTHROPIC_* env this writes.
  let model = await getAssignedModelForAgent(agentGroupId);
  if (!model) {
    const provider = (await getContainerConfig(agentGroupId))?.provider;
    if (!provider || provider === 'claude') model = await getEffectiveModelForAgent(agentGroupId);
  }
  const overrides = envForModel(spawnModel(model, agentGroupId));
  // Behind the egress filter a model on another machine is reached through its relay.
  if (overrides.ANTHROPIC_BASE_URL && overrides.NO_PROXY) {
    const base = await agentModelUrl(agentGroupId, overrides.ANTHROPIC_BASE_URL);
    if (base !== overrides.ANTHROPIC_BASE_URL)
      Object.assign(overrides, { ANTHROPIC_BASE_URL: base, NO_PROXY: RELAY_HOST, no_proxy: RELAY_HOST });
  }
  return { model, overrides };
}

/**
 * Whether settings.json names another model URL or model than the agent
 * should dial now. A failover host written while its own host was down is
 * persistent, but what restores it (model-host-health.ts) is not: after a
 * host restart nothing else would put the agent back on its own host.
 */
async function modelSettingsStale(agentGroupId: string): Promise<boolean> {
  const { model, overrides } = await modelSettingsEnv(agentGroupId);
  if (!model) return false; // nothing assigned: keys there are the operator's
  let env: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(agentSettingsPath(agentGroupId), 'utf8')) as { env?: unknown };
    if (raw.env && typeof raw.env === 'object') env = raw.env as Record<string, unknown>;
  } catch {
    return false; // no settings yet: the first write comes with the folder
  }
  return env.ANTHROPIC_BASE_URL !== overrides.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL !== overrides.ANTHROPIC_MODEL;
}

/**
 * Write the model's env overrides into the agent's per-group settings.json.
 *
 * Path: data/v2-sessions/<agent_group_id>/.claude-shared/settings.json
 * Mount: that dir is mounted at /home/node/.claude inside the container, so
 *        Claude Code reads it as the user settings source. The SDK applies
 *        the `env` block to the process at startup.
 *
 * Effect timing: takes effect on the NEXT container spawn for this agent.
 * Existing containers keep using the env they were started with. (The
 * sweep recycles idle containers on a short timer, and any wake after this
 * write picks up the new env.)
 *
 * Idempotent. Preserves any pre-existing env keys we don't manage.
 */
export async function writeAgentSettingsForAssignedModel(agentGroupId: string): Promise<void> {
  // First, and even for a group with no folder yet: the spawn path reads this
  // before its prepare hooks run (./ollama-lenient.ts).
  await refreshOllamaLenient(agentGroupId);
  const { overrides } = await modelSettingsEnv(agentGroupId);

  const settingsPath = agentSettingsPath(agentGroupId);
  if (!fs.existsSync(path.dirname(settingsPath))) {
    // Folder hasn't been initialized yet — nothing to write. The first
    // resolveSession will create it; we'll re-run this then.
    return;
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // corrupt — start fresh, log so the operator notices
      log.warn('Webchat: settings.json unparseable, rewriting from scratch', { agentGroupId });
    }
  }
  const existingEnv = (
    typeof existing.env === 'object' && existing.env !== null ? (existing.env as Record<string, string>) : {}
  ) as Record<string, string>;

  // Strip any keys we manage from the existing env so removing the
  // assignment fully clears them. Cover both Anthropic-shaped and
  // OpenAI-shaped overrides — switching kinds (e.g. ollama → openai-
  // compatible) shouldn't leave the previous shape's env vars behind.
  const cleaned = { ...existingEnv };
  delete cleaned.ANTHROPIC_BASE_URL;
  delete cleaned.ANTHROPIC_MODEL;
  delete cleaned.OPENAI_BASE_URL;
  delete cleaned.OPENAI_MODEL;
  delete cleaned.NO_PROXY;
  delete cleaned.no_proxy;
  // Only when this writer put it there: an operator's own value (an output cap, an alias) stays, and wins.
  const ownedPath = path.join(path.dirname(settingsPath), OWNED_ENV_FILE);
  const owned = readOwnedEnv(ownedPath);
  for (const k of OWNED_ENV_KEYS) {
    const v = cleaned[k];
    if (v === undefined) continue;
    if (owned[k] ? owned[k] === envHash(v) : legacyOwned(k, v)) delete cleaned[k];
    else delete overrides[k];
  }

  const merged = { ...existing, env: { ...cleaned, ...overrides } };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  const nextOwned: Record<string, string> = {};
  for (const k of OWNED_ENV_KEYS) if (overrides[k] !== undefined) nextOwned[k] = envHash(overrides[k]);
  if (Object.keys(nextOwned).length) fs.writeFileSync(ownedPath, JSON.stringify(nextOwned) + '\n');
  else fs.rmSync(ownedPath, { force: true });
}

/**
 * At spawn: whether a model on another machine is dialed directly or through
 * its relay follows the agent's network mode, which may have changed since
 * the model was picked — so its settings are written again. So are those of
 * a model whose host is down, or was at the last spawn (model-host-health.ts),
 * and of any model whose written URL is not the one it should dial now.
 */
export async function refreshRemoteModelSettings(agentGroupId: string): Promise<void> {
  const wasMoved = isMovedOffHost(agentGroupId);
  const model = await getEffectiveModelForAgent(agentGroupId);
  if (
    remoteModelTarget(model?.endpoint) ||
    wasMoved ||
    spawnModel(model, agentGroupId) !== model ||
    (await modelSettingsStale(agentGroupId))
  )
    await writeAgentSettingsForAssignedModel(agentGroupId);
}

/** settings.json env keys written only for some models, and removed only when this writer wrote them. */
const OWNED_ENV_KEYS = [
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;
/** Beside settings.json: a hash of each such value as written (the agent can read this folder). */
const OWNED_ENV_FILE = 'model-env-owned.json';
const envHash = (v: string): string => createHash('sha256').update(v).digest('hex');

function readOwnedEnv(file: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Before ownership was recorded, a provider's cap was the only output cap this writer set. */
function legacyOwned(key: string, value: string): boolean {
  return key === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' && CLOUD_PROVIDERS.some((p) => String(p.maxOutput) === value);
}

/** OpenCode is installed iff its provider container-config is registered. */
function opencodeInstalled(): boolean {
  return listProviderContainerConfigNames().includes('opencode');
}

/** pi (the minimal local harness, add-pi-stack) — same registration test. */
function piInstalled(): boolean {
  return listProviderContainerConfigNames().includes('pi');
}

/**
 * The harness a model runs on by default: Ollama on pi or OpenCode; a cloud
 * model on OpenCode (through the router; pi is for small local models); null,
 * the Claude harness, for an Anthropic model, the routing model, or when no
 * local harness is installed. Claude Code under another vendor's model told
 * it that it was Claude, from its own system prompt.
 */
export function providerForModel(
  model: Pick<WebchatModel, 'kind' | 'endpoint' | 'model_id'> | null | undefined,
): 'opencode' | 'pi' | null {
  if (!model) return null;
  if (model.kind === 'ollama') return providerForModelKind('ollama');
  if (model.kind === 'openai-compatible' && openCodeBackendEnv(model as WebchatModel) && opencodeInstalled())
    return 'opencode';
  return null;
}

/** Harnesses that bring their own model and sign-in: the registry's models do not apply to them. */
export const OWN_MODEL_HARNESSES: ReadonlySet<string> = new Set(['codex', 'grok']);

/**
 * Whether a harness can run this model (null: none assigned, its own default).
 * Claude: Anthropic models, and anything no local harness here can run (the
 * routing model, a cloud model without OpenCode). OpenCode: local and cloud
 * models. pi: local models. Codex and Grok: no registry model at all.
 */
export function harnessFits(
  provider: string | null | undefined,
  model: Pick<WebchatModel, 'kind' | 'endpoint' | 'model_id'> | null | undefined,
): boolean {
  const p = provider || 'claude';
  if (!model) return true;
  if (OWN_MODEL_HARNESSES.has(p)) return false;
  if (p === 'claude') return model.kind === 'anthropic' || providerForModel(model) === null;
  if (p === 'opencode') return !!openCodeBackendEnv(model as WebchatModel);
  if (p === 'pi') return model.kind === 'ollama';
  return true;
}

/** Why a switch to `provider` is refused for this model, or null. Codex and Grok ignore the registry model. */
export function harnessSwitchRefusal(
  provider: string,
  model: Pick<WebchatModel, 'kind' | 'endpoint' | 'model_id' | 'name'> | null | undefined,
): string | null {
  if (OWN_MODEL_HARNESSES.has(provider) || harnessFits(provider, model)) return null;
  if (provider === 'claude') return `Claude runs Anthropic models only, and this agent's model is ${model!.name}`;
  if (provider === 'pi') return `pi runs local models only, and this agent's model is ${model!.name}`;
  return `${provider === 'opencode' ? 'OpenCode' : provider} cannot run ${model!.name}`;
}

/**
 * Which provider a model kind runs on. A small Ollama model follows tools and
 * format far better on a local harness, so once one is installed an Ollama agent
 * DEFAULTS to it; every other kind stays on the default Claude provider
 * (openai-compatible/LiteLLM is consumed via its Anthropic-spec surface).
 *
 * pi outranks OpenCode: pi replaces the system prompt outright, while OpenCode
 * keeps a coding preamble that eats a small model's context.
 *
 * Derived from the model, not a user-facing choice; an explicit pick still wins
 * (syncAgentProviderForAssignedModel).
 */
export function providerForModelKind(kind: string | null | undefined): 'opencode' | 'pi' | null {
  if (kind !== 'ollama') return null;
  if (piInstalled()) return 'pi';
  if (opencodeInstalled()) return 'opencode';
  return null;
}

export const OPENCODE_DEFAULT_CONTEXT_LIMIT = 32768;
export const OPENCODE_DEFAULT_OUTPUT_LIMIT = 8192;

/**
 * The install-wide OpenCode keys an Ollama roster model maps onto. Pure; null
 * for any other kind or a model without an endpoint. The provider id is
 * `openai` — upstream pins the OpenAI-compatible transport to that id — not
 * `ollama`.
 */
export function openCodeBackendEnv(
  model: WebchatModel,
): { env: Record<string, string>; proxyHost: string | null } | null {
  // An Ollama model, or a cloud model the router serves (Models → Cloud model):
  // both speak OpenAI chat. Other openai-compatible registrations (routing
  // backends) stay off this path.
  const cloudCap = model.kind === 'openai-compatible' ? cloudModelMaxOutput(model.model_id, model.endpoint) : null;
  if (!model.endpoint || (model.kind !== 'ollama' && cloudCap === null)) return null;
  // OpenCode speaks OpenAI-compat at /v1/chat/completions, so the base URL
  // takes the /v1 suffix; registry endpoints may already carry it.
  // The router behind the gateway: through it, by container name, never bypassed.
  const viaGateway = agentRouterBase(model.endpoint);
  const base = (viaGateway ?? containerReachableUrl(model.endpoint.replace(/\/+$/, '').replace(/\/v1$/, ''))) + '/v1';
  let proxyHost: string | null = 'host.docker.internal';
  try {
    proxyHost = new URL(base).hostname;
  } catch {
    /* keep the alias */
  }
  if (viaGateway) proxyHost = null;
  return {
    env: {
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: base,
      OPENCODE_MODEL: `openai/${model.model_id}`,
      // Main and small model together, as upstream's own setup writes them
      // (add-opencode scripts/opencode-auth.ts). Picking a model here never runs
      // that setup, so left alone the small model (titles, summaries) would stay
      // on whatever setup chose, which this endpoint may not serve.
      OPENCODE_SMALL_MODEL: `openai/${model.model_id}`,
      // A provider refuses a reply over its cap (Cohere: 8192), so it is set outright.
      ...(cloudCap ? { OPENCODE_MODEL_OUTPUT_LIMIT: String(cloudCap) } : {}),
    },
    proxyHost,
  };
}

function mergeNoProxy(current: string | undefined, host: string): string {
  const parts = new Set(
    (current ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  parts.add(host);
  return [...parts].join(',');
}

/**
 * Point the install's OpenCode at this model's backend. Provider, base URL and
 * model are set outright; the two limits only if absent, so an operator's
 * values stick. NO_PROXY is merged into .env AND into this process's env:
 * upstream's host provider reads the host process env and does not fall back
 * to .env for NO_PROXY, so the process copy is what reaches the container.
 */
export function syncOpenCodeBackendEnv(model: WebchatModel, root = process.cwd()): boolean {
  const backend = openCodeBackendEnv(model);
  if (!backend) return false;
  for (const [k, v] of Object.entries(backend.env)) upsertEnv(root, k, v);
  const have = readEnvFile(['OPENCODE_MODEL_CONTEXT_LIMIT', 'OPENCODE_MODEL_OUTPUT_LIMIT', 'NO_PROXY'], root);
  if (!have.OPENCODE_MODEL_CONTEXT_LIMIT) {
    upsertEnv(root, 'OPENCODE_MODEL_CONTEXT_LIMIT', String(OPENCODE_DEFAULT_CONTEXT_LIMIT));
  }
  if (!have.OPENCODE_MODEL_OUTPUT_LIMIT) {
    upsertEnv(root, 'OPENCODE_MODEL_OUTPUT_LIMIT', String(OPENCODE_DEFAULT_OUTPUT_LIMIT));
  }
  if (backend.proxyHost) {
    upsertEnv(root, 'NO_PROXY', mergeNoProxy(have.NO_PROXY, backend.proxyHost));
    process.env.NO_PROXY = mergeNoProxy(process.env.NO_PROXY, backend.proxyHost);
    process.env.no_proxy = process.env.NO_PROXY;
  }
  log.info('Webchat: OpenCode backend set', { base: backend.env.OPENCODE_BASE_URL, model: backend.env.OPENCODE_MODEL });
  return true;
}

/**
 * Per-agent OpenCode env at spawn, over the install-wide keys above (the
 * container-env seam wins a collision):
 *
 *   - this agent's own backend (provider, base URL, model, small model), for
 *     any model OpenCode can use: the install-wide keys are one .env for every
 *     agent, so they hold whichever agent synced last;
 *   - the window Ollama serves the model with (ollama-context.ts), unless the
 *     operator set the limits: values other than the defaults written above;
 *   - for an agent behind the egress filter, a model on another machine
 *     through its relay (model-relay.ts).
 *
 * Empty for any other provider or model.
 */
export async function openCodeSpawnEnv(agentGroupId: string): Promise<Record<string, string>> {
  if ((await getContainerConfig(agentGroupId))?.provider !== 'opencode') return {};
  const own = await getEffectiveModelForAgent(agentGroupId);
  // OpenCode's model id is the container config's: a down host is left for another serving the same id only.
  const moved = spawnModel(own, agentGroupId);
  const model = moved?.model_id === own?.model_id ? moved : own;
  const backend = model ? openCodeBackendEnv(model) : null;
  if (!model?.endpoint || !backend) return {};
  // A cloud agent was sent an Ollama model's name and URL another agent's sync
  // had left in .env: "model 'qwen3:8b-ctx12k' not found".
  const out: Record<string, string> = { ...backend.env };
  if (model.kind !== 'ollama') return out;
  const base = backend.env.OPENCODE_BASE_URL;
  const ownBase = model === own ? base : own && openCodeBackendEnv(own)?.env.OPENCODE_BASE_URL;
  const file = readEnvFile(['OPENCODE_MODEL_CONTEXT_LIMIT', 'OPENCODE_MODEL_OUTPUT_LIMIT']);
  const context = process.env.OPENCODE_MODEL_CONTEXT_LIMIT ?? file.OPENCODE_MODEL_CONTEXT_LIMIT;
  const output = process.env.OPENCODE_MODEL_OUTPUT_LIMIT ?? file.OPENCODE_MODEL_OUTPUT_LIMIT;
  const ours = (v: string | undefined, d: number): boolean => !v || v === String(d);
  if (ours(context, OPENCODE_DEFAULT_CONTEXT_LIMIT) && ours(output, OPENCODE_DEFAULT_OUTPUT_LIMIT)) {
    const meta = await fetchOllamaModelMeta(model.endpoint, model.model_id);
    if (meta) {
      const limits = servedModelLimits(meta);
      out.OPENCODE_MODEL_CONTEXT_LIMIT = String(limits.contextWindow);
      out.OPENCODE_MODEL_OUTPUT_LIMIT = String(limits.maxTokens);
    }
  }
  const relayed = await agentModelUrl(agentGroupId, base);
  if (relayed !== ownBase) {
    out.OPENCODE_BASE_URL = relayed;
    // Upstream's provider exempts loopback only; the relay (or the other host) is dialed by name.
    const noProxy = ['127.0.0.1', 'localhost', new URL(relayed).hostname].reduce(
      mergeNoProxy,
      process.env.NO_PROXY ?? '',
    );
    out.NO_PROXY = out.no_proxy = noProxy;
  }
  return out;
}

/**
 * Keep the agent group's provider in lockstep with its EFFECTIVE model (per-agent
 * assignment OR the workspace default): Ollama → OpenCode when installed, else the
 * default Claude provider. Also carries the model to the harness: OpenCode reads
 * the group's container_configs.model, else OPENCODE_MODEL in .env (upstream's
 * provider, not this file) — both written here from the effective model, so the
 * pick made in the UI is what runs; pi reads the per-agent local-model file
 * instead. Idempotent.
 */
export async function syncAgentProviderForAssignedModel(agentGroupId: string): Promise<void> {
  // Only manage the local-harness axis (Claude ↔ OpenCode ↔ pi). Any OTHER
  // non-default provider (e.g. codex) is an explicit harness the webchat model
  // registry doesn't own — never clobber it. Within the managed axis, an explicit
  // OpenCode/pi choice (Agent → Harness) is sticky when installed; a
  // stale/uninstalled one is un-wedged to the default so the group can spawn.
  const row = await getContainerConfig(agentGroupId);
  const current = row?.provider;
  const managed = !current || current === 'claude' || current === 'opencode' || current === 'pi';
  // Decide on the EFFECTIVE model so a workspace-default local model (wizard
  // "default engine = Ollama") auto-uses OpenCode too, not only per-agent picks.
  const model = await getEffectiveModelForAgent(agentGroupId);
  // Sticky only while it can run the model: pi given a cloud model moves on.
  const sticky =
    ((current === 'opencode' && opencodeInstalled()) || (current === 'pi' && piInstalled())) &&
    harnessFits(current, model);
  await ensureContainerConfig(agentGroupId);
  let provider = current ?? null;
  if (managed && !sticky) {
    provider = providerForModel(model);
    await updateContainerConfigScalars(agentGroupId, { provider });
  }
  await syncHarnessModel(agentGroupId);
  await writeLocalModelForAgent(agentGroupId);
}

/**
 * The harness's own model field, from the effective model: on OpenCode,
 * `openai/<id>` (it reads container_configs.model first, so a runner's
 * "sonnet" there would win); off it, the one this module wrote is cleared,
 * never an operator's ncl-set model. Also run on a harness switch, which
 * changes the provider without a model change.
 */
export async function syncHarnessModel(agentGroupId: string): Promise<void> {
  const row = await getContainerConfig(agentGroupId);
  const model = await getEffectiveModelForAgent(agentGroupId);
  if (row?.provider === 'opencode' && model && syncOpenCodeBackendEnv(model)) {
    await updateContainerConfigScalars(agentGroupId, { model: `openai/${model.model_id}` });
  } else if (row?.model?.startsWith('openai/')) {
    await updateContainerConfigScalars(agentGroupId, { model: null });
  }
}

/**
 * Per-agent local-model wiring, read by pi (upstream's opencode provider reads
 * container_configs.model instead). Written only for a pi group with an
 * Ollama-kind effective model, removed otherwise; written only once the folder exists, like
 * writeAgentSettingsForAssignedModel. Readers fall back to the legacy name, so
 * the writer removes it to keep one source of truth.
 */
export const LOCAL_MODEL_FILE = 'local-model.json';
/** Pre-rename name. Written by no one; still read as a fallback. */
export const LEGACY_LOCAL_MODEL_FILE = 'opencode-model.json';

export async function writeLocalModelForAgent(agentGroupId: string): Promise<void> {
  const dir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared');
  const file = path.join(dir, LOCAL_MODEL_FILE);
  const legacy = path.join(dir, LEGACY_LOCAL_MODEL_FILE);
  const provider = (await getContainerConfig(agentGroupId))?.provider;
  const model = await (provider === 'pi' && piInstalled() ? getEffectiveModelForAgent(agentGroupId) : null);
  if (!model || model.kind !== 'ollama' || !model.endpoint) {
    // Clear BOTH names, or the readers' fallback keeps stale wiring alive.
    fs.rmSync(file, { force: true });
    fs.rmSync(legacy, { force: true });
    return;
  }
  if (!fs.existsSync(dir)) return; // folder not initialized yet; a later sync rewrites
  // pi speaks OpenAI-compat at /v1/chat/completions, so its baseURL DOES take
  // the /v1 suffix (unlike the Anthropic-SDK path in envForModel, where /v1 is a
  // bug). containerReachableUrl rewrites localhost → host.docker.internal so the
  // container reaches the host's Ollama, bypassing the OneCLI proxy (NO_PROXY set
  // by the provider). pi strips the `ollama/` prefix from the model.
  const baseURL = containerReachableUrl(model.endpoint.replace(/\/+$/, '')) + '/v1';
  const payload = {
    provider: 'ollama',
    model: `ollama/${model.model_id}`,
    baseURL,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  fs.rmSync(legacy, { force: true });
}

/**
 * Discover models served by an Ollama endpoint via its /api/tags endpoint.
 * Returns the array of model names; throws on failure (invalid URL,
 * unreachable, malformed response).
 */
export async function discoverOllamaModels(endpoint: string): Promise<string[]> {
  const base = endpoint.replace(/\/+$/, '');
  const url = `${base}/api/tags`;
  const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string }> };
  if (!body || !Array.isArray(body.models)) throw new Error('Ollama /api/tags response missing models[]');
  return body.models.map((m) => m.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Check that an Ollama endpoint is reachable and serves the named model.
 * Returns null on success, or an error message string on failure.
 */
export async function healthCheckOllamaModel(endpoint: string, modelId: string): Promise<string | null> {
  try {
    const models = await discoverOllamaModels(endpoint);
    if (!models.includes(modelId)) {
      // Allow tag-less variants — `llama3.1:70b` typed as `llama3.1` etc.
      const stripTag = (s: string): string => s.split(':')[0];
      const bareTarget = stripTag(modelId);
      const found = models.some((m) => stripTag(m) === bareTarget);
      if (!found) {
        return `Model "${modelId}" not installed on this Ollama endpoint. Available: ${models.slice(0, 5).join(', ') || '(none)'}`;
      }
    }
    return null;
  } catch (err) {
    // Not literally Ollama — but the `ollama` kind really means "endpoint that
    // speaks the Anthropic /v1/messages API" (that's all envForModel wires up).
    // A LiteLLM router serving anthropic-spec is exactly as usable, and it has
    // no /api/tags. Probe /v1/messages with a real one-token request — a 200
    // both proves the route AND that the model id resolves. (An intentionally
    // malformed body is no good: LiteLLM 500s on it rather than 400.) 401/403
    // pass too: the endpoint is alive, just auth-gated.
    try {
      const url = `${endpoint.replace(/\/+$/, '')}/v1/messages`;
      const res = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok || res.status === 401 || res.status === 403) return null;
      const detail = await res.text().catch(() => '');
      return `Anthropic-compatible endpoint returned ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`;
    } catch {
      return `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Validate a model record before persistence. Returns null on OK or an
 * error message string. Run by the POST /api/models handler before insert
 * (and by PUT before update).
 */
export async function validateModel(input: {
  kind: string;
  endpoint?: string | null;
  model_id: string;
}): Promise<string | null> {
  if (input.kind === 'anthropic') {
    if (!input.model_id) return 'model_id required';
    if (!KNOWN_ANTHROPIC_MODELS.includes(input.model_id as (typeof KNOWN_ANTHROPIC_MODELS)[number])) {
      // Custom ids are allowed — see KNOWN_ANTHROPIC_MODELS.
    }
    return null;
  }
  if (input.kind === 'ollama') {
    if (!input.endpoint) return 'endpoint required for kind=ollama';
    if (!input.model_id) return 'model_id required for kind=ollama';
    return await healthCheckOllamaModel(input.endpoint, input.model_id);
  }
  if (input.kind === 'openai-compatible') {
    if (!input.endpoint) return 'endpoint required for kind=openai-compatible';
    if (!input.model_id) return 'model_id required for kind=openai-compatible';
    // Reachability check only — many OpenAI-compatible endpoints gate
    // /v1/models behind auth, so a 401 isn't a save-blocker.
    try {
      const url = `${input.endpoint.replace(/\/+$/, '')}/v1/models`;
      const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status >= 500) return `OpenAI-compatible endpoint returned ${res.status}`;
      // 200, 401, 403 — endpoint is alive; assume model_id is valid.
      return null;
    } catch (err) {
      return `Endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return `Unknown kind: ${input.kind}`;
}

/**
 * Single-URL probe — paste a base URL, get back the kind + the list of
 * models the endpoint exposes. Used by the PWA's "Add by URL" flow.
 *
 * Probe order matters: Ollama also serves `/v1/models` and `/v1/messages`,
 * so we check `/api/tags` first for the most-specific identification.
 *
 * Order:
 *   1. GET <base>/api/tags        → Ollama (definitive)
 *   2. GET <base>/v1/models       → OpenAI-compatible (LM Studio, vLLM, OpenRouter, …)
 *   3. POST <base>/v1/messages    → Anthropic-compatible (returns 401 missing-x-api-key)
 *
 * Each check has a short timeout so an unreachable URL fails fast. Probes
 * run sequentially on purpose — concurrent requests against an arbitrary
 * URL could surprise the operator more than they help; the latency
 * difference is sub-second per check.
 *
 * Returns:
 *   - kind: which provider matched
 *   - models: list of model id strings (best-effort — may be empty for
 *     gated OpenAI-compat endpoints; user can type the id manually)
 *   - requires_credential: true if /v1/models returned 401/403, hint to
 *     the operator that they need to wire OneCLI for this endpoint
 *   - notes: arbitrary advisory string (e.g. how the endpoint is consumed)
 *   - kind=null + reason: nothing matched, with the reason for each probe
 */
export interface ProbeResult {
  kind: 'ollama' | 'openai-compatible' | 'anthropic' | null;
  endpoint: string;
  models: string[];
  requires_credential: boolean;
  notes?: string;
  reason?: string;
}

/**
 * Probe a base URL. If the user provides a bare host (no scheme), try
 * both `https://` and `http://` in parallel and return the first that
 * classifies a kind. Most local Ollama installs are http-on-localhost,
 * most public APIs are https — auto-detection saves the user from
 * remembering which.
 *
 * Worst-case latency for a bare unreachable URL: one probeOneScheme
 * window (~12s) — both schemes time out in parallel, not serially.
 */
export async function probeEndpoint(rawUrl: string): Promise<ProbeResult> {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const candidates = expandUrlCandidates(trimmed);
  if (candidates.length === 1) {
    return probeOneScheme(candidates[0]);
  }
  // In parallel: worst case is one probeOneScheme window, however many candidates.
  const results = await Promise.all(
    candidates.map((url) => probeOneScheme(url).catch((err) => fallbackResult(url, err))),
  );
  for (const r of results) {
    if (r.kind) return r;
  }
  return {
    kind: null,
    endpoint: trimmed,
    models: [],
    requires_credential: false,
    reason: `No known provider responded. Tried: ${candidates.join(', ')}.`,
  };
}

/**
 * Expand a user-supplied URL/host into the set of candidates worth probing.
 *
 * Rules:
 *   - Explicit scheme + port      → just that. (1 candidate)
 *   - Explicit `http://` no port  → port-default + Ollama 11434.
 *   - Explicit `https://` no port → just port-default. (TLS on 11434 not
 *                                    a thing in a default Ollama install.)
 *   - Bare host + port            → http and https on the given port.
 *   - Bare host, no port          → http and https on default ports +
 *                                    http on 11434. (3 candidates)
 */
function expandUrlCandidates(input: string): string[] {
  const schemeMatch = input.match(/^(https?):\/\/(.+)$/i);
  let scheme: 'http' | 'https' | null = null;
  let rest: string;
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase() as 'http' | 'https';
    rest = schemeMatch[2];
  } else {
    rest = input;
  }
  // Split host[:port] from any trailing path so we can detect explicit ports.
  const slashIdx = rest.indexOf('/');
  const hostPort = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const path = slashIdx >= 0 ? rest.slice(slashIdx) : '';
  const hasPort = /:\d+$/.test(hostPort);

  const out = new Set<string>();
  if (scheme) {
    out.add(`${scheme}://${hostPort}${path}`);
    if (!hasPort && scheme === 'http') {
      // Same scheme as user requested — try Ollama port too.
      out.add(`http://${hostPort}:11434${path}`);
    }
  } else {
    out.add(`http://${hostPort}${path}`);
    out.add(`https://${hostPort}${path}`);
    if (!hasPort) {
      out.add(`http://${hostPort}:11434${path}`);
    }
  }
  return [...out];
}

function fallbackResult(endpoint: string, err: unknown): ProbeResult {
  return {
    kind: null,
    endpoint,
    models: [],
    requires_credential: false,
    reason: `Probe error on ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

async function probeOneScheme(rawUrl: string): Promise<ProbeResult> {
  const base = rawUrl.replace(/\/+$/, '');
  const result: ProbeResult = {
    kind: null,
    endpoint: base,
    models: [],
    requires_credential: false,
  };

  // 1. Ollama — /api/tags
  try {
    const r = await safeFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const body = (await r.json()) as { models?: Array<{ name?: string }> };
      if (Array.isArray(body?.models)) {
        result.kind = 'ollama';
        result.models = body.models.map((m) => m.name).filter((n): n is string => typeof n === 'string');
        return result;
      }
    }
  } catch {
    // fall through to next probe
  }

  // 2. OpenAI-compatible OR Anthropic — both expose /v1/models. Real
  //    Anthropic returns 401 with `x-api-key header is required` in the
  //    body; OpenAI-compat returns generic auth error. Check the body to
  //    disambiguate the 401/403 case.
  try {
    const r = await safeFetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (r.status === 401 || r.status === 403) {
      const body = await r.text();
      const lo = body.toLowerCase();
      if (lo.includes('x-api-key') || lo.includes('"type":"authentication_error"') || lo.includes('anthropic')) {
        result.kind = 'anthropic';
        result.requires_credential = true;
        result.notes =
          'Anthropic-compatible endpoint detected. Auto-discovery of model ids is gated behind the API key — use the curated dropdown in Advanced (Sonnet/Opus/Haiku) or type a model id manually.';
        return result;
      }
      result.kind = 'openai-compatible';
      result.requires_credential = true;
      result.notes =
        'OpenAI-compatible endpoint detected (auth required). Agents consume these through the Anthropic-spec /v1/messages surface (LiteLLM serves it for every model it fronts). For an auth-required endpoint, save the API key as a OneCLI secret with hostPattern matching this URL.';
      return result;
    }
    if (r.ok) {
      const body = (await r.json()) as { data?: Array<{ id?: string }> };
      if (Array.isArray(body?.data)) {
        result.kind = 'openai-compatible';
        result.models = body.data.map((m) => m.id).filter((n): n is string => typeof n === 'string');
        result.notes =
          'OpenAI-compatible endpoint. Agents consume these through the Anthropic-spec /v1/messages surface (LiteLLM serves it for every model it fronts).';
        return result;
      }
    }
  } catch {
    // fall through
  }

  // 3. Anthropic-compatible — POST /v1/messages with empty body, expect 401 from real Anthropic
  try {
    const r = await safeFetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    });
    if (r.status === 401 || r.status === 400) {
      // Real Anthropic returns 401 with "x-api-key required" or 400 missing fields.
      const body = await r.text();
      if (body.toLowerCase().includes('anthropic') || body.toLowerCase().includes('x-api-key')) {
        result.kind = 'anthropic';
        result.requires_credential = true;
        result.notes =
          "Anthropic-compatible endpoint detected. The model_id list isn't auto-discoverable for this kind — type the desired Anthropic model name manually (Sonnet/Opus/Haiku).";
        return result;
      }
    }
  } catch {
    // fall through
  }

  result.reason = `No known provider responded at ${base}. Tried /api/tags, /v1/models, /v1/messages.`;
  return result;
}
