/**
 * UserCreds credential mapping (central DB). Stores only OneCLI ids + status — the
 * Anthropic credential itself (API key OR subscription/OAuth token) lives in the
 * OneCLI vault. One row per (user, agent group); the user's vault secret is
 * reused across their agent-group rows.
 */
import { getDb } from '../../db/connection.js';

export type UserCredsStatus = 'active' | 'revoked';
export type UserCredsCredType = 'api_key' | 'oauth_token';
/**
 * Which agent provider this credential is for — pinned from the group's
 * `container_configs.provider` at onboard time. 'claude' → `anthropic` vault
 * secret; 'codex' → `openai` secret (the member's ChatGPT/Codex auth.json or
 * OpenAI key). Drives secret-reuse scoping and Claude-OAuth-sentinel injection.
 */
export type UserCredsProvider = 'claude' | 'codex';

export interface UserCredsCredentialRow {
  user_id: string;
  agent_group_id: string;
  onecli_agent_id: string;
  secret_id: string | null;
  status: UserCredsStatus;
  cred_type: UserCredsCredType;
  provider: UserCredsProvider;
  created_at: string;
  updated_at: string;
}

export async function getUserCredsCredential(userId: string, agentGroupId: string): Promise<UserCredsCredentialRow | null> {
  return (
    ((await getDb().get(`SELECT * FROM user_credential_members WHERE user_id = ? AND agent_group_id = ?`, userId, agentGroupId)) as UserCredsCredentialRow | undefined) ?? null
  );
}

/** True when the user has an active per-member credential for this agent group. */
export async function userHasActiveKey(userId: string, agentGroupId: string): Promise<boolean> {
  return (await getUserCredsCredential(userId, agentGroupId))?.status === 'active';
}

/**
 * True when the user's active credential is a *Claude* subscription/OAuth token,
 * so the per-member container must be spawned in OAuth mode (sentinel
 * CLAUDE_CODE_OAUTH_TOKEN; the real token is swapped in by OneCLI on the wire).
 * Codex OAuth is deliberately excluded — Codex auth rides OneCLI's gateway
 * auth.json stub (no env var), so a Codex member needs no sentinel.
 */
export async function userHasActiveOauth(userId: string, agentGroupId: string): Promise<boolean> {
  const row = await getUserCredsCredential(userId, agentGroupId);
  return row?.status === 'active' && row.cred_type === 'oauth_token' && row.provider === 'claude';
}

// ── User-level credential (connect-time source of truth) ──
// One row per (user, provider): the single vault secret the member connected.
// Per-group enrollment (above) is created lazily from this on first use.
export interface UserCredsUserCredentialRow {
  user_id: string;
  provider: UserCredsProvider;
  secret_id: string | null;
  cred_type: UserCredsCredType;
  status: UserCredsStatus;
  created_at: string;
  updated_at: string;
}

export async function getUserCredential(userId: string, provider: UserCredsProvider): Promise<UserCredsUserCredentialRow | null> {
  return (
    ((await getDb().get(`SELECT * FROM user_credentials WHERE user_id = ? AND provider = ?`, userId, provider)) as
      | UserCredsUserCredentialRow
      | undefined) ?? null
  );
}

/** True when the user has connected a credential for this provider (the gate for per-member routing). */
export async function userHasConnectedCredential(userId: string, provider: UserCredsProvider): Promise<boolean> {
  return (await getUserCredential(userId, provider))?.status === 'active';
}

/** The user's vault secret id for a provider — now sourced from the user-level credential. */
export async function getUserSecretId(userId: string, provider: UserCredsProvider = 'claude'): Promise<string | null> {
  const row = await getUserCredential(userId, provider);
  return row && row.status === 'active' ? (row.secret_id ?? null) : null;
}

export async function upsertUserCredential(
  userId: string,
  provider: UserCredsProvider,
  secretId: string | null,
  credType: UserCredsCredType,
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(`INSERT INTO user_credentials (user_id, provider, secret_id, cred_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         secret_id  = excluded.secret_id,
         cred_type  = excluded.cred_type,
         status     = 'active',
         updated_at = excluded.updated_at`, userId, provider, secretId, credType, now, now);
}

