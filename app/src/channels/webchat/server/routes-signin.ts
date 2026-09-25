/**
 * Sign-in routes: the web app's OIDC sign-in ("Sign in with <provider>"),
 * sign-out, and the account's linked sign-ins.
 *
 * Pre-auth (called before the auth gate):
 *   GET  /auth/oidc/login[?link=1]        → 302 to the provider
 *   GET  /auth/oidc/callback              → session cookie, 302 back to the app
 *   (/auth/microsoft/login and /callback, the first version's paths, still work)
 *   POST /auth/logout                     → end this browser's session
 * Authenticated (called with the request's auth result):
 *   GET    /api/account/sign-ins          → this account and its linked sign-ins
 *   POST   /api/account/link/tailscale    → link this device's Tailscale identity
 *   DELETE /api/account/links/<id>        → unlink a sign-in from this account
 *
 * Linking always needs BOTH identities in one person's hands at once: the
 * account signed in now, and a second sign-in completed in this same browser
 * (OIDC) or presented by this same request (Tailscale). Nothing here takes
 * an identity typed in by hand.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TLSSocket } from 'tls';

import { audit } from '../../../audit.js';
import { log } from '../../../log.js';

import {
  authenticateRequest,
  oidcCfg,
  oidcLoginEnabled,
  oidcUserId,
  tailscaleIdentityOf,
  type AuthResult,
} from '../auth.js';
import {
  CALLBACK_PATH,
  LEGACY_CALLBACK_PATH,
  LEGACY_LOGIN_PATH,
  LOGIN_PATH,
  beginLogin,
  completeLogin,
  isHttpsOrigin,
  loginErrorMessage,
  requestOrigin,
  stateCookie,
  stateFromCookie,
} from '../oidc-login.js';
import {
  clearedSessionCookie,
  createSigninSession,
  deleteSigninSession,
  linkIdentities,
  linkRefusalMessage,
  listLinks,
  resolveLinkedUserId,
  sessionCookie,
  sessionTokenFromCookie,
  unlinkIdentity,
} from '../signins.js';
import { json } from './http.js';

const isTls = (req: IncomingMessage): boolean => Boolean((req.socket as TLSSocket).encrypted);

function redirect(res: ServerResponse, location: string, cookie?: string | string[]): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  res.end();
}

/** Back to the app with a message for the login screen or the Sign-ins panel. */
const backWith = (key: 'signin_error' | 'signin', value: string): string =>
  `/?${new URLSearchParams({ [key]: value }).toString()}`;

/** A person, not the shared operator token or the localhost owner: only a person has sign-ins to link. */
const isPerson = (auth: AuthResult): boolean => auth.source !== 'bearer' && auth.source !== 'localhost';

/** The identity this request actually signed in with (before any link maps it to an account). */
const rawIdentity = (auth: AuthResult): string => auth.signedInAs ?? auth.userId;

export async function handlePreAuthSignin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  if ((url.pathname === LOGIN_PATH || url.pathname === LEGACY_LOGIN_PATH) && method === 'GET') {
    if (!oidcLoginEnabled()) {
      redirect(res, backWith('signin_error', 'Single sign-on is not set up on this install.'));
      return true;
    }
    const origin = requestOrigin(req, isTls(req));
    let linkFrom: string | undefined;
    if (url.searchParams.get('link') === '1') {
      const auth = await authenticateRequest(req);
      if (!auth.ok || !isPerson(auth)) {
        redirect(res, backWith('signin_error', 'Sign in first, then link another sign-in from Settings.'));
        return true;
      }
      linkFrom = rawIdentity(auth);
    }
    const to = beginLogin({ redirectUri: `${origin}${CALLBACK_PATH}`, linkFrom });
    const state = new URL(to).searchParams.get('state') ?? '';
    redirect(res, to, stateCookie(state, isHttpsOrigin(origin)));
    return true;
  }

  if ((url.pathname === CALLBACK_PATH || url.pathname === LEGACY_CALLBACK_PATH) && method === 'GET') {
    const secure = isHttpsOrigin(requestOrigin(req, isTls(req)));
    // The attempt must have been started by THIS browser (see STATE_COOKIE).
    const state = url.searchParams.get('state');
    if (!state || stateFromCookie(req.headers.cookie) !== state) {
      redirect(res, backWith('signin_error', loginErrorMessage('expired')), stateCookie('', secure, 0));
      return true;
    }
    const result = await completeLogin(url.searchParams);
    if (!result.ok) {
      redirect(
        res,
        backWith('signin_error', loginErrorMessage(result.reason, result.detail)),
        stateCookie('', secure, 0),
      );
      return true;
    }
    const signedIn = oidcUserId(result.identity.identity);
    let note = 'signed-in';
    if (result.linkFrom) {
      const linked = await linkIdentities(result.linkFrom, signedIn);
      if (!linked.ok) {
        redirect(
          res,
          backWith('signin_error', linkRefusalMessage(linked.reason, signedIn)),
          stateCookie('', secure, 0),
        );
        return true;
      }
      audit({
        type: 'auth.link',
        actor: `human:${linked.primary}`,
        effect: 'allow',
        detail: { primary: linked.primary, alias: linked.alias, via: 'oidc' },
      });
      note = 'linked';
    }
    const token = await createSigninSession(signedIn, result.identity.displayName);
    audit({
      type: 'auth.signin',
      actor: `human:${await resolveLinkedUserId(signedIn)}`,
      effect: 'allow',
      detail: { via: 'oidc', provider: oidcCfg().name, identity: signedIn },
    });
    log.info('OIDC sign-in', { identity: signedIn, linked: note === 'linked' });
    redirect(res, backWith('signin', note), [sessionCookie(token, secure), stateCookie('', secure, 0)]);
    return true;
  }

  if (url.pathname === '/auth/logout' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
      return true;
    }
    const token = sessionTokenFromCookie(req.headers.cookie);
    if (token) await deleteSigninSession(token);
    res.setHeader('Set-Cookie', clearedSessionCookie(isHttpsOrigin(requestOrigin(req, isTls(req)))));
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

