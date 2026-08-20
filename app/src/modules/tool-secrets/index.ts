/**
 * Tool secrets — API credentials (Azure DevOps PATs, GitHub tokens, third-party
 * keys) held in the OneCLI vault and injected by the gateway into matching
 * outbound requests.
 *
 * WHY THIS EXISTS: the alternative users reach for is pasting a token into a
 * chat room, which persists it in `webchat_messages`, the session `inbound.db`,
 * and every archived transcript under `conversations/` — permanently, in
 * several places at once. Agents are instructed to refuse that (see
 * `container/skills/onecli-gateway/SKILL.md`), correctly, which left no
 * sanctioned path. This is that path: the value goes browser → host → vault,
 * is never rendered back, never enters an agent's context, never appears in a
 * message.
 *
 * ── HOW SCOPING ACTUALLY WORKS (the load-bearing fact) ─────────────────────
 * A OneCLI agent in `all` secret mode receives EVERY vault secret whose host
 * pattern matches, regardless of assignment (CLAUDE.md: "every vault secret
 * whose host pattern matches is injected automatically"). Assignment scopes
 * nothing for such an agent — it is only consulted in `selective` mode. Most
 * agents default to `all`, so:
 *
 *   WORKSPACE scope — shared infrastructure credentials, the honest default.
 *     Assigned to EVERY agent rather than left unassigned: `all`-mode agents
 *     would get it either way, but an isolated agent sees only what is assigned,
 *     so leaving it unassigned would silently make "system-wide" mean
 *     "system-wide except the agents you locked down".
 *
 *   AGENT scope — only meaningful once that group's agent is in `selective`
 *     mode (see `isolateGroup`). Until then a secret "for one agent" would in
 *     fact be offered to every `all`-mode agent in the install, so this module
 *     refuses to create one rather than implying an isolation it cannot honour.
 *
 * Selective mode is a real trade: the agent then receives NOTHING implicitly,
 * including its model credential, which surfaces as a 401 from an API whose key
 * IS in the vault. `isolateGroup` therefore pins the model credential first and
 * flips the mode second, so there is never a window where the agent is
 * selective with no way to reach its provider.
 *
 * NO LOCAL TABLE BY DESIGN: OneCLI already stores id, name, type and host
 * pattern; a mirror table could only drift. State is derived from the vault.
 *
 * PRECEDENCE: a member can be offered the same host from three scopes at once.
 * The nearest wins — user > agent > workspace — so "whose PAT pushed this
 * commit?" always has one answer. See `desiredMemberSecrets`.
 *
 * WRITE-ONLY: nothing here returns a secret VALUE. Listing yields metadata so
 * the UI can show what is wired without ever being able to reveal it.
 */
import { log } from '../../log.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { listGroupMemberEnrollments, getUserCredential } from '../user-credentials/db.js';
import { WORKSPACE_DEFAULT_USER_ID, userCredsAgentIdentifier, userSlug } from '../user-credentials/identity.js';
import type { GenericSecretSpec, OnecliAdmin } from '../user-credentials/onecli-admin.js';
import { listDeployKeys } from '../deploy-keys/index.js';
import { syncCredentialNote } from './memory-note.js';

/** Sentinel used in a vault name for a workspace-wide (unassigned) secret. */
const WORKSPACE_SCOPE = '*';

/** Metadata for a wired tool secret. Deliberately carries no value. */
export interface ToolSecretInfo {
  id: string;
  label: string;
  hostPattern: string;
}

/** Whether a group's credentials are isolated, and why it matters to the UI. */
export interface GroupIsolation {
  isolated: boolean;
  /** False when isolation can't be offered — no OneCLI agent for the group yet. */
  available: boolean;
}

/**
 * Who a credential belongs to.
 *
 *   workspace — shared infrastructure, every agent
 *   agent     — one agent group; private once the fleet is locked down
 *   user      — one PERSON within one group. Works without any fleet-wide
 *               precondition because per-member (UserCreds) agents are always
 *               `selective`: they receive only what is assigned to them. This is
 *               what lets Person A push with PAT A while Person B pushes with
 *               PAT B from the same room.
 */
export type Scope =
  | { kind: 'workspace' }
  | { kind: 'agent'; agentGroupId: string }
  | { kind: 'user'; agentGroupId: string; userId: string };

export const WORKSPACE: Scope = { kind: 'workspace' };