/**
 * Every non-null vault secret id tracked by a user-level credential row (all
 * users + the workspace default). Used by workspace-default reconciliation to
 * tell an untracked legacy `anthropic` secret (safe to remove) apart from a
 * member's own secret — which may be UNASSIGNED between connect and first-use
 * enrollment, so "unassigned" alone is not a safe discriminator.
 */
export async function listAllTrackedSecretIds(): Promise<string[]> {
  return (
    (await getDb().all(`SELECT secret_id FROM user_credentials WHERE secret_id IS NOT NULL`)) as {
      secret_id: string;
    }[]
  ).map((r) => r.secret_id);
}

export async function setUserCredentialStatus(userId: string, provider: UserCredsProvider, status: UserCredsStatus): Promise<void> {
  await getDb().run(`UPDATE user_credentials SET status = ?, updated_at = ? WHERE user_id = ? AND provider = ?`, status, new Date().toISOString(), userId, provider);
}

/** Per-group enrollment rows for a user+provider — used to revoke everywhere on disconnect. */
export async function listEnrolledGroups(userId: string, provider: UserCredsProvider): Promise<UserCredsCredentialRow[]> {
  return (await getDb().all(`SELECT * FROM user_credential_members WHERE user_id = ? AND provider = ? AND status = 'active'`, userId, provider)) as UserCredsCredentialRow[];
}

/** Recover the owning agent group from a UserCreds container's OneCLI identity (approval routing). */
export async function agentGroupForUserCredsAgent(onecliAgentId: string): Promise<string | null> {
  const row = (await getDb().get(`SELECT agent_group_id FROM user_credential_members WHERE onecli_agent_id = ? LIMIT 1`, onecliAgentId)) as { agent_group_id: string } | undefined;
  return row?.agent_group_id ?? null;
}

/**
 * Active per-member enrollment rows for a group — the OneCLI agents that must
 * receive the group's tool secrets alongside the group's own agent, so a
 * credential wired for the group works for every member (modules/tool-secrets).
 */
export async function listGroupMemberEnrollments(agentGroupId: string): Promise<UserCredsCredentialRow[]> {
  return (await getDb().all(`SELECT * FROM user_credential_members WHERE agent_group_id = ? AND status = 'active'`, agentGroupId)) as UserCredsCredentialRow[];
}

/** Active member user ids for an agent group (drives shared-context fan-out). */
export async function activeMembersForGroup(agentGroupId: string): Promise<string[]> {
  return (
    (await getDb().all(`SELECT user_id FROM user_credential_members WHERE agent_group_id = ? AND status = 'active'`, agentGroupId)) as { user_id: string }[]
  ).map((r) => r.user_id);
}

/**
 * Upsert a member's credential row. Both API-key and OAuth credentials live in
 * the OneCLI vault, so both carry a `secret_id`; `credType` only records which
 * connect flow the member used (and gates OAuth-mode spawn).
 */
export async function upsertUserCredsCredential(
  userId: string,
  agentGroupId: string,
  onecliAgentId: string,
  secretId: string | null,
  credType: UserCredsCredType = 'api_key',
  provider: UserCredsProvider = 'claude',
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(`INSERT INTO user_credential_members
         (user_id, agent_group_id, onecli_agent_id, secret_id, status, cred_type, provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
       ON CONFLICT (user_id, agent_group_id) DO UPDATE SET
         onecli_agent_id = excluded.onecli_agent_id,
         secret_id       = excluded.secret_id,
         status          = 'active',
         cred_type       = excluded.cred_type,
         provider        = excluded.provider,
         updated_at      = excluded.updated_at`, userId, agentGroupId, onecliAgentId, secretId, credType, provider, now, now);
}

export async function setUserCredsStatus(userId: string, agentGroupId: string, status: UserCredsStatus): Promise<void> {
  await getDb().run(`UPDATE user_credential_members SET status = ?, updated_at = ? WHERE user_id = ? AND agent_group_id = ?`, status, new Date().toISOString(), userId, agentGroupId);
}