/** How a sign-in id reads to its owner. */
function describeIdentity(id: string): { id: string; kind: 'tailscale' | 'oidc'; label: string } {
  if (id.startsWith('webchat:tailscale:'))
    return { id, kind: 'tailscale', label: id.slice('webchat:tailscale:'.length) };
  return { id, kind: 'oidc', label: id.slice('webchat:'.length) };
}

const RE_LINK = /^\/api\/account\/links\/(.+)$/;

export async function handleAccountRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  auth: AuthResult,
): Promise<boolean> {
  if (url.pathname === '/api/account/sign-ins' && method === 'GET') {
    const person = isPerson(auth);
    const here = person ? await tailscaleIdentityOf(req) : null;
    const hereAccount = here ? await resolveLinkedUserId(here.userId) : null;
    json(res, 200, {
      account: auth.userId,
      displayName: auth.displayName,
      source: auth.source,
      signedInAs: rawIdentity(auth),
      viaSession: Boolean(auth.viaSession),
      person,
      // The account's own identity, then everything linked to it.
      signIns: person
        ? [
            { ...describeIdentity(auth.userId), primary: true },
            ...(await listLinks(auth.userId)).map((l) => ({
              ...describeIdentity(l.aliasUserId),
              primary: false,
              linkedAt: l.createdAt,
            })),
          ]
        : [],
      oidcName: oidcCfg().name,
      can: {
        linkOidc: person && oidcLoginEnabled(),
        // Offered only when this device's tailnet identity is a different account.
        linkTailscale: person && here !== null && hereAccount !== auth.userId ? here.login : null,
      },
    });
    return true;
  }

  if (url.pathname === '/api/account/link/tailscale' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
      return true;
    }
    if (!isPerson(auth)) {
      json(res, 403, { error: 'The shared operator sign-in has no sign-ins to link.' });
      return true;
    }
    const here = await tailscaleIdentityOf(req);
    if (!here) {
      json(res, 400, { error: 'This device is not reaching central over Tailscale.' });
      return true;
    }
    const linked = await linkIdentities(rawIdentity(auth), here.userId);
    if (!linked.ok) {
      json(res, 409, { error: linkRefusalMessage(linked.reason, here.userId) });
      return true;
    }
    audit({
      type: 'auth.link',
      actor: `human:${linked.primary}`,
      effect: 'allow',
      detail: { primary: linked.primary, alias: linked.alias, via: 'tailscale' },
    });
    json(res, 200, { ok: true, primary: linked.primary, alias: linked.alias });
    return true;
  }

  const m = RE_LINK.exec(url.pathname);
  if (m && method === 'DELETE') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
      return true;
    }
    const alias = decodeURIComponent(m[1]);
    if (!(await unlinkIdentity(auth.userId, alias))) {
      json(res, 404, { error: 'That sign-in is not linked to this account.' });
      return true;
    }
    audit({
      type: 'auth.unlink',
      actor: `human:${auth.userId}`,
      effect: 'allow',
      detail: { primary: auth.userId, alias },
    });
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}
