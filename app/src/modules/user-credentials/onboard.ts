/**
 * UserCreds onboarding orchestration — lazy / just-in-time.
 *
 * Two phases, so a member connects ONCE and it applies to every room:
 *
 *  1. storeUserCredential (at connect) — stash the member's credential as a
 *     single OneCLI vault secret + a user-level `user_credentials` row.
 *     No per-room work. The host never holds the credential.
 *
 *  2. ensureGroupEnrollment (lazy, at first session spawn in a given room) —
 *     create the per-(user,group) OneCLI agent and assign the member's secret
 *     PLUS that group's other tool secrets, so the per-member container
 *     authenticates the model with the member's own credential (swapped in by
 *     OneCLI on the wire) and keeps the group's tools. Idempotent + skipped once
 *     enrolled, so it's a no-op on every spawn after the first.
 *
 * revokeUserCredential (at disconnect) tears both down everywhere.
 *
 * Provider-specific vault type: Claude → `anthropic` secret (sk-ant-api… or
 * sk-ant-oat…); Codex → `openai` secret (the whole ChatGPT/Codex auth.json for
 * OAuth, host chatgpt.com; or an OpenAI key, host api.openai.com).
 *
 * OneCLI calls go through an injectable OnecliAdmin (real CLI in prod, fake in tests).
 */
import { log } from '../../log.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { userCredsAgentIdentifier, userSlug, WORKSPACE_DEFAULT_USER_ID, isWorkspaceDefaultUser } from './identity.js';
import {
  getUserCredsCredential,
  getUserCredential,
  listGroupMemberEnrollments,
  setUserCredsStatus,
  setUserCredentialStatus,
  upsertUserCredsCredential,
  upsertUserCredential,
  listEnrolledGroups,
  listAllTrackedSecretIds,
  type UserCredsCredType,
  type UserCredsProvider,
} from './db.js';
import type { OnecliAdmin } from './onecli-admin.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';

/**
 * The agent group's provider, mapped to the UserCreds-supported families.
 *
 * EXPORTED because this derivation had been copied three times — onboard,
 * the module index, and twice in routes-users — and each copy knew about a
 * different set of providers. Adding Grok made the drift visible: a member
 * could be in a Grok room while the credential routes still resolved them as
 * Claude. One definition, imported everywhere.
 */
export async function userCredsProviderForGroup(agentGroupId: string): Promise<UserCredsProvider> {
  const provider = (await getContainerConfig(agentGroupId))?.provider;
  // A lookup rather than a chain of ternaries: the same shape drifted once
  // already, when a provider the harness picker knew about was invisible to
  // room creation. Anything unrecognised falls back to claude, the built-in.
  return provider === 'codex' || provider === 'grok' ? provider : 'claude';
}

/** The vault secret type that holds a member's credential for a provider. */
function secretTypeFor(provider: UserCredsProvider): 'anthropic' | 'openai' | 'generic' {
  if (provider === 'codex') return 'openai';
  if (provider === 'grok') return 'generic';
  return 'anthropic';
}

/**
 * Where a member's Grok token is injected.
 *
 * MEASURED, and not where the documentation points. The CLI talks to
 * cli-chat-proxy.grok.com, not api.x.ai — a secret scoped to the documented host
 * silently never matches, and the failure is `credential_not_found` with nothing
 * naming the cause.
 */
export const GROK_SECRET_SPEC = {
  hostPattern: 'cli-chat-proxy.grok.com',
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
} as const;

/**
 * The group's tool secret ids EXCLUDING the member-supplied credential type, to
 * mirror onto a per-member agent so its container keeps working tools (Gmail,
 * GitHub, …) while its model credential (Anthropic for Claude, OpenAI for Codex)
 * comes from the member.
 */
async function groupToolSecretIds(admin: OnecliAdmin, agentGroupId: string, credSecretType: string): Promise<string[]> {
  const groupAgentUuid = await admin.findAgentId(agentGroupId);
  if (!groupAgentUuid) return [];
  const groupIds = await admin.listAgentSecretIds(groupAgentUuid);
  const typeById = new Map((await admin.listAllSecrets()).map((s) => [s.id, s.type]));
  return groupIds.filter((id) => typeById.get(id) !== credSecretType);
}

