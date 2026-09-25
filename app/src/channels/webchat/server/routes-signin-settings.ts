/**
 * Admin → Sign-in: which ways in this install accepts, each on or off.
 *
 *   GET    /api/webchat/signin              the whole picture
 *   PUT    /api/webchat/signin/tailscale    {enabled}
 *   PUT    /api/webchat/signin/oidc         {provider, tenant | issuer, name, clientId, clientSecret?, clearSecret?}
 *   DELETE /api/webchat/signin/oidc
 *   PUT    /api/webchat/signin/proxy        {ips, header}
 *   DELETE /api/webchat/signin/proxy
 *   PUT    /api/webchat/signin/token        {enabled}
 *
 * Owner / global admin; CSRF on writes; every change audited
 * (auth.signin.set). Changes apply at once (signin-settings.ts).
 *
 * Lockout rules, the same for every method:
 *   - You cannot turn off, or re-point, the method you are signed in with:
 *     sign in another way first, which proves that way works for you.
 *   - You cannot turn off the last usable method on an install reachable
 *     beyond this machine.
 *   - Signed in as the localhost owner, only Tailscale can be turned on (and
 *     the first tailnet identity then becomes an owner, as in the setup
 *     wizard): anything else would end the localhost sign-in with no owner
 *     able to come back.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TLSSocket } from 'tls';

import { audit } from '../../../audit.js';
import {
  getAuthManagementInfo,
  methodOfSource,
  refreshTailscaleHealth,
  usableMethods,
  type AuthResult,
  type SigninMethod,
} from '../auth.js';
import { setBearerTokenDisabled, setPromoteFirstTailscaleOwner } from '../db.js';
import { CALLBACK_PATH, requestOrigin } from '../oidc-login.js';
import { isGlobalAdmin, isOwner } from '../roles.js';
import { derivedClientConfig, getClientOverrides } from '../runner-client-config.js';
import {
  applyOidc,
  applyProxy,
  applyTailscale,
  clearOidc,
  clearProxy,
  discover,
  readOidc,
  readProxy,
  validateOidcInput,
  validateProxyInput,
  type OidcInput,
} from '../signin-settings.js';
import { json, readJsonBody } from './http.js';

const LABEL: Record<SigninMethod, string> = {
  token: 'the access token',
  tailscale: 'Tailscale',
  proxy: 'the trusted proxy',
  oidc: 'single sign-on',
};

const isTls = (req: IncomingMessage): boolean => Boolean((req.socket as TLSSocket).encrypted);

async function view(req: IncomingMessage, auth: AuthResult): Promise<Record<string, unknown>> {
  refreshTailscaleHealth();
  const info = await getAuthManagementInfo();
  const overrides = await getClientOverrides();
  const derived = derivedClientConfig();
  return {
    session: methodOfSource(auth.source) ?? 'localhost',
    loopback: info.loopback,
    tailscale: info.tailscale,
    oidc: { ...readOidc(), redirectUri: `${requestOrigin(req, isTls(req))}${CALLBACK_PATH}` },
    proxy: readProxy(),
    token: { configured: info.bearerConfigured, enabled: info.bearerActive },
    // VS Code (Microsoft only): the two optional overrides, and what applies without them.
    vscode: {
      appIdUri: overrides.appIdUri ?? '',
      clientId: overrides.clientId ?? '',
      defaultAppIdUri: derived.appIdUri,
    },
  };
}

/** Why turning `method` off (or re-pointing it) would lock someone out, or null. */
async function offRefusal(auth: AuthResult, method: SigninMethod): Promise<string | null> {
  if (methodOfSource(auth.source) === method)
    return `You are signed in with ${LABEL[method]}. Sign in another way first.`;
  const usable = await usableMethods();
  usable[method] = false;
  const loopback = (await getAuthManagementInfo()).loopback;
  if (!loopback && !Object.values(usable).some(Boolean)) return 'That would leave no way to sign in.';
  return null;
}

/** Turning a method on as the localhost owner ends the localhost sign-in; only Tailscale can carry the owner over. */
function onRefusal(auth: AuthResult, method: SigninMethod): string | null {
  if (auth.source !== 'localhost' || method === 'tailscale') return null;
  return 'This browser is signed in as the local owner. Turn on Tailscale first, and sign in with it.';
}

async function body<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return null;
  }
}

