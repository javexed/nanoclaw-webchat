/**
 * The tailnet route's one credential: a Tailscale OAuth client (scopes
 * `auth_keys` and `devices:core`, both write, tag `tag:nanoclaw-app`), held
 * by the OneCLI vault. NanoClaw never stores it.
 *
 * The vault keeps it as a generic secret injected ONLY on the token request
 * (`api.tailscale.com`, path `/api/v2/oauth/token`) as HTTP Basic client
 * authentication, the scheme an OAuth token endpoint must accept for a client
 * with a password (RFC 6749 §2.3.1). It is assigned to the `nanoclaw-tailnet`
 * identity, which runs in `selective` mode.
 *
 * Connecting passes the secret through to the vault once (the Admin GUI's
 * Connect, or `onecli secrets create` by hand, see the docs); after that
 * NanoClaw only asks the vault whether it is there.
 */
import type { OnecliAdmin, SecretRow } from '../../user-credentials/onecli-admin.js';
import { TAILNET_IDENTITY, TAILNET_IDENTITY_NAME, TOKEN_PATH } from './api.js';

export const SECRET_NAME = 'NanoClaw tailnet OAuth client';
export const SECRET_SPEC = {
  hostPattern: 'api.tailscale.com',
  pathPattern: TOKEN_PATH,
  headerName: 'Authorization',
  valueFormat: 'Basic {value}',
} as const;

/** Host-side identities that run in `all` mode on purpose (drafter.ts). */
const HOST_ALL_MODE = new Set(['webchat-drafter']);

export const isTailnetSecret = (s: SecretRow): boolean =>
  s.name === SECRET_NAME || (s.hostPattern === SECRET_SPEC.hostPattern && s.pathPattern === SECRET_SPEC.pathPattern);

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const CLIENT_SECRET_RE = /^tskey-client-[A-Za-z0-9_-]{8,200}$/;

/**
 * Store (or replace) the OAuth client in the vault and give it to the
 * tailnet identity alone. The secret is passed through, never kept.
 */
export async function connectTailnetClient(admin: OnecliAdmin, clientId: string, clientSecret: string): Promise<void> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!CLIENT_ID_RE.test(id)) throw new Error('That is not a Tailscale OAuth client ID');
  if (!CLIENT_SECRET_RE.test(secret)) throw new Error('That is not a Tailscale OAuth client secret (tskey-client-…)');
  const value = Buffer.from(`${id}:${secret}`).toString('base64');
  const existing = (await admin.listAllSecrets()).find(isTailnetSecret);
  let secretId: string;
  if (existing) {
    await admin.updateGenericSecret(existing.id, value, {
      headerName: SECRET_SPEC.headerName,
      valueFormat: SECRET_SPEC.valueFormat,
    });
    if (existing.pathPattern !== SECRET_SPEC.pathPattern)
      await admin.updateSecretPathPattern(existing.id, SECRET_SPEC.pathPattern);
    secretId = existing.id;
  } else {
    secretId = await admin.createGenericSecret(SECRET_NAME, value, { ...SECRET_SPEC });
  }
  const agentId = await admin.ensureAgent(TAILNET_IDENTITY_NAME, TAILNET_IDENTITY);
  await admin.setSecretMode(agentId, 'selective');
  await admin.setSecrets(agentId, [secretId]);
}

export type VaultCheck = { ok: true; warnings: string[] } | { ok: false; missing: string; warnings: string[] };

/**
 * Is the OAuth client in the vault and assigned to the tailnet identity?
 * Also warns about identities in `all` mode: the vault injects every secret
 * whose host matches for those, so an agent in `all` mode could ask for an
 * access token with this client.
 */
export async function checkVault(admin: OnecliAdmin): Promise<VaultCheck> {
  const warnings: string[] = [];
  const secret = (await admin.listAllSecrets()).find(isTailnetSecret);
  const agents = await admin.listAgents();
  const allMode = agents.filter(
    (a) => a.secretMode === 'all' && a.identifier !== TAILNET_IDENTITY && !HOST_ALL_MODE.has(a.identifier ?? ''),
  );
  if (allMode.length)
    warnings.push(
      `${allMode.length} OneCLI identit${allMode.length === 1 ? 'y is' : 'ies are'} in "all" secret mode and would be given the Tailscale OAuth client too: switch them to selective`,
    );
  if (!secret) return { ok: false, missing: 'the Tailscale OAuth client is not in the vault (Connect)', warnings };
  const me = agents.find((a) => a.identifier === TAILNET_IDENTITY);
  if (!me)
    return { ok: false, missing: 'the nanoclaw-tailnet identity is missing in OneCLI (Connect again)', warnings };
  if (me.secretMode !== 'all' && !(await admin.listAgentSecretIds(me.id)).includes(secret.id))
    return { ok: false, missing: 'the OAuth client is not assigned to nanoclaw-tailnet in OneCLI', warnings };
  return { ok: true, warnings };
}