/**
 * Create the member's vault secret. Claude credentials — API key OR subscription
 * (OAuth) token — are stored as a single `anthropic`-type secret: OneCLI
 * auto-detects the auth mode from the value (an `sk-ant-oat…` token → `oauth`,
 * injected as `Authorization: Bearer …`; an `sk-ant-api…` key → `api-key`,
 * injected as `x-api-key`) and, either way, treats it as the api.anthropic.com
 * provider credential so the per-member agent passes the gateway's access gate.
 * (A `generic` secret on api.anthropic.com does NOT — the provider gate shadows
 * it.) Codex → an `openai` secret (auth.json via --file for OAuth, key via --value).
 */
async function createCredentialSecret(
  admin: OnecliAdmin,
  userId: string,
  provider: UserCredsProvider,
  credType: UserCredsCredType,
  credential: string,
): Promise<string> {
  const name = provider === 'claude' ? `UserCreds ${userSlug(userId)}` : `UserCreds ${userSlug(userId)} (${provider})`;
  if (provider === 'codex') return admin.createOpenAISecret(name, credential, credType);
  // Grok: the member's ACCESS token, injected as a bearer header. Only the
  // access token goes to the vault — the refresh token stays on the host, which
  // is the same split the install-wide credential uses and the reason a leak
  // from a container is bounded by one token lifetime instead of being
  // permanent.
  if (provider === 'grok') return admin.createGenericSecret(name, credential, { ...GROK_SECRET_SPEC });
  return admin.createAnthropicSecret(name, credential);
}

/**
 * Un-assign the member's secret from every per-group agent it was lazily
 * enrolled on (for this provider) and mark those enrollments revoked. They
 * rebuild lazily on next use. Shared by disconnect and re-connect.
 */
async function unenrollGroups(admin: OnecliAdmin, userId: string, provider: UserCredsProvider): Promise<void> {
  for (const row of await listEnrolledGroups(userId, provider)) {
    const agentUuid = await admin.findAgentId(row.onecli_agent_id);
    if (agentUuid && row.secret_id) {
      const remaining = (await admin.listAgentSecretIds(agentUuid)).filter((id) => id !== row.secret_id);
      // `set-secrets` can't take an empty list; the revoke below stops the
      // per-member session resolving regardless of a lingering assignment.
      if (remaining.length > 0) await admin.setSecrets(agentUuid, remaining);
    }
    await setUserCredsStatus(userId, row.agent_group_id, 'revoked');
  }
}

/**
 * Phase 1 (connect): stash the member's credential as a single vault secret +
 * the user-level row. No per-room work beyond tearing down any prior secret.
 * `provider` is the connecting room's provider; `credType` (api_key |
 * oauth_token) is recorded for display + spawn mode.
 *
 * The secret's wire injection (x-api-key vs Authorization: Bearer) is baked in
 * at create time and OneCLI can't change it in place, so a re-connect deletes
 * the old secret and creates a fresh one. Any lazy per-room enrollments are
 * torn down first and rebuild on next use with the new secret id.
 */
export async function storeUserCredential(
  admin: OnecliAdmin,
  userId: string,
  provider: UserCredsProvider,
  credential: string,
  credType: UserCredsCredType,
): Promise<void> {
  const prior = await getUserCredential(userId, provider);
  if (prior?.secret_id) {
    await unenrollGroups(admin, userId, provider);
    await admin.deleteSecret(prior.secret_id).catch(() => {}); // best-effort; orphan is harmless
  }
  const secretId = await createCredentialSecret(admin, userId, provider, credType, credential);
  await upsertUserCredential(userId, provider, secretId, credType);
  log.info('UserCreds credential stored', { userId, provider, credType });
}

/**
 * Phase 2 (lazy, at first session spawn in a room): create the per-(user,group)
 * OneCLI agent and assign the member's secret + that group's tool secrets.
 * Idempotent — returns immediately if already enrolled, or if the member hasn't
 * connected a credential for this group's provider.
 */
