// ── Webchat self-configuration routes ────────────────────────────────────────
// The routes that configure the webchat channel itself rather than anything
// inside it: onboarding, the feature manifest the client reads at boot,
// credential config, usage, and the Tailscale / cloudflared ingress setup
// (preflight, install, connect).
//
// The loosest cluster in server.ts — three references outside its own handlers,
// two of them constants now in server/constants.ts.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { audit, readAuditEvents, readAuditFacets } from '../../../audit.js';
import { configureSyslog, getSyslogStatus, parseSyslogTarget } from '../audit-syslog.js';
import { fleetIsolationEnabled } from '../../../modules/fleet-isolation/index.js';
import {
  getAuditSyslogTarget,
  setAuditSyslogTarget,
  getCredentialIsolation,
  getCredentialsConfig,
  getMarketplaceDisabled,
  getOnboardingComplete,
  getPromoteFirstTailscaleOwner,
  setCredentialIsolation,
  setCredentialsConfig,
  setMarketplaceDisabled,
  setOnboardingComplete,
  setPromoteFirstTailscaleOwner,
  setSourceDisabled,
} from '../db.js';
import type { CredentialMode, CredentialsConfig } from '../db.js';
import {
  getCloudflaredInstallState,
  getTailscaleInstallState,
  startCloudflaredConnect,
  startCloudflaredInstall,
  startTailscaleInstall,
} from '../ollama-manage.js';
import { runPreflight } from '../preflight.js';
import { isGlobalAdmin, isOwner } from '../roles.js';
import { DEFAULT_PORT, MARKETPLACE_ID } from './constants.js';
import { MCP_REGISTRY_ID, mcpRegistryRemovedKey } from './mcp-registry.js';
import { codexAvailable, grokAvailable, opencodeAvailable, piAvailable } from './providers.js';
import { enableTailscaleServe, getTailscaleServeState } from '../tailscale-serve.js';
import { computeUsageRollup } from '../usage.js';
import type { RouteCtx } from '../server.js';