function record(userId: string, method: SigninMethod, enabled: boolean, detail: Record<string, unknown> = {}): void {
  audit({ type: 'auth.signin.set', actor: `human:${userId}`, effect: 'allow', detail: { method, enabled, ...detail } });
}

export async function handleSigninSettings(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  auth: AuthResult,
): Promise<boolean> {
  if (url.pathname !== '/api/webchat/signin' && !url.pathname.startsWith('/api/webchat/signin/')) return false;
  const userId = auth.userId;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) {
    json(res, 403, { error: 'Forbidden' });
    return true;
  }
  if (url.pathname === '/api/webchat/signin') {
    if (method !== 'GET') json(res, 405, { error: 'Method not allowed' });
    else json(res, 200, await view(req, auth));
    return true;
  }
  if (method !== 'PUT' && method !== 'DELETE') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }
  if (req.headers['x-webchat-csrf'] !== '1') {
    json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return true;
  }
  const root = process.cwd();
  const which = url.pathname.slice('/api/webchat/signin/'.length);
  const refuse = (error: string): true => {
    json(res, 400, { error });
    return true;
  };
  const done = async () => json(res, 200, await view(req, auth));

  if (which === 'tailscale' && method === 'PUT') {
    const b = await body<{ enabled?: unknown }>(req, res);
    if (!b) return true;
    if (typeof b.enabled !== 'boolean') return refuse('enabled must be true or false');
    if (!b.enabled) {
      const why = await offRefusal(auth, 'tailscale');
      if (why) return refuse(why);
    }
    // From the localhost owner, the first tailnet identity to sign in becomes an owner.
    if (b.enabled && auth.source === 'localhost') await setPromoteFirstTailscaleOwner(true);
    applyTailscale(root, b.enabled);
    record(userId, 'tailscale', b.enabled);
    await done();
    return true;
  }

  if (which === 'token' && method === 'PUT') {
    const b = await body<{ enabled?: unknown }>(req, res);
    if (!b) return true;
    if (typeof b.enabled !== 'boolean') return refuse('enabled must be true or false');
    if (!(await getAuthManagementInfo()).bearerConfigured)
      return refuse('No access token is configured (WEBCHAT_TOKEN).');
    const why = b.enabled ? onRefusal(auth, 'token') : await offRefusal(auth, 'token');
    if (why) return refuse(why);
    await setBearerTokenDisabled(!b.enabled);
    record(userId, 'token', b.enabled);
    await done();
    return true;
  }

  if (which === 'proxy') {
    if (method === 'DELETE') {
      const why = await offRefusal(auth, 'proxy');
      if (why) return refuse(why);
      clearProxy(root);
      record(userId, 'proxy', false);
      await done();
      return true;
    }
    const b = await body<{ ips?: unknown; header?: unknown }>(req, res);
    if (!b) return true;
    const v = validateProxyInput(b);
    if (!v.ok) return refuse(v.error);
    const before = readProxy();
    const why = before.enabled
      ? before.ips !== v.ips || before.header !== v.header
        ? await offRefusal(auth, 'proxy')
        : null
      : onRefusal(auth, 'proxy');
    if (why) return refuse(why);
    applyProxy(root, v);
    record(userId, 'proxy', true, { ips: v.ips, header: v.header });
    await done();
    return true;
  }

  if (which === 'oidc') {
    if (method === 'DELETE') {
      const why = await offRefusal(auth, 'oidc');
      if (why) return refuse(why);
      clearOidc(root);
      record(userId, 'oidc', false);
      await done();
      return true;
    }
    const b = await body<OidcInput>(req, res);
    if (!b) return true;
    const v = validateOidcInput(b);
    if (!v.ok) return refuse(v.error);
    const before = readOidc();
    if (!before.enabled) {
      const why = onRefusal(auth, 'oidc');
      if (why) return refuse(why);
    }
    const found = await discover(v);
    if (!found.ok) return refuse(found.error);
    // Re-pointing at another issuer or client is turning the old one off for whoever signed in with it.
    if (before.enabled && (found.issuer !== before.issuer || v.clientId !== before.clientId)) {
      const why = await offRefusal(auth, 'oidc');
      if (why) return refuse(why);
    }
    applyOidc(root, { ...v, ...found });
    record(userId, 'oidc', true, {
      provider: v.provider,
      issuer: found.issuer,
      clientId: v.clientId,
      secret: v.secret ? 'set' : v.clearSecret ? 'cleared' : 'kept',
    });
    await done();
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