export async function ensureGroupEnrollment(admin: OnecliAdmin, userId: string, agentGroupId: string): Promise<void> {
  // The workspace-default credential is an unassigned `all`-mode workspace secret
  // by design — it must never become a per-member `selective` enrollment.
  if (isWorkspaceDefaultUser(userId)) return;
  const provider = await userCredsProviderForGroup(agentGroupId);
  // Already enrolled — but only skip when the enrollment is for THIS group's
  // CURRENT provider. If the group's provider was switched after enrollment, the
  // stale row would otherwise pin the wrong secret; fall through to re-enroll.
  const existing = await getUserCredsCredential(userId, agentGroupId);
  if (existing?.status === 'active' && existing.provider === provider) return;
  const userCred = await getUserCredential(userId, provider);
  if (userCred?.status !== 'active' || !userCred.secret_id) return; // not connected — nothing to enroll
  const secretId = userCred.secret_id;

  const identifier = userCredsAgentIdentifier(agentGroupId, userId);
  const agentUuid = await admin.ensureAgent(`${userSlug(userId)} (UserCreds)`, identifier);
  await admin.setSecretMode(agentUuid, 'selective');
  const toolSecretIds = await groupToolSecretIds(admin, agentGroupId, secretTypeFor(provider));
  const merged = Array.from(new Set([secretId, ...toolSecretIds]));
  await admin.setSecrets(agentUuid, merged);
  await upsertUserCredsCredential(userId, agentGroupId, identifier, secretId, userCred.cred_type, provider);
  log.info('UserCreds group enrolled (lazy)', { userId, agentGroupId, provider, toolSecrets: toolSecretIds.length });
}

/**
 * Disconnect: un-assign the member secret from every per-group agent it was
 * lazily enrolled on, DELETE the user-level vault secret (so the member's real
 * credential actually leaves the vault — not just marked revoked — which also
 * neutralizes any lingering assignment OneCLI couldn't clear via an empty
 * set-secrets), then mark the rows revoked.
 */
export async function revokeUserCredential(
  admin: OnecliAdmin,
  userId: string,
  provider: UserCredsProvider,
): Promise<void> {
  await unenrollGroups(admin, userId, provider);
  const secretId = (await getUserCredential(userId, provider))?.secret_id ?? null;
  if (secretId) await admin.deleteSecret(secretId).catch(() => {}); // best-effort; row revoke below is the gate
  await setUserCredentialStatus(userId, provider, 'revoked');
  log.info('UserCreds credential revoked', { userId, provider });
}

/**
 * Set (or rotate) a WORKSPACE DEFAULT credential — the owner-managed fallback
 * that `all`-mode base agents auto-inject when a member has no user credential.
 * `claude` → an `anthropic` vault secret; `codex` → an `openai` secret (a
 * ChatGPT/Codex auth.json for OAuth, an OpenAI key otherwise).
 *
 * Stores it as the workspace-default's own tracked secret (reusing
 * `storeUserCredential`), then reconciles to the single-secret invariant: any
 * OTHER secret of the provider's type NOT tracked by a `user_credentials` row —
 * i.e. a legacy secret from `setup/auth.ts`/`init-onecli`/`/add-codex` — is
 * deleted so two eligible `all`-mode provider secrets can't resolve
 * nondeterministically. (Typed provider secrets ARE the model credential; tool
 * secrets are `generic`-typed and never touched.) The new secret is created
 * first, so there's never a zero-credential window and it's already tracked
 * (never deleted) by the time reconciliation runs. Member secrets are tracked
 * too, so they are never touched — even before their lazy enrollment.
 */
/**
 * Assign a workspace-default model credential to every agent that should carry
 * it, and drop assignments the vault no longer knows about.
 *
 * REQUIRED after any re-mint. `storeUserCredential` deletes the old secret and
 * creates a new one with a NEW id. An `all`-mode agent picks that up for free,
 * but a `selective` agent only ever receives what is explicitly assigned — so
 * without this every isolated agent is left holding a dangling id and fails with
 * "credentials exist in OneCLI but this agent does not have access". A whole
 * fleet went down this way after one wizard reauth. (The legacy re-point inside
 * setWorkspaceDefaultCredential does NOT cover this: it only rewrites references
 * to legacy secrets still present in the vault, and the re-minted old secret is
 * already deleted by then.)
 *
 * Members who have connected their OWN credential keep it — theirs is not ours
 * to replace.
 *
 * Best-effort per agent: one unreachable agent must not abort the sweep, or a
 * re-mint could leave the fleet half-assigned with no signal.
 */