/** Stable segment embedded in the vault name — also the scope's identity. */
function scopeKey(scope: Scope): string {
  if (scope.kind === 'workspace') return WORKSPACE_SCOPE;
  if (scope.kind === 'agent') return scope.agentGroupId;
  return `${scope.agentGroupId}:${userSlug(scope.userId)}`;
}

function secretName(scope: Scope, label: string): string {
  return `ToolSecret ${scopeKey(scope)} ${label}`;
}

function labelFromName(scope: Scope, name: string | undefined): string | null {
  const prefix = `ToolSecret ${scopeKey(scope)} `;
  return name && name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

async function providerSecretType(agentGroupId: string): Promise<'anthropic' | 'openai'> {
  return (await getContainerConfig(agentGroupId))?.provider === 'codex' ? 'openai' : 'anthropic';
}

/**
 * Desired secret assignment for ONE per-member agent, with precedence.
 *
 * A member can be offered the same host from three directions: their own
 * credential, their group's, and the workspace's. Assigning all three leaves the
 * gateway to pick arbitrarily — which produces the worst possible bug, "whose
 * PAT pushed this commit?", answered differently on different days. So the
 * nearest scope wins per host: user > agent > workspace.
 *
 * Computed as a whole and written with a single setSecrets, rather than
 * incremental add/remove, so precedence can never drift out of sync with the
 * secrets that exist.
 */
async function desiredMemberSecrets(
  admin: OnecliAdmin,
  agentGroupId: string,
  userId: string,
  modelCredId: string | null,
): Promise<string[]> {
  const byHost = new Map<string, string>(); // host → winning secret id
  const take = (secrets: ToolSecretInfo[]) => {
    for (const s of secrets) if (!byHost.has(s.hostPattern)) byHost.set(s.hostPattern, s.id);
  };
  // Order IS the precedence.
  take(await listToolSecrets(admin, { kind: 'user', agentGroupId, userId }));
  take(await listToolSecrets(admin, { kind: 'agent', agentGroupId }));
  take(await listToolSecrets(admin, WORKSPACE));
  const ids = [...byHost.values()];
  if (modelCredId) ids.push(modelCredId);
  return Array.from(new Set(ids));
}

/** Re-apply precedence for one member agent (no-op if they aren't enrolled). */
async function reconcileMember(admin: OnecliAdmin, agentGroupId: string, userId: string): Promise<void> {
  const identifier = userCredsAgentIdentifier(agentGroupId, userId);
  const agentId = await admin.findAgentId(identifier);
  if (!agentId) return;
  // Preserve whatever provider credential the member is already using — that is
  // theirs (their own key or the workspace default) and is not ours to change.
  const assigned = await admin.listAgentSecretIds(agentId);
  const typeById = new Map((await admin.listAllSecrets()).map((x) => [x.id, x.type]));
  // Only ids the vault still KNOWS about, and that aren't tool secrets. An
  // unknown id is a deleted secret — keeping it would resurrect dangling
  // assignments and, worse, mistake a just-deleted PAT for a model credential.
  const modelCred =
    assigned.find((id) => {
      const t = typeById.get(id);
      return t !== undefined && t !== 'generic';
    }) ?? null;
  await admin.setSecrets(agentId, await desiredMemberSecrets(admin, agentGroupId, userId, modelCred));
}

/** Re-apply assignment for a group's own agent: its secrets + workspace ones. */
async function reconcileGroupAgent(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  const agentId = await admin.findAgentId(agentGroupId);
  if (!agentId) return;
  const assigned = await admin.listAgentSecretIds(agentId);
  const typeById = new Map((await admin.listAllSecrets()).map((x) => [x.id, x.type]));
  const keep = assigned.filter((id) => {
    const t = typeById.get(id);
    return t !== undefined && t !== 'generic';
  });
  const byHost = new Map<string, string>();
  for (const sec of await listToolSecrets(admin, { kind: 'agent', agentGroupId })) byHost.set(sec.hostPattern, sec.id);
  for (const sec of await listToolSecrets(admin, WORKSPACE))
    if (!byHost.has(sec.hostPattern)) byHost.set(sec.hostPattern, sec.id);
  await admin.setSecrets(agentId, Array.from(new Set([...keep, ...byHost.values()])));
}

/**
 * Re-apply assignment everywhere a scope's change could be felt. Workspace
 * secrets touch every agent; a group secret touches that group and its members;
 * a user secret touches only that person's agent.
 */
async function reconcile(admin: OnecliAdmin, scope: Scope): Promise<void> {
  if (scope.kind === 'user') return reconcileMember(admin, scope.agentGroupId, scope.userId);
  const groups = scope.kind === 'workspace' ? (await getAllAgentGroups()).map((g) => g.id) : [scope.agentGroupId];
  for (const gid of groups) {
    await reconcileGroupAgent(admin, gid);
    for (const row of listGroupMemberEnrollments(gid)) await reconcileMember(admin, gid, row.user_id);
  }
}

/** Is this group's own agent in `selective` mode (i.e. are its secrets scoped)? */
export async function getGroupIsolation(admin: OnecliAdmin, agentGroupId: string): Promise<GroupIsolation> {
  const agentId = await admin.findAgentId(agentGroupId);
  if (!agentId) return { isolated: false, available: false };
  return { isolated: (await admin.getSecretMode(agentId)) === 'selective', available: true };
}

/**
 * Put a group's agent into `selective` mode so per-agent secrets mean something.
 *
 * Order is a safety property, not a style choice: pin the model credential and
 * existing assignments FIRST, flip the mode SECOND. Reversed, the agent would
 * spend the gap in selective mode with nothing assigned — a live 401 for every
 * request it makes. If no model credential can be resolved we refuse outright
 * rather than isolate an agent into a guaranteed outage.
 */
export async function isolateGroup(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  const agentId = await admin.findAgentId(agentGroupId);
  if (!agentId) throw new Error('No OneCLI agent for this group yet');
  if ((await admin.getSecretMode(agentId)) === 'selective') return;

  const assigned = await admin.listAgentSecretIds(agentId);
  const wantType = await providerSecretType(agentGroupId);
  const all = await admin.listAllSecrets();
  const typeById = await new Map(all.map((s) => [s.id, s.type]));
  // Prefer a provider secret already assigned; otherwise the workspace default,
  // which is what an `all`-mode agent has been implicitly using all along.
  let modelCred = assigned.find((id) => typeById.get(id) === wantType) ?? null;
  if (!modelCred) {
    const provider = wantType === 'openai' ? 'codex' : 'claude';
    const row = await getUserCredential(WORKSPACE_DEFAULT_USER_ID, provider);
    modelCred = row?.status === 'active' ? row.secret_id : null;
  }
  if (!modelCred)
    throw new Error('No model credential to pin — connect a workspace default first, or isolation would 401');

  await admin.setSecrets(agentId, Array.from(new Set([...assigned, modelCred])));
  await admin.setSecretMode(agentId, 'selective');
  log.info('Agent group credentials isolated', { agentGroupId });
}

/** Return a group to `all` mode — it resumes receiving every matching secret. */
export async function unisolateGroup(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  const agentId = await admin.findAgentId(agentGroupId);
  if (!agentId) throw new Error('No OneCLI agent for this group yet');
  await admin.setSecretMode(agentId, 'all');
  log.info('Agent group credentials un-isolated', { agentGroupId });
}

/**
 * Lock down every agent: pin what each currently receives implicitly, then flip
 * it to `selective`. This is what makes per-agent secrets real — until every
 * OTHER agent is selective, a secret "for one agent" is still offered to all of
 * them. Per-agent failures are collected rather than thrown so one unresolvable
 * group can't leave the fleet half-migrated with no report.
 */
export async function isolateAllGroups(
  admin: OnecliAdmin,
): Promise<{ isolated: string[]; skipped: { id: string; reason: string }[] }> {
  const isolated: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const group of getAllAgentGroups()) {
    try {
      const { available } = await getGroupIsolation(admin, group.id);
      if (!available) {
        skipped.push({ id: group.id, reason: 'no OneCLI agent yet' });
        continue;
      }
      await isolateGroup(admin, group.id);
      isolated.push(group.id);
    } catch (err) {
      skipped.push({ id: group.id, reason: err instanceof Error ? err.message : 'unknown' });
    }
  }
  log.info('Fleet isolation run', { isolated: isolated.length, skipped: skipped.length });
  return { isolated, skipped };
}