// ── UserCreds: workspace credentials policy — accepted TYPES + default room mode ──
// Read by anyone (the room UIs need it); only the owner can change it.
export async function rWebchatCredentialsConfig(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  if (method === 'GET') {
    return json(res, 200, {
      ...(await getCredentialsConfig()),
      codexAvailable: codexAvailable(),
      grokAvailable: grokAvailable(),
      opencodeAvailable: opencodeAvailable(),
      piAvailable: piAvailable(),
      canEdit: await isOwner(userId),
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!(await isOwner(userId))) return json(res, 403, { error: 'Owner only' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const patch: Partial<CredentialsConfig> = {};
  if (body.defaultMode !== undefined) {
    if (body.defaultMode !== 'disabled' && body.defaultMode !== 'optional' && body.defaultMode !== 'required')
      return json(res, 400, { error: "defaultMode must be 'disabled', 'optional', or 'required'" });
    patch.defaultMode = body.defaultMode as CredentialMode;
  }
  for (const k of [
    'allowAnthropicKey',
    'allowClaudeOauth',
    'allowOpenaiKey',
    'allowCodexOauth',
    'allowGrokOauth',
  ] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') return json(res, 400, { error: `${k} must be a boolean` });
    patch[k] = body[k] as boolean;
  }
  // Codex types are inert until the provider is installed — refuse to enable them.
  // Enabling a provider nobody can run just hides the reason behind a later
  // failure, so refuse at the toggle where the message can still be useful.
  if (patch.allowGrokOauth && !grokAvailable())
    return json(res, 409, {
      error: 'Grok is not installed — run /add-grok and rebuild the agent image first.',
      code: 'not-installed',
    });
  if ((patch.allowCodexOauth || patch.allowOpenaiKey) && !codexAvailable())
    return json(res, 400, { error: 'Codex support isn’t installed yet — add it with /add-codex first.' });
  await setCredentialsConfig(patch);
  return json(res, 200, {
    ...(await getCredentialsConfig()),
    codexAvailable: codexAvailable(),
    grokAvailable: grokAvailable(),
  });
}

// ── First-run setup wizard state ────────────────────────────────────────────────
// GET is authenticated (any member) so the client can decide whether to auto-open
// the wizard; non-admins always get complete:true + canEdit:false so it never
// blocks or shows for them. PUT (finish/dismiss/reset) is owner/global-admin only.
export async function rWebchatOnboarding(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const canEdit = (await isOwner(userId)) || (await isGlobalAdmin(userId));
  if (method === 'GET') {
    return json(res, 200, { complete: (await canEdit) ? getOnboardingComplete() : true, canEdit });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!canEdit) return json(res, 403, { error: 'Forbidden' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { complete?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.complete !== 'boolean') return json(res, 400, { error: 'complete must be a boolean' });
  await setOnboardingComplete(body.complete);
  return json(res, 200, { complete: body.complete });
}

// ── Feature toggles: MCP + skills marketplace ───────────────────────────────
// GET is any authed user (the client hides the MCP/Skills tabs when off; non-
// admins get the flag only). PUT is owner/global-admin — flips it on/off
// (default on/recommended). Disabling also 403s the endpoints (gate above).
export async function rWebchatFeatures(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const canEdit = (await isOwner(userId)) || (await isGlobalAdmin(userId));
  if (method === 'GET') {
    // credentialIsolation is nullable: null = following .env, so the UI can say
    // "not set here" rather than implying the operator chose the env's value.
    return json(res, 200, {
      marketplaceEnabled: !(await getMarketplaceDisabled()),
      credentialIsolation: await getCredentialIsolation(),
      credentialIsolationEffective: await fleetIsolationEnabled(),
      canEdit,
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!canEdit) return json(res, 403, { error: 'Forbidden' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { marketplaceEnabled?: unknown; credentialIsolation?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (body.credentialIsolation !== undefined) {
    // null clears the override and returns the install to whatever .env says.
    if (body.credentialIsolation !== null && typeof body.credentialIsolation !== 'boolean')
      return json(res, 400, { error: 'credentialIsolation must be a boolean or null' });
    setCredentialIsolation(body.credentialIsolation as boolean | null);
    // Takes effect on each group's NEXT spawn — the hook reads it per spawn, so
    // there is nothing to restart.
    if (body.marketplaceEnabled === undefined)
      return json(res, 200, { ok: true, credentialIsolation: await getCredentialIsolation() });
  }
  if (typeof body.marketplaceEnabled !== 'boolean') {
    return json(res, 400, { error: 'marketplaceEnabled must be a boolean' });
  }
  setMarketplaceDisabled(!body.marketplaceEnabled);
  // The choice cascades to the individual sources (wizard ask): a
  // "no marketplace" install starts with the skill marketplace and the MCP
  // registry REMOVED — not just hidden behind the flag. Re-enabling restores
  // both; Settings then manages them per-source.
  await setSourceDisabled(MARKETPLACE_ID, !body.marketplaceEnabled);
  await setSourceDisabled(mcpRegistryRemovedKey(), !body.marketplaceEnabled);
  if (body.marketplaceEnabled) await setSourceDisabled(MCP_REGISTRY_ID, false);
  return json(res, 200, { marketplaceEnabled: !(await getMarketplaceDisabled()) });
}

// ── Wizard opt-in: first Tailscale login becomes owner ──────────────────────
// One-shot arm flag. GET/PUT owner/global-admin only. PUT true → the next
// tailscale identity to authenticate is promoted to owner (auth.ts finalize),
// then the flag disarms itself.
export async function rWebchatTailscaleOwner(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const canEdit = (await isOwner(userId)) || (await isGlobalAdmin(userId));
  if (method === 'GET') {
    return json(res, 200, { armed: await getPromoteFirstTailscaleOwner(), canEdit });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (!canEdit) return json(res, 403, { error: 'Forbidden' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { armed?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.armed !== 'boolean') return json(res, 400, { error: 'armed must be a boolean' });
  await setPromoteFirstTailscaleOwner(body.armed);
  return json(res, 200, { armed: await getPromoteFirstTailscaleOwner() });
}

// ── Audit syslog forwarder ──────────────────────────────────────────────────
// Owner-only, GET status / PUT target. The local JSONL is always on and is
// not configurable here on purpose — this route manages the FORWARDER only.
//
// The one rule that matters: changing the audit configuration is itself an
// audit event, and it is emitted TWICE — once before the swap (delivered to
// the old sink, so the collector being abandoned records who abandoned it)
// and once after (delivered to the new sink, so the new collector's record
// starts with its own provenance). Without this, the first move of a
// compromised owner session is to silently repoint the forwarder.
/**
 * Read the audit log back. Same reader-side posture as the syslog config next
 * door — owner or global admin — because these lines name who did what, and a
 * scoped admin has no business reading the whole workspace's history.
 *
 * Read-only by construction: there is no write path here, and no route that
 * edits or truncates the log. An audit trail an operator can rewrite from the
 * UI is not an audit trail.
 */
export async function rWebchatAuditLog(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url, userId } = ctx;
  if (!((await isOwner(userId)) || (await isGlobalAdmin(userId)))) return json(res, 403, { error: 'Forbidden' });
  const q = url.searchParams;
  const num = Number(q.get('limit'));
  const page = readAuditEvents({
    limit: Number.isFinite(num) && num > 0 ? num : 50,
    type: q.get('type') || undefined,
    effect: q.get('effect') || undefined,
    actor: q.get('actor') || undefined,
    beforeTs: q.get('beforeTs') || undefined,
  });
  return json(res, 200, { ...page, facets: readAuditFacets() });
}

export async function rWebchatAuditSyslog(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const canEdit = (await isOwner(userId)) || (await isGlobalAdmin(userId));
  if (!canEdit) return json(res, 403, { error: 'Forbidden' });
  if (method === 'GET') {
    return json(res, 200, { target: await getAuditSyslogTarget(), status: getSyslogStatus() });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { target?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.target !== 'string') return json(res, 400, { error: 'target must be a string' });
  const target = body.target.trim();
  if (target && !parseSyslogTarget(target)) {
    return json(res, 400, {
      error: 'target must be udp://host:port, tcp://host:port or tls://host:port (explicit port required)',
    });
  }
  const from = (await getAuditSyslogTarget()) || null;
  // 1st emission → old sink + file: the outgoing collector records the change.
  audit({
    type: 'audit.config',
    actor: `human:${userId}`,
    effect: 'changed',
    detail: { from, to: target || null, phase: 'before-switch' },
  });
  configureSyslog(target); // validated above; '' tears down
  await setAuditSyslogTarget(target);
  // 2nd emission → new sink + file: the incoming collector starts with provenance.
  audit({
    type: 'audit.config',
    actor: `human:${userId}`,
    effect: 'applied',
    detail: { from, to: target || null, phase: 'after-switch' },
  });
  return json(res, 200, { target: await getAuditSyslogTarget(), status: getSyslogStatus() });
}

// ── Enable HTTPS over Tailscale (`tailscale serve`) ─────────────────────────
// Owner/global-admin only. GET reports whether tailscaled is up, the https
// URL, and whether serve is already on. POST runs `tailscale serve --bg
// <port>` so webchat is reachable at https://<node>.ts.net with a real cert.
// Identity continuity across the http→https switch lives in auth.ts
// (tailscaleServeIdentity maps Serve's header back to the whois id).
export async function rWebchatTailscaleHttps(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Forbidden' });
  // This endpoint reports HTTPS status in BOTH flavors: `tailscale serve`
  // (what the enable button sets up) and native TLS (WEBCHAT_TLS_CERT/KEY —
  // an install like the tailscale-https setup script produces). Without the
  // native check, an already-HTTPS install is offered "Enable HTTPS" on a
  // page it is literally serving over HTTPS.
  const nativeTls = !!(process.env.WEBCHAT_TLS_CERT && process.env.WEBCHAT_TLS_KEY);
  if (method === 'GET') {
    const state = await getTailscaleServeState();
    if (nativeTls && !state.active) {
      const port = Number(process.env.WEBCHAT_PORT || DEFAULT_PORT);
      return json(res, 200, {
        ...state,
        active: true,
        mode: 'native-tls',
        url: state.url ? `${state.url}${port === 443 ? '' : `:${port}`}` : null,
      });
    }
    return json(res, 200, { ...state, mode: state.active ? 'serve' : null });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (nativeTls) {
    return json(res, 400, {
      ok: false,
      error: 'HTTPS is already enabled (native TLS certificate) — nothing to set up.',
    });
  }
  const port = Number(process.env.WEBCHAT_PORT || DEFAULT_PORT);
  const result = await enableTailscaleServe(port);
  return json(res, result.ok ? 200 : 400, result);
}

// ── Access & security: install a Cloudflare Tunnel (token-driven) ───────────
// Owner/global-admin only, two explicit steps. GET reports install/service
// state + whether a one-click install can run here (Linux + root + systemd).
// POST /install installs just the cloudflared binary; POST /connect registers
// the managed-tunnel connector service from the operator's token — auth is
// enforced by the Cloudflare Access policy on the tunnel, dashboard-side.
export async function rWebchatCloudflaredGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Forbidden' });
  return json(res, 200, getCloudflaredInstallState());
}

export async function rWebchatCloudflaredInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Forbidden' });
  const r = startCloudflaredInstall();
  if (r.error === 'prereq-missing')
    return json(res, 409, { error: 'Needs root + systemd — install cloudflared manually instead.' });
  return json(res, r.started ? 202 : 409, { ...getCloudflaredInstallState(), started: r.started });
}

export async function rWebchatCloudflaredConnectPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Forbidden' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { token?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.token !== 'string' || !body.token.trim()) return json(res, 400, { error: 'token required' });
  const r = startCloudflaredConnect(body.token);
  if (r.error === 'prereq-missing')
    return json(res, 409, { error: 'Needs root + systemd — install cloudflared manually instead.' });
  if (r.error === 'not-installed') return json(res, 409, { error: 'Install cloudflared first.' });
  if (r.error === 'bad-token') return json(res, 400, { error: 'That doesn’t look like a tunnel token.' });
  return json(res, r.started ? 202 : 409, { ...getCloudflaredInstallState(), started: r.started });
}

export async function rWebchatTailscaleInstallGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, getTailscaleInstallState());
}

// Wizard/Settings self-test: run capability checks (tailscale, docker,
// container→host networking) from the vantage point that actually matters and
// return verdicts + fixes, so setup surfaces problems instead of silent retries.
export async function rWebchatPreflightGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, { checks: await runPreflight() });
}

export async function rWebchatTailscaleInstallPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const r = startTailscaleInstall();
  if (!r.started && r.error === 'prereq-missing') {
    return json(res, 409, {
      error: "Can't install Tailscale here — /dev/net/tun or root is missing. Use the Proxmox community helper.",
    });
  }
  return json(res, r.started ? 202 : 409, { ...getTailscaleInstallState(), started: r.started });
}

// Owner-only per-user token-usage rollup (estimated from the message store — see
// usage.ts). `?days=N` (1–90, default 7) sets the window.
export async function rWebchatUsageGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const days = Math.min(90, Math.max(1, Math.floor(Number(url.searchParams.get('days')) || 7)));
  const sinceMs = Date.now() - days * 86_400_000;
  return json(res, 200, { days, ...(await computeUsageRollup(sinceMs)) });
}
