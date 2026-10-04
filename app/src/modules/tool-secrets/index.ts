/**
 * Tool secrets — API credentials (Azure DevOps PATs, GitHub tokens, third-party
 * keys) held in the OneCLI vault and injected by the gateway into matching
 * outbound requests.
 *
 * WHY: pasting a token into a chat room persists it in `webchat_messages`, the
 * session `inbound.db` and every archived transcript, and agents are told to
 * refuse it. This is the sanctioned path: browser → host → vault, never
 * rendered back, never in an agent's context or a message.
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
 *     fact be offered to every `all`-mode agent, so creating one isolates the
 *     group first and refuses if that fails.
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
import {
  listGroupMemberEnrollments,
  getUserCredential,
  getUserCredsCredential,
  setUserCredsStatus,
} from '../user-credentials/db.js';
import { WORKSPACE_DEFAULT_USER_ID, userCredsAgentIdentifier, userSlug } from '../user-credentials/identity.js';
import {
  isToolSecret,
  TOOL_SECRET_NAME_PREFIX,
  type GenericSecretSpec,
  type OnecliAdmin,
} from '../user-credentials/onecli-admin.js';
import { listDeployKeys } from '../deploy-keys/index.js';
import { syncCredentialNote } from './memory-note.js';

/** Sentinel used in a vault name for a workspace-wide (unassigned) secret. */
const WORKSPACE_SCOPE = '*';