/**
 * How a credential for `host` goes on the wire.
 *
 * Asking the operator for a header name and value template is asking them to
 * know an API's auth scheme by heart; almost every service is `Authorization:
 * Bearer`, and the notable exception (Azure DevOps) has a fixed, knowable rule.
 * So infer it, and keep the knowledge in one place instead of in a dropdown.
 *
 * `encodeBasic` marks the schemes where the wire value is not the raw token:
 * Azure DevOps takes a PAT as HTTP Basic with an EMPTY username, i.e.
 * base64(":<pat>"), so the operator can paste the PAT exactly as Azure shows it.
 */
/**
 * How a credential for `host` goes on the wire.
 *
 * Inference stays the default: for a public API the hostname names the service,
 * so the operator should not have to know its auth header. It cannot work for a
 * self-hosted API, whose host is just a LAN address that says nothing about
 * which service answers there — so `scheme` overrides it.
 *
 * Deliberately NOT a table of named services. Every scheme is the same shape,
 * `<header>: <template containing {value}>`, so a per-service entry would add a
 * release cycle to every new integration and would bake one deployment's stack
 * into the product. Express the shape; let the operator fill it in.
 */
export type AuthScheme = { headerName: string; valueFormat: string };

// RFC 7230 field-name token. Anything outside this cannot be a header name, and
// rejecting it here is what keeps a crafted request from smuggling one.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