async function fanOutWorkspaceCredential(
  admin: OnecliAdmin,
  provider: UserCredsProvider,
  secretId: string,
): Promise<void> {
  const live = new Set((await admin.listAllSecrets()).map((x) => x.id));
  let assigned = 0;
  const assign = async (identifier: string): Promise<void> => {
    const agentId = await admin.findAgentId(identifier);
    if (!agentId) return;
    const current = await admin.listAgentSecretIds(agentId);
    const kept = current.filter((id) => live.has(id));
    if (kept.includes(secretId) && kept.length === current.length) return;
    await admin.setSecrets(agentId, Array.from(new Set([...kept, secretId])));
    assigned++;
  };
  for (const group of await getAllAgentGroups()) {
    if ((await userCredsProviderForGroup(group.id)) !== provider) continue;
    try {
      await assign(group.id);
      for (const row of await listGroupMemberEnrollments(group.id)) {
        const own = await getUserCredential(row.user_id, provider);
        if (own?.status === 'active' && own.secret_id) continue; // brings their own
        await assign(userCredsAgentIdentifier(group.id, row.user_id));
      }
    } catch (err) {
      log.warn('Workspace default: could not assign to group', { agentGroupId: group.id, err });
    }
  }
  log.info('Workspace default fanned out', { provider, agentsUpdated: assigned });
}

export async function setWorkspaceDefaultCredential(
  admin: OnecliAdmin,
  provider: UserCredsProvider,
  value: string,
  credType: UserCredsCredType,
): Promise<void> {
  await storeUserCredential(admin, WORKSPACE_DEFAULT_USER_ID, provider, value, credType);
  const secretType = secretTypeFor(provider);
  const tracked = new Set(await listAllTrackedSecretIds());
  const stale = (await admin.listAllSecrets()).filter((s) => s.type === secretType && !tracked.has(s.id));

  // Before deleting the legacy secrets, re-point any `selective` agent that was
  // pinned to one onto the new workspace-default. Otherwise a base group agent
  // stuck in selective mode (e.g. a leftover from an earlier per-agent credential
  // setup) silently loses its model credential the moment the legacy secret is
  // deleted — surfacing later as a 401 disguised as "issue with the selected
  // model". `all`-mode agents auto-inject the new secret and need no fixup; and
  // per-member UserCreds agents hold TRACKED secrets, so they never reference a
  // stale id and are naturally excluded from the re-point set.
  const newSecretId = (await getUserCredential(WORKSPACE_DEFAULT_USER_ID, provider))?.secret_id ?? null;
  const staleIds = new Set(stale.map((s) => s.id));
  if (newSecretId && stale.length) {
    for (const agent of await admin.listAgents()) {
      const assigned = await admin.listAgentSecretIds(agent.id);
      if (!assigned.some((id) => staleIds.has(id))) continue;
      const rebuilt = Array.from(new Set(assigned.map((id) => (staleIds.has(id) ? newSecretId : id))));
      await admin.setSecrets(agent.id, rebuilt);
      log.info('Workspace default: re-pointed agent off legacy secret', {
        provider,
        agent: agent.identifier ?? agent.id,
      });
    }
  }

  for (const s of stale) await admin.deleteSecret(s.id).catch(() => {}); // best-effort; leftover is only a duplicate
  if (stale.length)
    log.info('Workspace default: reconciled legacy secrets', { provider, type: secretType, removed: stale.length });

  // The re-minted secret has a new id, so every selective agent must be
  // re-pointed at it or it will 401 on a credential that demonstrably exists.
  if (newSecretId) await fanOutWorkspaceCredential(admin, provider, newSecretId);
}

/** Back-compat alias for the Claude path. */
export async function setWorkspaceDefaultAnthropic(
  admin: OnecliAdmin,
  value: string,
  credType: UserCredsCredType,
): Promise<void> {
  return setWorkspaceDefaultCredential(admin, 'claude', value, credType);
}