/** Metadata for a wired tool secret. Deliberately carries no value. */
export interface ToolSecretInfo {
  id: string;
  label: string;
  hostPattern: string;
  /**
   * How it was entered, read back from how it goes on the wire: the host's own
   * scheme ('token'), HTTP Basic from a username and password ('basic'), or a
   * stated header ('custom', with that header and template). Never the value.
   */
  kind?: 'token' | 'basic' | 'custom';
  headerName?: string;
  valueFormat?: string;
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

/**
 * Secrets some agents of this install hold besides their tool secrets, from
 * other modules (the cloud-model router's master key: cloud-models.ts, held
 * only by agents whose model the router serves). The reconcile below writes
 * each agent's full list, so a secret assigned outside it would be dropped at
 * the next tool-secret change; a source here is part of the list instead.
 * `ids` names every secret the source manages, so one an agent should no
 * longer hold is dropped too; `wants` says which agent groups hold them.
 */
export interface AssignedSecretSource {
  ids(admin: OnecliAdmin): Promise<string[]>;
  wants(agentGroupId: string): Promise<boolean>;
}
const assignedSources: AssignedSecretSource[] = [];
export function registerAssignedSecretSource(source: AssignedSecretSource): void {
  assignedSources.push(source);
}
/** Every source-managed id, and the ones this group's agents should hold. */
async function assignedSourceIds(
  admin: OnecliAdmin,
  agentGroupId: string,
): Promise<{ managed: Set<string>; wanted: string[] }> {
  const managed = new Set<string>();
  const wanted: string[] = [];
  for (const source of assignedSources) {
    const ids = await source.ids(admin);
    for (const id of ids) managed.add(id);
    if (ids.length && (await source.wants(agentGroupId).catch(() => false))) wanted.push(...ids);
  }
  return { managed, wanted };
}

/** Stable segment embedded in the vault name — also the scope's identity. */
function scopeKey(scope: Scope): string {
  if (scope.kind === 'workspace') return WORKSPACE_SCOPE;
  if (scope.kind === 'agent') return scope.agentGroupId;
  return `${scope.agentGroupId}:${userSlug(scope.userId)}`;
}

function secretName(scope: Scope, label: string): string {
  return `${TOOL_SECRET_NAME_PREFIX}${scopeKey(scope)} ${label}`;
}

function labelFromName(scope: Scope, name: string | undefined): string | null {
  const prefix = `${TOOL_SECRET_NAME_PREFIX}${scopeKey(scope)} `;
  return name && name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

async function providerSecretType(agentGroupId: string): Promise<'anthropic' | 'openai'> {
  return (await getContainerConfig(agentGroupId))?.provider === 'codex' ? 'openai' : 'anthropic';
}

/** Per host, the one secret a container sends and the scope it came from. */
export interface EffectiveSecret {
  hostPattern: string;
  source: Scope['kind'];
  secretId: string;
}

/** Nearest scope wins per host; `scopes` is given nearest-first. */
async function winnersByHost(admin: OnecliAdmin, scopes: Scope[]): Promise<EffectiveSecret[]> {
  const byHost = new Map<string, EffectiveSecret>();
  for (const scope of scopes) {
    for (const s of await listToolSecrets(admin, scope)) {
      if (!byHost.has(s.hostPattern))
        byHost.set(s.hostPattern, { hostPattern: s.hostPattern, source: scope.kind, secretId: s.id });
    }
  }
  return [...byHost.values()];
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
  // Order IS the precedence.
  const winners = await winnersByHost(admin, [
    { kind: 'user', agentGroupId, userId },
    { kind: 'agent', agentGroupId },
    WORKSPACE,
  ]);
  const ids = winners.map((w) => w.secretId);
  if (modelCredId) ids.push(modelCredId);
  ids.push(...(await assignedSourceIds(admin, agentGroupId)).wanted);
  return Array.from(new Set(ids));
}

/**
 * What ONE person's turns on ONE agent send, per host — the precedence the
 * reconcile writes, read back so the UI can say it instead of leaving the
 * operator to work out which of three same-host rows is theirs.
 *
 * Enrolled, the person runs on their own per-member agent: user > agent >
 * workspace. Not enrolled, they run on the group's own agent, which has no user
 * scope: agent > workspace. This describes the ASSIGNED precedence — what an
 * isolated agent receives. A group still in `all` mode receives every matching
 * vault secret regardless, which the panel already flags as "not private yet".
 */
export async function effectiveSecretsFor(
  admin: OnecliAdmin,
  agentGroupId: string,
  userId: string,
): Promise<EffectiveSecret[]> {
  const enrolled = (await listGroupMemberEnrollments(agentGroupId)).some((r) => r.user_id === userId);
  const own: Scope[] = enrolled ? [{ kind: 'user', agentGroupId, userId }] : [];
  return winnersByHost(admin, [...own, { kind: 'agent', agentGroupId }, WORKSPACE]);
}

/** Of these agent groups, the ones this person holds personal secrets for. */
export async function groupsWithPersonalSecrets(
  admin: OnecliAdmin,
  userId: string,
  agentGroupIds: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const agentGroupId of agentGroupIds)
    if ((await listToolSecrets(admin, { kind: 'user', agentGroupId, userId })).length) out.push(agentGroupId);
  return out;
}

/** Re-apply one member agent's assignment (after its enrollment changed hands). */
export function reconcileMemberSecrets(admin: OnecliAdmin, agentGroupId: string, userId: string): Promise<void> {
  return reconcileMember(admin, agentGroupId, userId);
}

/** Re-apply precedence for one member agent (no-op if they aren't enrolled). */
async function reconcileMember(admin: OnecliAdmin, agentGroupId: string, userId: string): Promise<void> {
  const identifier = userCredsAgentIdentifier(agentGroupId, userId);
  const agentId = await admin.findAgentId(identifier);
  if (!agentId) return;
  // Preserve whatever provider credential the member is already using — that is
  // theirs (their own key or the workspace default) and is not ours to change.
  const assigned = await admin.listAgentSecretIds(agentId);
  const byId = new Map((await admin.listAllSecrets()).map((x) => [x.id, x]));
  // Only ids the vault still KNOWS about, and that aren't tool secrets. An
  // unknown id is a deleted secret — keeping it would resurrect dangling
  // assignments and, worse, mistake a just-deleted PAT for a model credential.
  // The enrollment names the member's credential by id. Without it: a
  // provider-typed secret, then a `generic` one that isn't a tool secret by
  // name (a Grok credential is `generic`, the same type as a PAT).
  // Nor ids another module manages (the router's key is `generic` too): those
  // follow the source's own rule, in desiredMemberSecrets.
  const { managed } = await assignedSourceIds(admin, agentGroupId);
  const known = assigned.filter((id) => byId.has(id) && !managed.has(id));
  const enrolled = (await getUserCredsCredential(userId, agentGroupId))?.secret_id ?? null;
  const modelCred =
    (enrolled && known.includes(enrolled) ? enrolled : null) ??
    known.find((id) => byId.get(id)!.type !== 'generic') ??
    known.find((id) => !isToolSecret(byId.get(id))) ??
    null;
  await admin.setSecrets(agentId, await desiredMemberSecrets(admin, agentGroupId, userId, modelCred));
}

/** Re-apply assignment for a group's own agent: its secrets + workspace ones. */
async function reconcileGroupAgent(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  const agentId = await admin.findAgentId(agentGroupId);
  if (!agentId) return;
  const assigned = await admin.listAgentSecretIds(agentId);
  const byId = new Map((await admin.listAllSecrets()).map((x) => [x.id, x]));
  const { managed } = await assignedSourceIds(admin, agentGroupId);
  const keep = assigned.filter((id) => {
    const x = byId.get(id);
    return x !== undefined && !isToolSecret(x) && !managed.has(id);
  });
  await admin.setSecrets(agentId, Array.from(new Set([...keep, ...(await groupToolSecretIds(admin, agentGroupId))])));
}

/** The tool secrets a group's own agent should hold: its own, then workspace ones for other hosts. */
async function groupToolSecretIds(admin: OnecliAdmin, agentGroupId: string): Promise<string[]> {
  const byHost = new Map<string, string>();
  for (const sec of await listToolSecrets(admin, { kind: 'agent', agentGroupId })) byHost.set(sec.hostPattern, sec.id);
  for (const sec of await listToolSecrets(admin, WORKSPACE))
    if (!byHost.has(sec.hostPattern)) byHost.set(sec.hostPattern, sec.id);
  return [...byHost.values(), ...(await assignedSourceIds(admin, agentGroupId)).wanted];
}

/** Re-apply every agent's assignment: after a registered source's secret was added or removed. */
export function reconcileAllAgents(admin: OnecliAdmin): Promise<void> {
  return reconcile(admin, WORKSPACE);
}

/** Re-apply one group's assignments, its own agent's and its members': after what a source wants for it changed. */
export function reconcileGroupAgents(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  return reconcile(admin, { kind: 'agent', agentGroupId });
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
    for (const row of await listGroupMemberEnrollments(gid)) await reconcileMember(admin, gid, row.user_id);
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

  // Source-managed ids are re-added below only if the group should hold them.
  const { managed } = await assignedSourceIds(admin, agentGroupId);
  const assigned = (await admin.listAgentSecretIds(agentId)).filter((id) => !managed.has(id));
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

  // Workspace and agent secrets too: in `selective` mode an agent receives only
  // what is assigned, and one created after a workspace secret was saved (or
  // that had been receiving it implicitly in `all` mode) was never assigned it.
  const tools = await groupToolSecretIds(admin, agentGroupId);
  await admin.setSecrets(agentId, Array.from(new Set([...assigned, modelCred, ...tools])));
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
  for (const group of await getAllAgentGroups()) {
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
 * An operator-supplied wire format, for a self-hosted API whose host (a LAN
 * address) says nothing about which service answers there. Deliberately a
 * shape, `<header>: <template containing {value}>`, not a table of named
 * services: a per-service entry would add a release cycle to every integration.
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

/** RFC 7617 credentials: base64 of the UTF-8 `user:password` pair. */
export function basicAuthValue(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

const BASIC_SCHEME: AuthScheme = { headerName: 'Authorization', valueFormat: 'Basic {value}' };

/**
 * Validate a username + password pair and turn it into the stored wire value
 * and scheme. Errors never quote either field. A colon in the username cannot
 * be told apart from the separator (RFC 7617); control characters would be
 * rejected by most servers.
 */
export function resolveBasicCredential(input: unknown): { value: string; scheme: AuthScheme } | { error: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const { username, password } = o;
  if (typeof username !== 'string' || !username) return { error: 'Username is required' };
  if (typeof password !== 'string' || !password) return { error: 'Password is required' };
  if (username.length > 256 || password.length > 256)
    return { error: 'Username and password must each be at most 256 characters' };
  if (username.includes(':')) return { error: 'Username cannot contain a colon' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(username)) return { error: 'Username must be printable text on a single line' };
  return { value: basicAuthValue(username, password), scheme: BASIC_SCHEME };
}

/**
 * How a credential for `host` goes on the wire: `scheme` if given, else
 * inferred from the host so the operator needn't know an API's auth header.
 * `encodeBasic` marks schemes where the wire value is not the raw token: Azure
 * DevOps takes a PAT as HTTP Basic with an EMPTY username, base64(":<pat>").
 */
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
  for (const row of await listGroupMemberEnrollments(agentGroupId))
    perUser.push(...(await listToolSecrets(admin, { kind: 'user', agentGroupId, userId: row.user_id })));
  return [...own, ...shared, ...perUser].map((s) => s.hostPattern).filter(Boolean);
}

/** Refresh one group's note — exported so deploy-key changes can trigger it too. */
export async function refreshCredentialNote(admin: OnecliAdmin, agentGroupId: string): Promise<void> {
  await syncCredentialNote(
    agentGroupId,
    await accessibleHosts(admin, agentGroupId),
    await listDeployKeys(agentGroupId),
  );
}

/** Refresh the credential note for one group, or for every group (shared secret). */
async function refreshNotes(admin: OnecliAdmin, scope: Scope): Promise<void> {
  const groups = scope.kind === 'workspace' ? (await getAllAgentGroups()).map((g) => g.id) : [scope.agentGroupId];
  for (const id of groups) await syncCredentialNote(id, await accessibleHosts(admin, id), await listDeployKeys(id));
}

/** Wired tool secrets for a scope — metadata only, never values. */
export async function listToolSecrets(admin: OnecliAdmin, scope: Scope): Promise<ToolSecretInfo[]> {
  const out: ToolSecretInfo[] = [];
  for (const s of await admin.listAllSecrets()) {
    if (s.type !== 'generic') continue;
    const label = labelFromName(scope, s.name);
    if (label === null) continue;
    out.push({ id: s.id, label, hostPattern: s.hostPattern ?? '', ...secretKindOf(s.hostPattern ?? '', s) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Which form a stored secret came from. A row with no wire settings read back counts as a token. */
function secretKindOf(
  host: string,
  wire: { headerName?: string; valueFormat?: string },
): Pick<ToolSecretInfo, 'kind' | 'headerName' | 'valueFormat'> {
  if (!wire.headerName || !wire.valueFormat) return { kind: 'token' };
  const usual = injectionForHost(host);
  if (wire.headerName === usual.headerName && wire.valueFormat === usual.valueFormat) return { kind: 'token' };
  if (wire.headerName.toLowerCase() === 'authorization' && wire.valueFormat === 'Basic {value}')
    return { kind: 'basic' };
  return { kind: 'custom', headerName: wire.headerName, valueFormat: wire.valueFormat };
}

/**
 * Create a tool secret and reconcile its scope's assignments. Agent-scoped
 * secrets REQUIRE the group to be isolated first, because in `all` mode the
 * gateway would hand the credential to every other agent too.
 */
export async function createToolSecret(
  admin: OnecliAdmin,
  scope: Scope,
  rawHost: string,
  value: string,
  scheme?: AuthScheme,
): Promise<ToolSecretInfo> {
  // Hostnames are case-insensitive; the gateway's pattern match is not (a phone
  // keyboard's "Dev.azure.com" would never be sent). Normalise once, here.
  const host = rawHost.trim().toLowerCase();
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
    // A personal secret needs the person's own agent: falling back to the
    // group's would make Person A's PAT everyone's PAT. Connecting a model
    // credential creates one, and so does the route before a first personal
    // secret (user-credentials ensurePersonalEnrollment, on the workspace's).
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
  const wireValue = inferred.encodeBasic ? basicAuthValue('', value) : value;

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
 * Give a tool secret a new value — and, when the kind changed, a new way on
 * the wire — in place: the same vault secret, so every assignment stands and
 * there is no moment without a credential. The host stays: it is what the
 * credential is (another host is remove and add). Refuses ids outside the
 * scope, as delete does. Null when the id is not this scope's.
 */
export async function updateToolSecret(
  admin: OnecliAdmin,
  scope: Scope,
  secretId: string,
  value: string,
  scheme?: AuthScheme,
): Promise<ToolSecretInfo | null> {
  const current = (await listToolSecrets(admin, scope)).find((s) => s.id === secretId);
  if (!current) return null;
  const inferred = injectionForHost(current.hostPattern, scheme);
  const wireValue = inferred.encodeBasic ? basicAuthValue('', value) : value;
  await admin.updateGenericSecret(secretId, wireValue, {
    headerName: inferred.headerName,
    valueFormat: inferred.valueFormat,
  });
  log.info('Tool secret updated', { scope: scopeKey(scope), hostPattern: current.hostPattern });
  return {
    id: secretId,
    label: current.label,
    hostPattern: current.hostPattern,
    ...secretKindOf(current.hostPattern, inferred),
  };
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
  // Their last personal secret, and no credential of their own behind the
  // enrollment: back to the shared session.
  if (scope.kind === 'user' && (await listToolSecrets(admin, scope)).length === 0) {
    const row = await getUserCredsCredential(scope.userId, scope.agentGroupId);
    if (row?.status === 'active' && !row.secret_id)
      await setUserCredsStatus(scope.userId, scope.agentGroupId, 'revoked');
  }
  await refreshNotes(admin, scope);
  log.info('Tool secret deleted', { scope: scopeKey(scope), secretId });
  return true;
}