// Headers that control the request itself rather than authenticate it. Letting a
// credential set these would let it retarget or reframe the proxied call.
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-connection',
]);

/**
 * Validate an operator-supplied scheme. Returns the spec, or a message safe to
 * show back.
 *
 * The template is checked for a single `{value}` (zero would store a credential
 * that is never sent; more than one would repeat it) and restricted to printable
 * ASCII — CR/LF in a header value is request splitting, and this is the one
 * place an operator-supplied string reaches a header verbatim.
 */
export function parseCustomScheme(headerName: unknown, valueFormat: unknown): AuthScheme | { error: string } {
  if (typeof headerName !== 'string' || !HEADER_NAME_RE.test(headerName))
    return { error: "Header name must be a valid HTTP header token (letters, digits and !#$%&'*+.^_`|~-)" };
  if (FORBIDDEN_HEADERS.has(headerName.toLowerCase()))
    return { error: `${headerName} controls the request itself and cannot carry a credential` };
  if (typeof valueFormat !== 'string' || valueFormat.length > 128)
    return { error: 'Value template must be a string of at most 128 characters' };
  const occurrences = valueFormat.split('{value}').length - 1;
  if (occurrences !== 1) return { error: 'Value template must contain {value} exactly once' };
  if (!/^[\x20-\x7E]*$/.test(valueFormat)) return { error: 'Value template must be printable ASCII on a single line' };
  return { headerName, valueFormat };
}

/** Resolve a wire-format choice, or an error message. */
export function resolveAuthScheme(input: unknown): AuthScheme | { error: string } {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    return parseCustomScheme(o.headerName, o.valueFormat);
  }
  return { error: 'scheme must be {headerName, valueFormat}' };
}

export function injectionForHost(host: string, scheme?: AuthScheme): GenericSecretSpec & { encodeBasic?: boolean } {
  if (scheme) return { hostPattern: host, ...scheme };
  const h = host.toLowerCase().replace(/^\*\./, '');
  if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com'))
    return { hostPattern: host, headerName: 'Authorization', valueFormat: 'Basic {value}', encodeBasic: true };
  if (h === 'api.github.com' || h === 'github.com' || h.endsWith('.githubusercontent.com'))
    return { hostPattern: host, headerName: 'Authorization', valueFormat: 'Bearer {value}' };
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com'))
    return { hostPattern: host, headerName: 'PRIVATE-TOKEN', valueFormat: '{value}' };
  return { hostPattern: host, headerName: 'Authorization', valueFormat: 'Bearer {value}' };
}

/** Hosts this group can authenticate to — its own secrets plus the shared ones. */
async function accessibleHosts(admin: OnecliAdmin, agentGroupId: string): Promise<string[]> {
  const own = await listToolSecrets(admin, { kind: 'agent', agentGroupId });
  const shared = await listToolSecrets(admin, WORKSPACE);
  const perUser: ToolSecretInfo[] = [];
  for (const row of listGroupMemberEnrollments(agentGroupId))
    perUser.push(...(await listToolSecrets(admin, { kind: 'user', agentGroupId, userId: row.user_id })));
  return [...own, ...shared, ...perUser].map((s) => s.hostPattern).filter(Boolean);
}

/** Refresh one group's note — exported so deploy-key changes can trigger it too. */
export async function refreshCredentialNote(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  syncCredentialNote(agentGroupId, await accessibleHosts(admin, agentGroupId), listDeployKeys(agentGroupId));
}

/** Refresh the credential note for one group, or for every group (shared secret). */
async function refreshNotes(admin: OnecliAdmin, scope: Scope): Promise<void> {
  const groups = scope.kind === 'workspace' ? (await getAllAgentGroups()).map((g) => g.id) : [scope.agentGroupId];
  for (const id of groups) syncCredentialNote(id, await accessibleHosts(admin, id), listDeployKeys(id));
}

