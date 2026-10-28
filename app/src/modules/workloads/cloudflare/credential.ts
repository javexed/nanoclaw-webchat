/**
 * The Cloudflare route's one credential: an API token held by the OneCLI
 * vault, scoped to Access: Apps and Policies (edit), Cloudflare Tunnel (edit)
 * on the account, and DNS (edit) on the app domain's zone. NanoClaw never
 * stores it.
 *
 * The vault keeps it as a generic secret injected as `Authorization: Bearer`
 * on api.cloudflare.com (path /client/v4/*), assigned to the
 * `nanoclaw-cloudflare` identity, which runs in `selective` mode.
 *
 * This token can change who may open every app, so the route refuses to run
 * while any other OneCLI identity is in `all` secret mode: the vault would
 * inject it for that identity too.
 */
import { isToolSecret, type OnecliAdmin, type SecretRow } from '../../user-credentials/onecli-admin.js';
import { API_PATH, CLOUDFLARE_IDENTITY, CLOUDFLARE_IDENTITY_NAME } from './api.js';

export const SECRET_NAME = 'NanoClaw Cloudflare API token';
export const SECRET_SPEC = {
  hostPattern: 'api.cloudflare.com',
  pathPattern: `${API_PATH}/*`,
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
} as const;

/** Host-side identities that run in `all` mode on purpose (drafter.ts). */
const HOST_ALL_MODE = new Set(['webchat-drafter']);

/** Ours by name; else the one secret with exactly our host and path (an agent's own Cloudflare tool secret has another name). */
export const isCloudflareSecret = (s: SecretRow): boolean =>
  s.name === SECRET_NAME ||
  (!isToolSecret(s) && s.hostPattern === SECRET_SPEC.hostPattern && s.pathPattern === SECRET_SPEC.pathPattern);

const TOKEN_RE = /^[A-Za-z0-9_-]{30,200}$/;

/** Store (or replace) the API token in the vault and give it to the Cloudflare identity alone. Passed through, never kept. */
export async function connectCloudflareToken(admin: OnecliAdmin, token: string): Promise<void> {
  const value = token.trim();
  if (!TOKEN_RE.test(value)) throw new Error('That is not a Cloudflare API token');
  const existing = (await admin.listAllSecrets()).find(isCloudflareSecret);
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
  const agentId = await admin.ensureAgent(CLOUDFLARE_IDENTITY_NAME, CLOUDFLARE_IDENTITY);
  await admin.setSecretMode(agentId, 'selective');
  await admin.setSecrets(agentId, [secretId]);
}

export type VaultCheck = { ok: true; warnings: string[] } | { ok: false; missing: string; warnings: string[] };

/** Is the API token in the vault, assigned to the Cloudflare identity alone, with no identity in `all` mode? */
export async function checkVault(admin: OnecliAdmin): Promise<VaultCheck> {
  const secret = (await admin.listAllSecrets()).find(isCloudflareSecret);
  const agents = await admin.listAgents();
  if (!secret) return { ok: false, missing: 'the Cloudflare API token is not in the vault (Connect)', warnings: [] };
  const me = agents.find((a) => a.identifier === CLOUDFLARE_IDENTITY);
  if (!me)
    return {
      ok: false,
      missing: 'the nanoclaw-cloudflare identity is missing in OneCLI (Connect again)',
      warnings: [],
    };
  if (me.secretMode !== 'selective')
    return { ok: false, missing: 'nanoclaw-cloudflare must be in selective secret mode in OneCLI', warnings: [] };
  if (!(await admin.listAgentSecretIds(me.id)).includes(secret.id))
    return { ok: false, missing: 'the API token is not assigned to nanoclaw-cloudflare in OneCLI', warnings: [] };
  const allMode = agents.filter(
    (a) => a.secretMode === 'all' && a.identifier !== CLOUDFLARE_IDENTITY && !HOST_ALL_MODE.has(a.identifier ?? ''),
  );
  if (allMode.length)
    return {
      ok: false,
      missing: `${allMode.length} OneCLI identit${allMode.length === 1 ? 'y is' : 'ies are'} in "all" secret mode and would be given the Cloudflare API token too: switch ${allMode.length === 1 ? 'it' : 'them'} to selective`,
      warnings: [],
    };
  return { ok: true, warnings: [] };
}
