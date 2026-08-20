/**
 * Per-member Grok credentials: host-side refresh, vault-side value.
 *
 * THE SPLIT, and why it is not optional. A member's Grok access token lives in
 * the OneCLI vault, injected as a bearer header on xAI's CLI host — so it never
 * enters a container. But the vault is WRITE-ONLY (secrets list/create/update/
 * delete; nothing reveals a value), and a Grok access token expires in 6h. The
 * vault therefore cannot renew what it holds, and neither can the container.
 * Something with the REFRESH token has to do it, which means the host.
 *
 * So each member's refresh token is kept here, outside the vault and outside
 * every container mount, and the sweep pushes a fresh ACCESS token into the
 * member's vault secret with `secrets update`. A leak from a container is
 * bounded by one token lifetime; a leak of this directory is bounded by the
 * host it already trusts.
 *
 * The token exchange is duplicated rather than imported from the provider
 * payload for the same reason grok-status.ts duplicates a path: that module
 * ships with /add-grok, so importing it would make this file fail to compile on
 * an install that has never run it — including CI.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../../config.js';
import { log } from '../../../log.js';

/** Renew this far ahead of expiry, matching the install-wide credential's skew. */
export const USER_REFRESH_SKEW_MS = 10 * 60_000;

/**
 * How often the host checks. MUST stay shorter than the skew — a longer tick
 * leaves a window where a credential falls due and expires between checks,
 * which is exactly the bug the install-wide sweep shipped with first.
 */
export const GROK_USER_REFRESH_TICK_MS = 5 * 60_000;

/** xAI's token endpoint, from its published OIDC discovery document. */
export const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';

export interface GrokUserCredential {
  userId: string;
  /** The vault secret holding the ACCESS token — what gets updated on refresh. */
  secretId: string;
  refreshToken: string;
  expiresAt: string;
  clientId: string;
  issuer: string;
}

function usersDir(): string {
  return path.join(DATA_DIR, 'grok', 'users');
}

/** Filesystem-safe, collision-free name for a user id like `webchat:alice`. */
export function userFileName(userId: string): string {
  return Buffer.from(userId).toString('base64url') + '.json';
}

export function userCredentialPath(userId: string): string {
  return path.join(usersDir(), userFileName(userId));
}

export function readUserCredential(userId: string): GrokUserCredential | null {
  try {
    return JSON.parse(fs.readFileSync(userCredentialPath(userId), 'utf8')) as GrokUserCredential;
  } catch {
    return null; // absent or corrupt — the member reconnects
  }
}

export function writeUserCredential(cred: GrokUserCredential): void {
  fs.mkdirSync(usersDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(usersDir(), 0o700);
  const file = userCredentialPath(cred.userId);
  fs.writeFileSync(file, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function deleteUserCredential(userId: string): void {
  try {
    fs.rmSync(userCredentialPath(userId), { force: true });
  } catch {
    /* already gone */
  }
}

export function listUserCredentials(): GrokUserCredential[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(usersDir());
  } catch {
    return [];
  }
  const out: GrokUserCredential[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(usersDir(), n), 'utf8')) as GrokUserCredential);
    } catch {
      /* skip a corrupt file rather than failing the sweep */
    }
  }
  return out;
}

export function userNeedsRefresh(cred: GrokUserCredential, now = Date.now()): boolean {
  const expiry = Date.parse(cred.expiresAt);
  // An unparseable expiry counts as due: claiming a credential is good when we
  // cannot reason about it is what sends someone into the logs.
  return Number.isNaN(expiry) || expiry - now <= USER_REFRESH_SKEW_MS;
}

export interface UserRefreshDeps {
  fetchFn?: typeof fetch;
  tokenEndpoint?: string;
  now?: () => number;
  /** Pushes the new access token into the member's vault secret. */
  updateSecretValue?: (secretId: string, value: string) => Promise<void>;
}

/**
 * Exchange one member's refresh token and push the result to the vault.
 *
 * The refresh token ROTATES on every use — measured against xAI, not assumed —
 * so the new one must be persisted or the member is locked out at the next
 * renewal. The vault write happens BEFORE the local write: if the process dies
 * between them the member keeps a working token and we retry with a refresh
 * token that is merely stale-but-recorded, whereas the other order can leave the
 * vault holding a token nothing can renew.
 */
export async function refreshUserCredential(
  cred: GrokUserCredential,
  deps: UserRefreshDeps = {},
): Promise<GrokUserCredential> {
  const doFetch = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;

  const res = await doFetch(deps.tokenEndpoint ?? TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
      client_id: cred.clientId,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`grok user refresh failed: HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  const payload = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error('grok user refresh returned no access_token');

  if (deps.updateSecretValue) await deps.updateSecretValue(cred.secretId, payload.access_token);

  const next: GrokUserCredential = {
    ...cred,
    refreshToken: payload.refresh_token ?? cred.refreshToken,
    expiresAt: new Date(now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
  };
  writeUserCredential(next);
  return next;
}

/** Renew every member credential that is due. Returns how many were renewed. */
export async function refreshDueUserCredentials(deps: UserRefreshDeps = {}): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let renewed = 0;
  for (const cred of listUserCredentials()) {
    if (!userNeedsRefresh(cred, now)) continue;
    try {
      await refreshUserCredential(cred, deps);
      renewed += 1;
      log.info(`Grok member credential renewed (${cred.userId})`);
    } catch (err) {
      // One member's dead refresh token must not stop the others being renewed.
      log.warn(
        `Grok member credential refresh failed (${cred.userId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return renewed;
}