/** Wired tool secrets for a scope — metadata only, never values. */
export async function listToolSecrets(admin: OnecliAdmin, scope: Scope): Promise<ToolSecretInfo[]> {
  const out: ToolSecretInfo[] = [];
  for (const s of await admin.listAllSecrets()) {
    if (s.type !== 'generic') continue;
    const label = labelFromName(scope, s.name);
    if (label === null) continue;
    out.push({ id: s.id, label, hostPattern: s.hostPattern ?? '' });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Create a tool secret. Workspace-scoped secrets are left unassigned (every
 * `all`-mode agent picks them up). Agent-scoped secrets are assigned to the
 * group's agents — and REQUIRE the group to be isolated first, because in `all`
 * mode the gateway would hand the credential to every other agent too.
 */
export async function createToolSecret(
  admin: OnecliAdmin,
  scope: Scope,
  host: string,
  value: string,
  scheme?: AuthScheme,
): Promise<ToolSecretInfo> {
  // The host IS the identity of the credential — one credential per host per
  // scope — so it doubles as the label and there is nothing extra to name.
  const label = host;
  if (scope.kind === 'agent') {
    // A group only gets a vault identity when it first spawns a container, so a
    // never-run agent has none. Create it here rather than making the operator
    // go and message the agent first — ensureAgent is idempotent, and the
    // identifier is the same one container-runner uses.
    let { isolated, available } = await getGroupIsolation(admin, scope.agentGroupId);
    if (!available) {
      const group = await getAgentGroup(scope.agentGroupId);
      if (!group) throw new Error('Unknown agent group');
      await admin.ensureAgent(group.name, scope.agentGroupId);
      ({ isolated, available } = await getGroupIsolation(admin, scope.agentGroupId));
      if (!available) throw new Error('Could not create an OneCLI agent for this group');
    }
    // A brand-new agent starts in `all` mode; isolate before it can hold a
    // credential, or the secret would be offered to every other agent too.
    if (!isolated) {
      await isolateGroup(admin, scope.agentGroupId);
      isolated = (await getGroupIsolation(admin, scope.agentGroupId)).isolated;
    }
    if (!isolated) throw new Error('Could not isolate this agent — refusing to add a shared-visible secret');
  }
  if (scope.kind === 'user') {
    // A per-member agent exists only after UserCreds enrollment. Without it
    // there is no identity to attach the credential to, and silently falling
    // back to the group would make Person A's PAT everyone's PAT.
    const enrolled = (await listGroupMemberEnrollments(scope.agentGroupId)).some((r) => r.user_id === scope.userId);
    if (!enrolled) throw new Error('This person has not connected their credentials for this agent yet');
  }
  const existing = await listToolSecrets(admin, scope);
  if (existing.some((s) => s.hostPattern === host))
    throw new Error(`A credential for ${host} already exists at this scope — remove it first`);

  const inferred = injectionForHost(host, scheme);
  const spec: GenericSecretSpec = {
    hostPattern: inferred.hostPattern,
    headerName: inferred.headerName,
    valueFormat: inferred.valueFormat,
  };
  const wireValue = inferred.encodeBasic ? Buffer.from(`:${value}`).toString('base64') : value;

  const secretId = await admin.createGenericSecret(secretName(scope, label), wireValue, spec);
  try {
    await reconcile(admin, scope);
  } catch (err) {
    // Never leave an orphan holding a live credential that nothing can use.
    await admin.deleteSecret(secretId).catch(() => {});
    throw err;
  }
  await refreshNotes(admin, scope);
  log.info('Tool secret created', { scope: scopeKey(scope), hostPattern: spec.hostPattern });
  return { id: secretId, label, hostPattern: spec.hostPattern };
}

/**
 * Unwire and delete a tool secret. Refuses ids outside the given scope, so a
 * crafted request can't delete another group's (or a provider) secret out of
 * the shared vault.
 */
export async function deleteToolSecret(admin: OnecliAdmin, scope: Scope, secretId: string): Promise<boolean> {
  const owned = (await listToolSecrets(admin, scope)).some((s) => s.id === secretId);
  if (!owned) return false;
  await admin.deleteSecret(secretId);
  // Reconcile AFTER deletion so a now-uncovered host falls through to the next
  // scope (a member losing their own PAT goes back to the group's, if any).
  await reconcile(admin, scope);
  await refreshNotes(admin, scope);
  log.info('Tool secret deleted', { scope: scopeKey(scope), secretId });
  return true;
}
