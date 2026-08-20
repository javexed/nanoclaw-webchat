/**
 * Webchat DB helpers — typed CRUD over the central DB tables created by
 * migration `webchat-initial`.
 *
 * Does NOT replace inbound.db / outbound.db — the adapter mirrors agent
 * traffic into webchat_messages so the PWA has a unified history view, but
 * routing/delivery still flows through the v2 session DBs.
 */
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { createMessagingGroup, deleteMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getMcpServersForAgent } from './mcp-registry.js';

/**
 * "Webchat room" is a UI-level alias for `messaging_groups WHERE channel_type='webchat'`.
 * The room id surfaces as `messaging_groups.platform_id`. Two layers describing
 * one concept were collapsed by the `webchat-drop-rooms` migration; this
 * interface keeps the simpler shape for callers that don't care about the
 * generic platform schema.
 */
export interface WebchatRoom {
  id: string;
  name: string;
  created_at: number;
  /**
   * Per-user archive flag. Not populated by row mapping (it's per-viewer
   * state, not part of the room itself); set by the view layer before
   * returning to the client. Optional + default-false on the client.
   */
  archived?: boolean;
}

export interface FileMeta {
  url: string;
  filename: string;
  mime: string;
  size: number;
}

export interface WebchatMessage {
  id: string;
  room_id: string;
  /** Thread this message belongs to. 'main' is the room's default thread. */
  thread_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: 'text' | 'file' | 'a2a' | 'approval' | 'approval_resolved' | 'context-divider' | 'skill_draft';
  file_meta?: FileMeta | null;
  created_at: number;
  /** Provenance for thread context sync: null=native, 'pulled' (from main),
   *  'pushed' (up from a thread). See docs/webchat/thread-context-sync.md. */
  origin?: 'pulled' | 'pushed' | null;
}

interface WebchatMessageRow {
  id: string;
  room_id: string;
  thread_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: 'text' | 'file' | 'a2a' | 'approval' | 'approval_resolved' | 'skill_draft';
  file_meta: string | null;
  created_at: number;
}

export interface WebchatPushSubscription {
  endpoint: string;
  identity: string;
  keys_json: string;
  created_at: number;
}

// ── Rooms ──
// All four helpers route through `messaging_groups WHERE channel_type='webchat'`.
// The legacy `webchat_rooms` table was dropped by the `webchat-drop-rooms`
// migration; `id` here is `messaging_groups.platform_id`.

function rowToRoom(row: { platform_id: string; name: string | null; created_at: string }): WebchatRoom {
  return {
    id: row.platform_id,
    name: row.name ?? row.platform_id,
    created_at: Date.parse(row.created_at) || Date.now(),
  };
}

export async function createWebchatRoom(name: string, id?: string): Promise<WebchatRoom> {
  const platformId = id ?? randomUUID();
  // Guard against duplicate creation — re-running setup or the install-time
  // bootstrap can call this twice for the same canonical room.
  const existing = await getMessagingGroupByPlatform('webchat', platformId);
  if (existing) {
    return {
      id: existing.platform_id,
      name: existing.name ?? platformId,
      created_at: Date.parse(existing.created_at) || Date.now(),
    };
  }
  const createdAt = new Date().toISOString();
  await createMessagingGroup({
    id: randomUUID(),
    channel_type: 'webchat',
    platform_id: platformId,
    name,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  return {
    id: platformId,
    name,
    created_at: Date.parse(createdAt),
  };
}

export async function getWebchatRoom(id: string): Promise<WebchatRoom | undefined> {
  const mg = await getMessagingGroupByPlatform('webchat', id);
  if (!mg) return undefined;
  return {
    id: mg.platform_id,
    name: mg.name ?? mg.platform_id,
    created_at: Date.parse(mg.created_at) || Date.now(),
  };
}

/**
 * Synthetic platform_id prefix for per-user approval inboxes. The webchat
 * adapter exposes openDM() returning this shape so requestApproval() can
 * resolve a delivery target for webchat users; the row exists in
 * messaging_groups so MessagingGroup-shaped APIs work, but it does not
 * represent a real chat room — it's an approver inbox keyed on the user's
 * handle. Hidden from the room list so it never surfaces in the sidebar.
 */
export const APPROVAL_INBOX_PREFIX = 'approvals:';

export function isApprovalInbox(platformId: string): boolean {
  return platformId.startsWith(APPROVAL_INBOX_PREFIX);
}

/**
 * Convert a webchat user_id (e.g. `webchat:tailscale:foo@bar.com`) to the
 * approval-inbox platform_id (`approvals:tailscale:foo@bar.com`). Returns
 * null for non-webchat user_ids.
 */
export function approvalInboxForUser(userId: string): string | null {
  if (!userId.startsWith('webchat:')) return null;
  return `${APPROVAL_INBOX_PREFIX}${userId.slice('webchat:'.length)}`;
}

export interface PendingApprovalRow {
  approval_id: string;
  action: string;
  title: string;
  options_json: string;
  payload: string;
  created_at: string;
}

/**
 * Record an approval delivered to a webchat approval-inbox. Called from
 * the adapter's deliver() the moment we route an `ask_question` payload
 * to a `approvals:` platform_id. Idempotent — `INSERT OR IGNORE`.
 *
 * This is the skill-only alternative to having trunk's `requestApproval`
 * stamp `channel_type`/`platform_id` on the `pending_approvals` row at
 * insert time. We record the mapping here, on our side, and join against
 * it in the read path below.
 */
export async function recordWebchatApproval(approvalId: string, platformId: string): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO webchat_approvals_index (approval_id, platform_id, recorded_at)
       VALUES (?, ?, ?)`,
    approvalId,
    platformId,
    Date.now(),
  );
}

/**
 * Whether an approval was indexed against the given platform_id (approval
 * inbox). The respond endpoint uses this to authorize the responder. A single
 * approval may be indexed against multiple inboxes under fan-out delivery
 * (every eligible admin gets a card); any of those inboxes is a valid
 * responder. We can't authorize against `pending_approvals.channel_type/
 * platform_id` because trunk's `requestApproval` doesn't populate those.
 */
export async function isWebchatApprovalIndexedFor(approvalId: string, platformId: string): Promise<boolean> {
  const row = (await getDb().get(
    `SELECT 1 FROM webchat_approvals_index WHERE approval_id = ? AND platform_id = ? LIMIT 1`,
    approvalId,
    platformId,
  )) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Every inbox the given approval was indexed against, in insertion order. The
 * approval-resolved listener uses this to fan out a clear event to each admin
 * whose UI still shows the now-stale card.
 */
export async function getWebchatApprovalInboxes(approvalId: string): Promise<string[]> {
  const rows = (await getDb().all(
    `SELECT platform_id FROM webchat_approvals_index WHERE approval_id = ? ORDER BY recorded_at`,
    approvalId,
  )) as { platform_id: string }[];
  return rows.map((r) => r.platform_id);
}

/**
 * Drop every index row for an approval — called after it resolves so we don't
 * accumulate dead pointers. Safe to call on unknown ids.
 */
export async function deleteWebchatApprovalIndex(approvalId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_approvals_index WHERE approval_id = ?`, approvalId);
}

/** Inverse of `approvalInboxForUser`. Returns null for non-approval platform_ids. */
export function userForApprovalInbox(platformId: string): string | null {
  if (!platformId.startsWith(APPROVAL_INBOX_PREFIX)) return null;
  return `webchat:${platformId.slice(APPROVAL_INBOX_PREFIX.length)}`;
}

/**
 * Pending approvals destined for this webchat user's inbox.
 *
 * We can't filter on `pending_approvals.channel_type`/`platform_id`
 * because trunk's `requestApproval` doesn't populate those columns.
 * Instead we JOIN against the skill-owned `webchat_approvals_index`,
 * which webchat's deliver() populates on the way through.
 */
export async function getWebchatPendingApprovalsForUser(userId: string): Promise<PendingApprovalRow[]> {
  const platformId = approvalInboxForUser(userId);
  if (!platformId) return [];
  return (await getDb().all(
    `SELECT pa.approval_id, pa.action, pa.title, pa.options_json, pa.payload, pa.created_at
         FROM pending_approvals pa
         JOIN webchat_approvals_index wai ON wai.approval_id = pa.approval_id
        WHERE wai.platform_id = ?
          AND pa.status = 'pending'
        ORDER BY pa.created_at`,
    platformId,
  )) as PendingApprovalRow[];
}

export async function getAllWebchatRooms(): Promise<WebchatRoom[]> {
  const rows = (await getDb().all(`SELECT platform_id, name, created_at
         FROM messaging_groups
        WHERE channel_type = 'webchat'
          AND platform_id NOT LIKE 'approvals:%'
        ORDER BY created_at`)) as { platform_id: string; name: string | null; created_at: string }[];
  return rows.map(rowToRoom);
}

/**
 * Clean a user-supplied room name: strip control characters, collapse internal
 * whitespace, trim, and bound the length. Returns null when the result is empty
 * or longer than 80 chars — the caller rejects those. Keeps a room name from
 * becoming an invisible or unwieldy string in the sidebar.
 */
export function sanitizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 80) return null;
  return name;
}

export async function updateWebchatRoomName(id: string, name: string): Promise<void> {
  await getDb().run(`UPDATE messaging_groups SET name = ? WHERE channel_type='webchat' AND platform_id = ?`, name, id);
}

/**
 * Delete a webchat room and everything that hangs off it: messages (cascade
 * is gone with the FK, so explicit), the wiring rows, dangling agent_destinations
 * pointing at this room, the prime designation, and the messaging_group itself.
 * Idempotent — no-op if the room doesn't exist.
 */
export async function deleteWebchatRoom(id: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', id);
  if (!mg) return;
  const db = getDb();
  await db.run(`DELETE FROM webchat_messages WHERE room_id = ?`, id);
  await db.run(`DELETE FROM messaging_group_agents WHERE messaging_group_id = ?`, mg.id);
  await db.run(`DELETE FROM webchat_room_primes WHERE room_id = ?`, id);
  await db.run(`DELETE FROM webchat_user_room_hides WHERE room_id = ?`, id);
  await db.run(`DELETE FROM webchat_room_archives WHERE room_id = ?`, id);
  await db.run(`DELETE FROM webchat_room_reads WHERE room_id = ?`, id);
  await db.run(`DELETE FROM webchat_room_pins WHERE room_id = ?`, id);
  // Thread registry + per-thread read markers (guarded — the threads migration
  // may predate this room's data, but the tables exist once migrated).
  if (await hasTable(db, 'webchat_threads')) {
    await db.run(`DELETE FROM webchat_thread_reads WHERE room_id = ?`, id);
    await db.run(`DELETE FROM webchat_threads WHERE room_id = ?`, id);
  }
  if (await hasTable(db, 'webchat_thread_engaged')) {
    await db.run(`DELETE FROM webchat_thread_engaged WHERE room_id = ?`, id);
  }
  if (await hasTable(db, 'webchat_thread_sync')) {
    await db.run(`DELETE FROM webchat_thread_sync WHERE room_id = ?`, id);
  }
  // Drop any agent_destinations rows pointing at this room. target_id has no
  // FK so they wouldn't block, just rot. Guarded — a2a module may not be installed.
  if (await hasTable(db, 'agent_destinations')) {
    await db.run(`DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?`, mg.id);
  }
  // sessions.messaging_group_id has an FK to messaging_groups(id) and is NOT
  // NULL; any active session for this room would otherwise block the
  // deleteMessagingGroup below with an FK error. Running containers are
  // reaped by the host sweep on its next stale-heartbeat tick once the
  // session row is gone.
  await db.run(`DELETE FROM sessions WHERE messaging_group_id = ?`, mg.id);
  await deleteMessagingGroup(mg.id);
}

// ── Room ↔ Agent wirings ──

export interface WebchatRoomAgent {
  id: string;
  name: string;
  folder: string;
}

/**
 * List the agents currently wired to a webchat room. Empty array when the
 * room doesn't exist or has no wirings.
 */
export async function getAgentsForWebchatRoom(roomId: string): Promise<WebchatRoomAgent[]> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return [];
  return (await getDb().all(
    `SELECT ag.id, ag.name, ag.folder
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE mga.messaging_group_id = ?
       ORDER BY ag.name`,
    mg.id,
  )) as WebchatRoomAgent[];
}

/**
 * Remove a single (room, agent) wiring. Returns true if a row was deleted.
 * The agent_group itself is left intact — caller's responsibility to decide
 * whether the bare agent should also be deleted.
 *
 * Also drops the matching agent_destinations row so the agent's session
 * doesn't keep a destination pointing at a chat it can no longer write to.
 */
export async function unwireAgentFromWebchatRoom(roomId: string, agentGroupId: string): Promise<boolean> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return false;
  const db = getDb();
  const result = await db.run(
    `DELETE FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`,
    mg.id,
    agentGroupId,
  );
  if (await hasTable(db, 'agent_destinations')) {
    await db.run(
      `DELETE FROM agent_destinations
       WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?`,
      agentGroupId,
      mg.id,
    );
  }
  return result.changes > 0;
}

export interface AgentWebchatRoom {
  id: string; // room platform_id
  name: string;
  is_prime: boolean;
  /** Total agents wired to this room — lets the UI block removing the last one. */
  agent_count: number;
}

/**
 * List the webchat rooms a given agent is wired to. The agent-centric mirror of
 * getAgentsForWebchatRoom. Excludes approval inboxes (they aren't real rooms).
 * `is_prime` reflects whether this agent is the room's prime; `agent_count`
 * lets the UI enforce the same "can't unwire the last agent" guard the
 * room-detail panel uses.
 */
export async function getWebchatRoomsForAgent(agentGroupId: string): Promise<AgentWebchatRoom[]> {
  const rows = (await getDb().all(
    `SELECT mg.platform_id AS id, mg.name AS name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mga.agent_group_id = ? AND mg.channel_type = 'webchat'
       ORDER BY mg.name`,
    agentGroupId,
  )) as { id: string; name: string | null }[];
  // Promise.all, not an awaited .map: each row needs two DB reads now, and a
  // bare `await` inside the callback would make .map return promises rather
  // than values — `is_prime` would be a Promise compared to a string, which is
  // the always-false bug this is fixing, moved one level out.
  return Promise.all(
    rows
      .filter((r) => !isApprovalInbox(r.id))
      .map(async (r) => ({
        id: r.id,
        name: r.name ?? r.id,
        is_prime: (await getPrimeAgentForWebchatRoom(r.id)) === agentGroupId,
        agent_count: await countAgentsForWebchatRoom(r.id),
      })),
  );
}

/**
 * Look up the agent most likely to have produced an outbound message for
 * this room. Used by the webchat adapter's `deliver()` (and the reconcile
 * loop) to attach the actual agent's display name to stored messages
 * instead of the generic "Agent" placeholder.
 *
 * Heuristic:
 *   - Exactly one wired agent → that's the producer.
 *   - Multiple wired agents → pick the session whose `last_active` is
 *     most recent. The container's poll loop bumps `last_active` when it
 *     picks up an inbound message, immediately before writing the
 *     response; by the time `deliver()` fires, the responding session is
 *     reliably the most recently active one.
 *
 * Returns `null` if no wired agent is found (orphan room or stale state).
 * Falls back to the first wired agent if `last_active` is null on every
 * session (fresh container, no traffic yet).
 */
export async function findActiveAgentForWebchatRoom(roomId: string): Promise<WebchatRoomAgent | null> {
  const agents = await getAgentsForWebchatRoom(roomId);
  if (agents.length === 0) return null;
  if (agents.length === 1) return agents[0];
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return agents[0];
  // Filter to sessions whose container is actually running. Without this,
  // `writeSessionMessage` bumps `last_active` even for accumulate writes
  // (router stores message context without waking the container), so an
  // accumulate-only session can win the "most recent" race against the
  // session that actually produced the message. That mis-attributes the
  // sender name in the UI AND — load-bearing — feeds the wrong
  // `senderAgentGroupId` into the Pattern C loop-back, breaking router
  // self-exclusion. Container-status filtering identifies the actual
  // producer because only true wakes spawn/run a container.
  const row = (await getDb().get(
    `SELECT ag.id, ag.name, ag.folder
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       WHERE s.messaging_group_id = ?
         AND s.last_active IS NOT NULL
         AND s.container_status IN ('running', 'idle')
       ORDER BY s.last_active DESC
       LIMIT 1`,
    mg.id,
  )) as { id: string; name: string; folder: string } | undefined;
  return row ?? agents[0];
}

/**
 * Count agents wired to a webchat room. Used to enforce the "no empty rooms"
 * invariant when removing an agent.
 */
export async function countAgentsForWebchatRoom(roomId: string): Promise<number> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return 0;
  const row = (await getDb().get(
    `SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?`,
    mg.id,
  )) as { c: number };
  return row.c;
}

// ── Prime agent designation ──
//
// A room opts in to "prime" routing by designating one wired agent as prime.
// The prime answers every message that doesn't @-mention another wired agent
// (matched by folder name). Implementation rewrites
// messaging_group_agents.engage_pattern via recomputeEngagePatterns() in
// server.ts — no router-side change needed.
//
// Storage: webchat_room_primes(room_id PK, agent_group_id, created_at).
// Stale rows can exist transiently (an unwired prime, a deleted agent's row);
// the wiring-change paths in server.ts clear them when they notice.

export async function getPrimeAgentForWebchatRoom(roomId: string): Promise<string | null> {
  const row = (await getDb().get(`SELECT agent_group_id FROM webchat_room_primes WHERE room_id = ?`, roomId)) as
    | { agent_group_id: string }
    | undefined;
  return row?.agent_group_id ?? null;
}

export async function setPrimeAgentForWebchatRoom(roomId: string, agentGroupId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_primes (room_id, agent_group_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET agent_group_id = excluded.agent_group_id, created_at = excluded.created_at`,
    roomId,
    agentGroupId,
    Date.now(),
  );
}

export async function clearPrimeAgentForWebchatRoom(roomId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_room_primes WHERE room_id = ?`, roomId);
}

// ── Room settings (engage_default) ──

export type EngageDefault = 'mention-only';

/**
 * Per-room engagement default used when no prime is configured. Un-primed
 * wirings are rewritten by `recomputeEngagePatterns` to `\B@<folder>\b` —
 * agents reply only when explicitly @-mentioned.
 *
 * The legacy 'broadcast' mode (every wired agent answers every message) has
 * been retired: it is no longer offered, and any legacy stored 'broadcast'
 * value (or a room with no settings row) now reads as 'mention-only'.
 */
export function getRoomEngageDefault(_roomId: string): EngageDefault {
  return 'mention-only';
}

export async function setRoomEngageDefault(roomId: string, mode: EngageDefault): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_settings (room_id, engage_default, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET engage_default = excluded.engage_default, updated_at = excluded.updated_at`,
    roomId,
    mode,
    Date.now(),
  );
}

// ── UserCreds: per-room credential mode ──
export type CredentialMode = 'disabled' | 'optional' | 'required';

/** Secure by default: rooms with no settings row read as 'disabled'. */
export async function getRoomCredentialMode(roomId: string): Promise<CredentialMode> {
  const row = (await getDb().get(`SELECT credential_mode FROM webchat_room_settings WHERE room_id = ?`, roomId)) as
    | { credential_mode: CredentialMode }
    | undefined;
  return row?.credential_mode ?? 'disabled';
}

export async function setRoomCredentialMode(roomId: string, mode: CredentialMode): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_settings (room_id, engage_default, credential_mode, updated_at)
       VALUES (?, 'mention-only', ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET credential_mode = excluded.credential_mode, updated_at = excluded.updated_at`,
    roomId,
    mode,
    Date.now(),
  );
}

/**
 * UserCreds OAuth per-room toggle (subscription tokens). Off by default; orthogonal
 * to credential_mode. The column is absent until its migration runs, so read
 * defensively and treat any error/missing value as not-allowed.
 */
export async function getRoomOauthAllowed(roomId: string): Promise<boolean> {
  try {
    const row = (await getDb().get(`SELECT oauth_allowed FROM webchat_room_settings WHERE room_id = ?`, roomId)) as
      | { oauth_allowed: number }
      | undefined;
    return (row?.oauth_allowed ?? 0) === 1;
  } catch {
    return false;
  }
}

export async function setRoomOauthAllowed(roomId: string, allowed: boolean): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_settings (room_id, engage_default, oauth_allowed, updated_at)
       VALUES (?, 'mention-only', ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET oauth_allowed = excluded.oauth_allowed, updated_at = excluded.updated_at`,
    roomId,
    allowed ? 1 : 0,
    Date.now(),
  );
}

// ── UserCreds: workspace-wide credentials policy (singleton webchat_settings) ──
// Which user-credential TYPES the workspace accepts + the default room mode.
// Types live here (configured once) rather than per room.
export interface CredentialsConfig {
  defaultMode: CredentialMode;
  allowAnthropicKey: boolean;
  allowClaudeOauth: boolean;
  allowOpenaiKey: boolean;
  allowCodexOauth: boolean;
  /**
   * Grok has NO key variant, deliberately: xAI's CLI authenticates with a
   * subscription and there is no API-key path through it. A second flag would
   * be a control that can never be true.
   */
  allowGrokOauth: boolean;
}

const DEFAULT_CREDENTIALS_CONFIG: CredentialsConfig = {
  defaultMode: 'disabled',
  allowAnthropicKey: true,
  allowClaudeOauth: false,
  allowOpenaiKey: false,
  allowCodexOauth: false,
  allowGrokOauth: false,
};

/** Secure defaults if the singleton row is somehow missing or the table is absent. */
export async function getCredentialsConfig(): Promise<CredentialsConfig> {
  try {
    const row = (await getDb().get(`SELECT * FROM webchat_settings WHERE id = 1`)) as
      | {
          default_credential_mode: CredentialMode;
          allow_anthropic_key: number;
          allow_claude_oauth: number;
          allow_openai_key: number;
          allow_codex_oauth: number;
          allow_grok_oauth: number;
        }
      | undefined;
    if (!row) return { ...DEFAULT_CREDENTIALS_CONFIG };
    return {
      defaultMode: row.default_credential_mode ?? 'disabled',
      allowAnthropicKey: row.allow_anthropic_key === 1,
      allowClaudeOauth: row.allow_claude_oauth === 1,
      allowOpenaiKey: row.allow_openai_key === 1,
      allowCodexOauth: row.allow_codex_oauth === 1,
      // `?? 0` rather than a bare compare: a row written before this column
      // existed reads back undefined, and undefined === 1 is false anyway — but
      // saying so keeps the intent legible next to its siblings.
      allowGrokOauth: (row.allow_grok_oauth ?? 0) === 1,
    };
  } catch {
    return { ...DEFAULT_CREDENTIALS_CONFIG };
  }
}

export async function setCredentialsConfig(patch: Partial<CredentialsConfig>): Promise<void> {
  // Await before spreading: spreading a PROMISE contributes zero keys, so
  // `next` silently became just the patch and every other column went NULL.
  const next = { ...(await getCredentialsConfig()), ...patch };
  await getDb().run(
    `INSERT INTO webchat_settings
         (id, default_credential_mode, allow_anthropic_key, allow_claude_oauth, allow_openai_key, allow_codex_oauth, allow_grok_oauth, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         default_credential_mode = excluded.default_credential_mode,
         allow_anthropic_key     = excluded.allow_anthropic_key,
         allow_claude_oauth      = excluded.allow_claude_oauth,
         allow_openai_key        = excluded.allow_openai_key,
         allow_codex_oauth       = excluded.allow_codex_oauth,
         allow_grok_oauth        = excluded.allow_grok_oauth,
         updated_at              = excluded.updated_at`,
    next.defaultMode,
    next.allowAnthropicKey ? 1 : 0,
    next.allowClaudeOauth ? 1 : 0,
    next.allowOpenaiKey ? 1 : 0,
    next.allowCodexOauth ? 1 : 0,
    next.allowGrokOauth ? 1 : 0,
    Date.now(),
  );
}

// ── Settings-singleton column factory ──
// Every simple webchat_settings column is exposed as a (get, set) pair over the
// singleton row (id = 1). The getter tolerates a missing row/table/column and
// returns the decoded default (decode(undefined)); the setter seeds the
// NOT NULL credential columns from current config so the row can be created if
// it doesn't exist yet, then flips only its own column on conflict.

function settingsGetter<T>(column: string, decode: (value: unknown) => T): () => Promise<T> {
  return async () => {
    try {
      const row = (await getDb().get(`SELECT ${column} FROM webchat_settings WHERE id = 1`)) as
        | Record<string, unknown>
        | undefined;
      return decode(row?.[column]);
    } catch {
      return decode(undefined);
    }
  };
}

function settingsSetter<V>(column: string, encode: (value: V) => string | number | null): (value: V) => void {
  return async (value) => {
    const cfg = await getCredentialsConfig();
    await getDb().run(
      `INSERT INTO webchat_settings
           (id, default_credential_mode, allow_anthropic_key, allow_claude_oauth, allow_openai_key, allow_codex_oauth, ${column}, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ${column} = excluded.${column},
           updated_at = excluded.updated_at`,
      cfg.defaultMode,
      cfg.allowAnthropicKey ? 1 : 0,
      cfg.allowClaudeOauth ? 1 : 0,
      cfg.allowOpenaiKey ? 1 : 0,
      cfg.allowCodexOauth ? 1 : 0,
      encode(value),
      Date.now(),
    );
  };
}

const decodeBool = (v: unknown): boolean => v === 1;
const encodeBool = (v: boolean): number => (v ? 1 : 0);
const decodeNullableString = (v: unknown): string | null => (v as string | null) ?? null;
const encodeNullableString = (v: string | null): string | null => v;

/**
 * First-run wizard state (webchat_settings singleton). Defaults to `false`
 * (not onboarded) if the row/table/column is missing, so a fresh install shows
 * the wizard rather than silently skipping it.
 */
export const getOnboardingComplete = settingsGetter('onboarding_complete', decodeBool);
export const setOnboardingComplete = settingsSetter('onboarding_complete', encodeBool);

// Bearer-token opt-out: true = WEBCHAT_TOKEN is ignored by auth.ts (the owner
// retired it in favour of Tailscale/SSO). Default false so the seeded token
// keeps working until explicitly disabled. See moduleWebchatBearerAuth.
export const getBearerTokenDisabled = settingsGetter('bearer_token_disabled', decodeBool);
export const setBearerTokenDisabled = settingsSetter('bearer_token_disabled', encodeBool);

// MCP + skills-marketplace opt-out: true = both features are turned off (tabs
// hidden + endpoints 403). Default false (enabled). See moduleWebchatMarketplaceToggle.
export const getMarketplaceDisabled = settingsGetter('marketplace_disabled', decodeBool);
export const setMarketplaceDisabled = settingsSetter('marketplace_disabled', encodeBool);

// Fleet credential isolation. NULL = defer to CREDENTIAL_ISOLATION in .env;
// true/false = an explicit choice in Settings, which wins. Nullable so "never
// chosen" stays distinct from "chosen off" — see moduleWebchatCredentialIsolation.
const decodeNullableBool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
const encodeNullableBool = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
export const getCredentialIsolation = settingsGetter('credential_isolation', decodeNullableBool);
export const setCredentialIsolation = settingsSetter('credential_isolation', encodeNullableBool);

/**
 * Voice-dictation cleanup model (webchat_settings singleton). NULL = no cleanup —
 * dictation delivers the raw Whisper transcript. Missing row/column reads as NULL
 * so the feature degrades to raw rather than erroring.
 */
export const getSttCleanupModelId = settingsGetter('stt_cleanup_model_id', decodeNullableString);
export const setSttCleanupModelId = settingsSetter('stt_cleanup_model_id', encodeNullableString);

/**
 * Custom cleanup prompt (webchat_settings singleton). NULL = the built-in
 * default in stt.ts. Same degrade-to-default read as the cleanup model;
 * blank/whitespace-only values also read as NULL.
 */
export const getSttCleanupPrompt = settingsGetter('stt_cleanup_prompt', (v) =>
  typeof v === 'string' && v.trim() ? v : null,
);
export const setSttCleanupPrompt = settingsSetter('stt_cleanup_prompt', encodeNullableString);

// Workspace-level Read aloud: true = every authed user gets the speaker
// control on agent replies. Owner-set from Settings → Features (was a
// per-device switch — confusing in shared rooms). See moduleWebchatReadAloud.
export const getReadAloudEnabled = settingsGetter('read_aloud_enabled', decodeBool);
export const setReadAloudEnabled = settingsSetter('read_aloud_enabled', encodeBool);

/**
 * Approval pre-judge model (webchat_settings singleton). The roster model
 * (webchat_models.id, ollama / openai-compatible kind) that triages opted-in
 * approval holds before a human sees them. NULL = feature OFF (the default).
 * See src/modules/approvals/prejudge.ts and docs/webchat/approval-prejudge.md.
 */
export const getApprovalPrejudgeModelId = settingsGetter('approval_prejudge_model_id', decodeNullableString);
export const setApprovalPrejudgeModelId = settingsSetter('approval_prejudge_model_id', encodeNullableString);

/**
 * Approval actions opted in to the pre-judge (JSON array of action names).
 * DEFAULT EMPTY — even with a model configured, nothing is pre-judged until
 * an action is explicitly listed here. Malformed values read as empty (off).
 */
export const getApprovalPrejudgeActions = settingsGetter('approval_prejudge_actions', (v): string[] => {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
});
export const setApprovalPrejudgeActions = settingsSetter('approval_prejudge_actions', (v: string[]) =>
  JSON.stringify(v),
);

// One-shot "first Tailscale login becomes owner" arm flag (wizard opt-in).
// true = the next tailscale identity to authenticate is granted owner, then the
// flag clears. See moduleWebchatTailscaleOwner + auth.ts finalize().
// Audit syslog forwarder target URL ('' = off). See audit-syslog.ts.
const decodeStr = (v: unknown): string => (typeof v === 'string' ? v : '');
export const getAuditSyslogTarget = settingsGetter('audit_syslog_target', decodeStr);
export const setAuditSyslogTarget = settingsSetter('audit_syslog_target', (v: string) => v || null);

export const getPromoteFirstTailscaleOwner = settingsGetter('promote_first_tailscale_owner', decodeBool);
export const setPromoteFirstTailscaleOwner = settingsSetter('promote_first_tailscale_owner', encodeBool);

// Per-room mode override: NULL = inherit the global default.
export type RoomModeOverride = CredentialMode | null;

export async function getRoomModeOverride(roomId: string): Promise<RoomModeOverride> {
  try {
    const row = (await getDb().get(
      `SELECT credential_mode_override FROM webchat_room_settings WHERE room_id = ?`,
      roomId,
    )) as { credential_mode_override: CredentialMode | null } | undefined;
    return row?.credential_mode_override ?? null;
  } catch {
    return null;
  }
}

export async function setRoomModeOverride(roomId: string, mode: RoomModeOverride): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_settings (room_id, engage_default, credential_mode_override, updated_at)
       VALUES (?, 'mention-only', ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET credential_mode_override = excluded.credential_mode_override, updated_at = excluded.updated_at`,
    roomId,
    mode,
    Date.now(),
  );
}

/** The room's effective credential mode: its own override, else the global default. */
export async function getEffectiveRoomMode(roomId: string): Promise<CredentialMode> {
  return (await getRoomModeOverride(roomId)) ?? (await getCredentialsConfig()).defaultMode;
}

// ── Messages ──

function rowToMessage(row: WebchatMessageRow): WebchatMessage {
  return {
    ...row,
    file_meta: row.file_meta ? (JSON.parse(row.file_meta) as FileMeta) : null,
  };
}

export async function storeWebchatMessage(
  roomId: string,
  sender: string,
  senderType: string,
  content: string,
  threadId = 'main',
): Promise<WebchatMessage> {
  const msg: WebchatMessage = {
    id: randomUUID(),
    room_id: roomId,
    thread_id: threadId,
    sender,
    sender_type: senderType,
    content,
    message_type: 'text',
    file_meta: null,
    created_at: Date.now(),
  };
  await getDb().run(
    `INSERT INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return msg;
}

/**
 * Store an ACTIONABLE approval card in the agent's room (in addition to the
 * per-approver inboxes). `message_type='approval'`; content carries the
 * ask_question payload + the eligible `approvers` (the client shows the
 * approve/deny buttons only to those users). Keyed by a deterministic id so
 * re-firing is idempotent and the card can be updated on resolution.
 */
export async function storeWebchatApprovalCard(
  roomId: string,
  sender: string,
  payload: {
    questionId: string;
    title: string;
    question: string;
    options: unknown;
    action: string;
    approvers: string[];
    /** How the pre-judge triaged this request; omitted on legacy callers. */
    triage?: unknown;
  },
  threadId = 'main',
): Promise<WebchatMessage> {
  const msg: WebchatMessage = {
    id: `appr-card-${payload.questionId}`,
    room_id: roomId,
    thread_id: threadId,
    sender,
    sender_type: 'agent',
    content: JSON.stringify(payload),
    message_type: 'approval',
    file_meta: null,
    created_at: Date.now(),
  };
  await getDb().run(
    `INSERT OR REPLACE INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return msg;
}

// ── Approval triage (pre-judge description shown on the card) ────────────────

/** One approval's triage record. Mirrors PrejudgeResult, minus the verdict. */
export interface ApprovalTriage {
  tier: 'unscreened' | 'heuristic' | 'model' | 'unavailable';
  reason: string;
  flags: string[];
  heuristicFlags: string[];
  reversible: 'yes' | 'no' | 'unknown';
}

/**
 * Record what the pre-judge concluded, keyed by approval id. Written once as
 * the hold is created; INSERT OR REPLACE so a retried hold is idempotent.
 */
export async function storeApprovalTriage(approvalId: string, triage: ApprovalTriage): Promise<void> {
  await getDb().run(
    `INSERT OR REPLACE INTO webchat_approval_triage
         (approval_id, tier, reason, flags, heuristic_flags, reversible, created_at)
       VALUES (@approval_id, @tier, @reason, @flags, @heuristic_flags, @reversible, @created_at)`,
    {
      approval_id: approvalId,
      tier: triage.tier,
      reason: triage.reason,
      flags: JSON.stringify(triage.flags),
      heuristic_flags: JSON.stringify(triage.heuristicFlags),
      reversible: triage.reversible,
      created_at: Date.now(),
    },
  );
}

/**
 * Read a triage record. Returns undefined for approvals raised before this
 * existed — the card then renders nothing rather than implying it was screened.
 */
export async function getApprovalTriage(approvalId: string): Promise<ApprovalTriage | undefined> {
  const row = (await getDb().get(
    `SELECT tier, reason, flags, heuristic_flags, reversible FROM webchat_approval_triage WHERE approval_id = ?`,
    approvalId,
  )) as { tier: string; reason: string; flags: string; heuristic_flags: string; reversible: string } | undefined;
  if (!row) return undefined;
  const parseList = (raw: string): string[] => {
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    tier: row.tier as ApprovalTriage['tier'],
    reason: row.reason,
    flags: parseList(row.flags),
    heuristicFlags: parseList(row.heuristic_flags),
    reversible: row.reversible as ApprovalTriage['reversible'],
  };
}

/**
 * An actionable "proposed skill" card in the agent's own room (learning loop).
 * Same shape as the approval card: a persisted row the client renders with
 * Keep/Discard, flipped to resolved once handled.
 */
export async function storeWebchatSkillDraftCard(
  roomId: string,
  sender: string,
  payload: {
    draftId: string;
    skillName: string;
    description: string;
    kind: 'create' | 'patch';
    targetSkill: string | null;
    agentGroupId: string;
    agentName: string;
  },
  threadId = 'main',
): Promise<WebchatMessage> {
  const msg: WebchatMessage = {
    id: `skill-draft-card-${payload.draftId}`,
    room_id: roomId,
    thread_id: threadId,
    sender,
    sender_type: 'agent',
    content: JSON.stringify({ ...payload, status: 'pending' }),
    message_type: 'skill_draft',
    file_meta: null,
    created_at: Date.now(),
  };
  await getDb().run(
    `INSERT OR REPLACE INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return msg;
}

/**
 * Where a draft's in-room card stands: how many messages have arrived in its
 * room since it was posted. The expiry sweep uses this as the server-side proxy
 * for "the card is no longer visible in the chat" — a card with dozens of newer
 * messages after it has scrolled away for anyone opening the room. Null when no
 * card exists at all (a non-webchat draft, or one from before cards shipped).
 */
export async function skillDraftCardPosition(
  draftId: string,
): Promise<{ roomId: string; newerMessages: number } | null> {
  const id = `skill-draft-card-${draftId}`;
  const row = (await getDb().get('SELECT room_id, created_at FROM webchat_messages WHERE id = ?', id)) as
    | { room_id: string; created_at: number }
    | undefined;
  if (!row) return null;
  const n = (await getDb().get(
    'SELECT count(*) AS n FROM webchat_messages WHERE room_id = ? AND created_at > ? AND id != ?',
    row.room_id,
    row.created_at,
    id,
  )) as { n: number };
  return { roomId: row.room_id, newerMessages: n.n };
}

/** Flip a proposed-skill card to resolved (kept | discarded). No-op if absent. */
export async function markRoomSkillDraftResolved(
  draftId: string,
  outcome: 'kept' | 'discarded',
  resolvedBy: string,
): Promise<{ roomId: string; message: WebchatMessage } | null> {
  const id = `skill-draft-card-${draftId}`;
  const row = (await getDb().get('SELECT * FROM webchat_messages WHERE id = ?', id)) as WebchatMessage | undefined;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    /* keep whatever we can */
  }
  const content = JSON.stringify({ ...payload, status: outcome, resolvedBy });
  await getDb().run('UPDATE webchat_messages SET content = ? WHERE id = ?', content, id);
  return { roomId: row.room_id, message: { ...row, content } };
}

/**
 * Skill-draft cards as a read-only history feed (learning timeline). The card
 * rows are the ONLY durable record of a draft's outcome — resolveSkillDraft
 * deletes the skill_drafts row, but the in-room card persists with
 * `status` ('pending' | 'kept' | 'discarded') and `resolvedBy` folded into its
 * content JSON. `createdAt` is the PROPOSAL time; resolution time is not
 * stored anywhere, so timeline consumers date resolutions by proposal.
 */
export interface SkillDraftCardRow {
  draftId: string;
  roomId: string;
  createdAt: number;
  status: 'pending' | 'kept' | 'discarded';
  resolvedBy: string | null;
  skillName: string;
  description: string;
  kind: 'create' | 'patch';
  targetSkill: string | null;
  agentGroupId: string;
  agentName: string;
}

export async function listSkillDraftCards(before?: number, limit = 200): Promise<SkillDraftCardRow[]> {
  const rows = (await getDb().all(
    `SELECT room_id, content, created_at FROM webchat_messages
       WHERE message_type = 'skill_draft' AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
    before ?? Number.MAX_SAFE_INTEGER,
    limit,
  )) as Array<{ room_id: string; content: string; created_at: number }>;
  const out: SkillDraftCardRow[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.content) as Record<string, unknown>;
      if (typeof p.draftId !== 'string' || typeof p.agentGroupId !== 'string') continue;
      out.push({
        draftId: p.draftId,
        roomId: r.room_id,
        createdAt: r.created_at,
        status: p.status === 'kept' || p.status === 'discarded' ? p.status : 'pending',
        resolvedBy: typeof p.resolvedBy === 'string' ? p.resolvedBy : null,
        skillName: typeof p.skillName === 'string' ? p.skillName : '',
        description: typeof p.description === 'string' ? p.description : '',
        kind: p.kind === 'patch' ? 'patch' : 'create',
        targetSkill: typeof p.targetSkill === 'string' ? p.targetSkill : null,
        agentGroupId: p.agentGroupId,
        agentName: typeof p.agentName === 'string' ? p.agentName : p.agentGroupId,
      });
    } catch {
      /* unparseable card — skip */
    }
  }
  return out;
}

/**
 * Flip a room approval card to resolved (so reload renders it non-actionable).
 * No-op if the card row doesn't exist. The live clear is a broadcast handled
 * by the resolved-listener; this keeps the persisted row consistent.
 */
export async function markRoomApprovalResolved(approvalId: string, resolvedBy: string): Promise<void> {
  const id = `appr-card-${approvalId}`;
  const row = (await getDb().get(`SELECT content FROM webchat_messages WHERE id = ?`, id)) as
    | { content: string }
    | undefined;
  if (!row) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  payload.resolvedBy = resolvedBy;
  await getDb().run(
    `UPDATE webchat_messages SET message_type = 'approval_resolved', content = ? WHERE id = ?`,
    JSON.stringify(payload),
    id,
  );
}

/**
 * Store an agent↔agent (a2a) message surfaced into a room both agents share —
 * a read-only side-channel copy so humans can watch agents talk. Marked with
 * `sender_type` + `message_type` = 'a2a' (so it never trips agent-message UI
 * like thinking-bubble removal), with the target encoded in `content` as
 * `{to, text}` — the client renders a "from → to" label. `sender` is the
 * source agent's display name; no users-table row is created (display only).
 */
export async function storeWebchatA2aMessage(
  roomId: string,
  fromName: string,
  toName: string,
  text: string,
  threadId = 'main',
): Promise<WebchatMessage> {
  const msg: WebchatMessage = {
    id: randomUUID(),
    room_id: roomId,
    thread_id: threadId,
    sender: fromName,
    sender_type: 'a2a',
    content: JSON.stringify({ to: toName, text }),
    message_type: 'a2a',
    file_meta: null,
    created_at: Date.now(),
  };
  await getDb().run(
    `INSERT INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return msg;
}

/**
 * Webchat rooms that BOTH agents are wired to (the side-channel surfacing
 * target). Excludes approval inboxes. Returns the room platform_id (the
 * `room_id` used by webchat_messages / broadcast) and display name.
 */
export async function getSharedWebchatRooms(
  agentGroupIdA: string,
  agentGroupIdB: string,
): Promise<{ id: string; name: string }[]> {
  const rows = (await getDb().all(
    `SELECT mg.platform_id AS id, mg.name AS name
       FROM messaging_groups mg
       JOIN messaging_group_agents a ON a.messaging_group_id = mg.id AND a.agent_group_id = ?
       JOIN messaging_group_agents b ON b.messaging_group_id = mg.id AND b.agent_group_id = ?
       WHERE mg.channel_type = 'webchat'
       ORDER BY mg.name`,
    agentGroupIdA,
    agentGroupIdB,
  )) as { id: string; name: string | null }[];
  return rows.filter((r) => !isApprovalInbox(r.id)).map((r) => ({ id: r.id, name: r.name ?? r.id }));
}

export async function storeWebchatFileMessage(
  roomId: string,
  sender: string,
  senderType: string,
  caption: string,
  fileMeta: FileMeta,
  threadId = 'main',
): Promise<WebchatMessage> {
  const msg: WebchatMessage = {
    id: randomUUID(),
    room_id: roomId,
    thread_id: threadId,
    sender,
    sender_type: senderType,
    content: caption,
    message_type: 'file',
    file_meta: fileMeta,
    created_at: Date.now(),
  };
  await getDb().run(
    `INSERT INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: JSON.stringify(fileMeta) },
  );
  return msg;
}

export async function getWebchatMessages(roomId: string, limit = 200, threadId?: string): Promise<WebchatMessage[]> {
  const rows = (
    threadId === undefined
      ? await getDb().all(
          `SELECT * FROM webchat_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
          roomId,
          limit,
        )
      : await getDb().all(
          `SELECT * FROM webchat_messages WHERE room_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?`,
          roomId,
          threadId,
          limit,
        )
  ) as WebchatMessageRow[];
  return rows.reverse().map(rowToMessage);
}

/**
 * Delete a message — only the original sender (matched on `sender` text)
 * may delete their own, AND only within the room they're connected to.
 * The room scope prevents a client connected to room A from deleting a
 * message in room B (especially relevant in shared-bearer auth where
 * every client carries the same `webchat:owner` identity). Returns true
 * on success.
 */
export async function deleteWebchatMessage(
  messageId: string,
  requesterIdentity: string,
  roomId: string,
): Promise<boolean> {
  const result = await getDb().run(
    `DELETE FROM webchat_messages WHERE id = ? AND sender = ? AND room_id = ?`,
    messageId,
    requesterIdentity,
    roomId,
  );
  return result.changes > 0;
}

export async function getWebchatMessagesAfterId(
  roomId: string,
  afterId: string,
  limit = 500,
  threadId?: string,
): Promise<WebchatMessage[]> {
  const anchor = (await getDb().get(`SELECT created_at FROM webchat_messages WHERE id = ?`, afterId)) as
    | { created_at: number }
    | undefined;
  if (!anchor) return [];
  const rows = (
    threadId === undefined
      ? await getDb().all(
          `SELECT * FROM webchat_messages
             WHERE room_id = ? AND created_at > ?
             ORDER BY created_at LIMIT ?`,
          roomId,
          anchor.created_at,
          limit,
        )
      : await getDb().all(
          `SELECT * FROM webchat_messages
             WHERE room_id = ? AND thread_id = ? AND created_at > ?
             ORDER BY created_at LIMIT ?`,
          roomId,
          threadId,
          anchor.created_at,
          limit,
        )
  ) as WebchatMessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Older-message pagination (scroll-back). Returns up to `limit` messages
 * immediately BEFORE `beforeId`, oldest-to-newest so the client can prepend
 * them as one ascending block. An empty/short result means the start of
 * history has been reached. Mirrors getWebchatMessagesAfterId's created_at
 * anchoring.
 */
export interface WebchatSearchResult {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  message_type: string;
  snippet: string;
  created_at: number;
}

/**
 * Full-text search (FTS5) over message content, scoped to `roomIds` (the
 * caller's accessible rooms — never search rooms the user can't see). Returns
 * relevance-ranked hits with a highlighted snippet.
 *
 * The MATCH string is built ONLY from extracted word tokens, each prefix-matched
 * and AND-ed — so no user-supplied FTS5 operators/quotes reach the parser (which
 * would otherwise throw a syntax error on input like `"` or `AND`).
 */
export async function searchWebchatMessages(
  roomIds: string[],
  rawQuery: string,
  limit = 50,
): Promise<WebchatSearchResult[]> {
  if (roomIds.length === 0) return [];
  const tokens = (rawQuery.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  if (tokens.length === 0) return [];
  const match = tokens.map((t) => `${t}*`).join(' ');
  const placeholders = roomIds.map(() => '?').join(',');
  return (await getDb().all(
    `SELECT m.id, m.room_id, m.sender, m.sender_type, m.message_type,
              snippet(webchat_messages_fts, 0, '«', '»', '…', 12) AS snippet,
              m.created_at
       FROM webchat_messages_fts f
       JOIN webchat_messages m ON m.rowid = f.rowid
       WHERE webchat_messages_fts MATCH ?
         AND m.room_id IN (${placeholders})
         AND m.message_type NOT IN ('approval', 'approval_resolved')
       ORDER BY rank
       LIMIT ?`,
    match,
    ...roomIds,
    limit,
  )) as WebchatSearchResult[];
}

export async function getWebchatMessagesBeforeId(
  roomId: string,
  beforeId: string,
  limit = 50,
  threadId?: string,
): Promise<WebchatMessage[]> {
  const anchor = (await getDb().get(`SELECT created_at FROM webchat_messages WHERE id = ?`, beforeId)) as
    | { created_at: number }
    | undefined;
  if (!anchor) return [];
  const rows = (
    threadId === undefined
      ? await getDb().all(
          `SELECT * FROM webchat_messages
             WHERE room_id = ? AND created_at < ?
             ORDER BY created_at DESC LIMIT ?`,
          roomId,
          anchor.created_at,
          limit,
        )
      : await getDb().all(
          `SELECT * FROM webchat_messages
             WHERE room_id = ? AND thread_id = ? AND created_at < ?
             ORDER BY created_at DESC LIMIT ?`,
          roomId,
          threadId,
          anchor.created_at,
          limit,
        )
  ) as WebchatMessageRow[];
  return rows.reverse().map(rowToMessage);
}

// ── Threads ──
// A webchat thread maps to an agent session (thread_id = session.thread_id), so
// each thread is an isolated conversation. 'main' is every room's implicit
// default thread. See docs/webchat/threads.md.

export const MAIN_THREAD = 'main';

/**
 * Map a stored/UI thread id to the SESSION key. 'main' (and absent) key the
 * legacy null-thread session, so a room that never uses threads keeps its exact
 * existing session/continuity; named threads key their own session. This is
 * what makes turning threads on a no-op until a real thread is used.
 */
export function threadToSessionKey(threadId: string | null | undefined): string | null {
  return !threadId || threadId === MAIN_THREAD ? null : threadId;
}

/**
 * Inverse: a session's thread_id → the stored/UI thread ('main' when absent).
 *
 * This is only a true inverse of threadToSessionKey while a session's thread_id
 * is either null or a real UI thread. The per-member credential override breaks
 * that: it re-keys the session by USER, so thread_id becomes a user id. Passing
 * that straight through stored agent replies under a thread_id with no
 * webchat_threads row — a phantom thread the UI cannot list or open, so the
 * replies simply vanished. Twelve of one member's replies were lost that way.
 *
 * With a roomId we can tell the two apart: a key that names no thread in this
 * room is a session key, and its replies belong in main. Without one the old
 * pass-through stands, so callers that never see per-member sessions are
 * unaffected.
 *
 * NOTE: a per-member session is keyed by user, not by (user, thread), so it
 * cannot say WHICH thread a reply belongs to — main is the only safe answer.
 * Per-member rooms therefore collapse threads for that member. That is a
 * property of the credential feature, not of this function.
 */
export async function sessionKeyToThread(threadId: string | null | undefined, roomId?: string): Promise<string> {
  if (!threadId) return MAIN_THREAD;
  // A per-member session key is `<userId>::<thread>` and therefore KNOWS its
  // thread — decode it rather than guessing. This supersedes the roomId
  // heuristic below for those keys: the heuristic could only answer "not a
  // real thread → main", which put a topic thread's replies in the room.
  //
  // Shape mirrors memberSessionKey/memberThreadFromKey in
  // modules/user-credentials/identity.ts (the source of truth). Parsed here
  // rather than imported to keep the channel free of a module dependency;
  // threads.test.ts cross-checks the two so they cannot drift apart.
  const sep = threadId.lastIndexOf('::');
  if (sep > 0) return threadId.slice(sep + 2);
  // Legacy bare-user key (pre-composite) carries no thread at all, so main is
  // the only defensible answer.
  // Await BEFORE negating: `!promise` is always false, which re-opened the
  // phantom-thread reply loss this function exists to prevent.
  if (roomId && !(await getWebchatThread(roomId, threadId))) return MAIN_THREAD;
  return threadId;
}

export interface WebchatThread {
  room_id: string;
  thread_id: string;
  title: string;
  kind: 'main' | 'agent' | 'topic';
  created_at: number;
  updated_at: number;
}

/** Ensure a thread row exists; idempotent (never clobbers an existing title).
 * Returns the thread_id. Used for lazy 'main' and per-agent lanes. */
export async function ensureThread(
  roomId: string,
  threadId: string,
  title: string,
  kind: WebchatThread['kind'],
): Promise<string> {
  const now = Date.now();
  await getDb().run(
    `INSERT INTO webchat_threads (room_id, thread_id, title, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, thread_id) DO NOTHING`,
    roomId,
    threadId,
    title,
    kind,
    now,
    now,
  );
  return threadId;
}

/** Ensure the room's 'main' thread exists. */
export async function ensureMainThread(roomId: string): Promise<string> {
  return await ensureThread(roomId, MAIN_THREAD, 'Main', 'main');
}

/** Ensure a per-agent lane ('agent:<folder>'); returns its thread_id. */
export async function ensureAgentThread(roomId: string, folder: string, displayName: string): Promise<string> {
  return await ensureThread(roomId, `agent:${folder}`, displayName, 'agent');
}

/** Clean a user-supplied thread title: strip control chars, collapse
 * whitespace, trim, bound to 80. Returns null when empty/too-long. */
export function sanitizeThreadTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return !t || t.length > 80 ? null : t;
}

/** Create a manual topic thread (uuid). Returns the new thread. */
export async function createWebchatThread(roomId: string, title: string): Promise<WebchatThread> {
  const now = Date.now();
  const thread: WebchatThread = {
    room_id: roomId,
    thread_id: randomUUID(),
    title,
    kind: 'topic',
    created_at: now,
    updated_at: now,
  };
  await getDb().run(
    `INSERT INTO webchat_threads (room_id, thread_id, title, kind, created_at, updated_at)
       VALUES (@room_id, @thread_id, @title, @kind, @created_at, @updated_at)`,
    thread,
  );
  return thread;
}

/** All threads in a room, 'main' first, then by most-recent activity. */
export async function listWebchatThreads(roomId: string): Promise<WebchatThread[]> {
  return (await getDb().all(
    `SELECT * FROM webchat_threads WHERE room_id = ?
       ORDER BY (kind = 'main') DESC, updated_at DESC`,
    roomId,
  )) as WebchatThread[];
}

/**
 * Per-room count of TOPIC threads (excludes the implicit 'main'/'agent' rows),
 * keyed by room_id. Powers the sidebar's "this room has N threads" chevron so
 * the client knows which rooms to offer an expander for — computed once per
 * rooms broadcast rather than one query per room.
 */
export async function getTopicThreadCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!(await hasTable(getDb(), 'webchat_threads'))) return counts;
  const rows = (await getDb().all(
    `SELECT room_id, COUNT(*) AS n FROM webchat_threads WHERE kind = 'topic' GROUP BY room_id`,
  )) as Array<{ room_id: string; n: number }>;
  for (const r of rows) counts.set(r.room_id, r.n);
  return counts;
}

export async function getWebchatThread(roomId: string, threadId: string): Promise<WebchatThread | undefined> {
  return (await getDb().get(`SELECT * FROM webchat_threads WHERE room_id = ? AND thread_id = ?`, roomId, threadId)) as
    | WebchatThread
    | undefined;
}

/**
 * Bound a client-supplied thread_id to one that is allowed to route, so an
 * arbitrary id can't lazily spawn unbounded per-thread sessions/containers (the
 * spawn-amplification vector). Only three sources are honored; anything else
 * falls back to 'main':
 *   • 'main' / absent — the room's default thread.
 *   • 'agent:<folder>' — an auto-spawn lane for a WIRED agent only; created on
 *     first use (bounded by the room's agent count).
 *   • an already-existing topic thread (created via POST /threads).
 * An unknown topic id is NOT lazily created — topic threads must exist before
 * they route. Shared by the WS send path (ws.ts) and the file-upload handlers
 * (files.ts) so both enforce the identical bound.
 */
export async function resolveBoundedThread(roomId: string, requested: unknown): Promise<string> {
  const want = typeof requested === 'string' && requested ? requested : MAIN_THREAD;
  if (want === MAIN_THREAD) return MAIN_THREAD;
  if (want.startsWith('agent:')) {
    const folder = want.slice('agent:'.length);
    const agent = (await getAgentsForWebchatRoom(roomId)).find((a) => a.folder === folder);
    if (agent) {
      await ensureAgentThread(roomId, folder, agent.name ?? folder);
      return want;
    }
    return MAIN_THREAD; // unknown agent folder → main (don't spawn)
  }
  return (await getWebchatThread(roomId, want)) ? want : MAIN_THREAD; // unknown topic id → main (no lazy create)
}

export async function renameWebchatThread(roomId: string, threadId: string, title: string): Promise<void> {
  await getDb().run(
    `UPDATE webchat_threads SET title = ?, updated_at = ? WHERE room_id = ? AND thread_id = ?`,
    title,
    Date.now(),
    roomId,
    threadId,
  );
}

/** Delete a thread + its messages + its read markers. 'main' is not deletable
 * (the caller enforces; this guards too). Session teardown is the caller's job. */
export async function deleteWebchatThread(roomId: string, threadId: string): Promise<void> {
  if (threadId === MAIN_THREAD) return;
  const db = getDb();
  await db.run(`DELETE FROM webchat_messages WHERE room_id = ? AND thread_id = ?`, roomId, threadId);
  await db.run(`DELETE FROM webchat_thread_reads WHERE room_id = ? AND thread_id = ?`, roomId, threadId);
  await db.run(`DELETE FROM webchat_thread_engaged WHERE room_id = ? AND thread_id = ?`, roomId, threadId);
  await db.run(`DELETE FROM webchat_thread_sync WHERE room_id = ? AND thread_id = ?`, roomId, threadId);
  await db.run(`DELETE FROM webchat_threads WHERE room_id = ? AND thread_id = ?`, roomId, threadId);
}

// ── Thread context sync (pull / push) ──
// High-water marks + verbatim copy helpers for moving conversation between a
// thread and main. See docs/webchat/thread-context-sync.md.

export interface ThreadSyncMarks {
  pulled: number; // newest main created_at pulled into this thread
  pushed: number; // newest native thread created_at pushed up to main
}

/** Per-thread sync high-water marks (default 0 when no row yet). */
export async function getThreadSyncMarks(roomId: string, threadId: string): Promise<ThreadSyncMarks> {
  const row = (await getDb().get(
    `SELECT last_pulled_src_ts AS pulled, last_pushed_src_ts AS pushed
       FROM webchat_thread_sync WHERE room_id = ? AND thread_id = ?`,
    roomId,
    threadId,
  )) as ThreadSyncMarks | undefined;
  return row ?? { pulled: 0, pushed: 0 };
}

/** Advance a sync high-water mark (monotonic: never moves backwards). */
export async function setThreadSyncMark(
  roomId: string,
  threadId: string,
  dir: 'pulled' | 'pushed',
  ts: number,
): Promise<void> {
  const col = dir === 'pulled' ? 'last_pulled_src_ts' : 'last_pushed_src_ts';
  await getDb().run(
    `INSERT INTO webchat_thread_sync (room_id, thread_id, ${col}) VALUES (?, ?, ?)
       ON CONFLICT(room_id, thread_id) DO UPDATE SET ${col} = MAX(${col}, excluded.${col})`,
    roomId,
    threadId,
    ts,
  );
}

/**
 * Native (origin IS NULL) messages in (room, srcThread) created after `sinceTs`,
 * chronological — the delta a pull/push copies. Dividers (context-divider) and
 * already-copied rows are excluded. `freshLimit` caps the first sync (sinceTs=0)
 * so an initial pull can't drag in an enormous backlog; <=0 means no cap.
 */
export async function getSyncDelta(
  roomId: string,
  srcThreadId: string,
  sinceTs: number,
  freshLimit = 0,
): Promise<WebchatMessage[]> {
  const db = getDb();
  if (freshLimit > 0 && sinceTs === 0) {
    const rows = (await db.all(
      `SELECT * FROM webchat_messages
         WHERE room_id = ? AND thread_id = ? AND origin IS NULL AND message_type != 'context-divider'
         ORDER BY created_at DESC LIMIT ?`,
      roomId,
      srcThreadId,
      freshLimit,
    )) as WebchatMessage[];
    return rows.reverse();
  }
  return (await db.all(
    `SELECT * FROM webchat_messages
       WHERE room_id = ? AND thread_id = ? AND origin IS NULL AND message_type != 'context-divider' AND created_at > ?
       ORDER BY created_at ASC`,
    roomId,
    srcThreadId,
    sinceTs,
  )) as WebchatMessage[];
}

/**
 * Append a demarcation divider + verbatim copies of `rows` into (room, destThread),
 * marked with `origin`. New ids + created_at=now so they land at the destination's
 * current end; originals are untouched. Returns the inserted rows (divider first)
 * for broadcast.
 */
export async function insertSyncedMessages(
  roomId: string,
  destThreadId: string,
  rows: WebchatMessage[],
  origin: 'pulled' | 'pushed',
  dividerText: string,
): Promise<WebchatMessage[]> {
  const db = getDb();
  // Land strictly after the destination's current tail. Date.now() alone collides
  // when two syncs fire inside the same millisecond (back-to-back pushes), which
  // would interleave their dividers ahead of their messages; clamping to the
  // existing max+1 keeps each batch contiguous and in order.
  const tail = (
    (await db.get(
      `SELECT COALESCE(MAX(created_at), 0) AS m FROM webchat_messages WHERE room_id = ? AND thread_id = ?`,
      roomId,
      destThreadId,
    )) as { m: number }
  ).m;
  const base = Math.max(Date.now(), tail + 1);
  // The driver has no statement objects, so the SQL is hoisted instead of a
  // prepared statement. It still binds by NAME — the driver detects a single
  // object argument and passes it through to better-sqlite3's named binding.
  const INSERT_MESSAGE = `INSERT INTO webchat_messages
       (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at, origin)
     VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at, @origin)`;
  const out: WebchatMessage[] = [];
  await db.transaction(async () => {
    const divider: WebchatMessage = {
      id: randomUUID(),
      room_id: roomId,
      thread_id: destThreadId,
      sender: 'system',
      sender_type: 'system',
      content: dividerText,
      message_type: 'context-divider',
      file_meta: null,
      created_at: base,
      origin,
    };
    await db.run(INSERT_MESSAGE, { ...divider, file_meta: null });
    out.push(divider);
    for (const [i, r] of rows.entries()) {
      const copy: WebchatMessage = {
        id: randomUUID(),
        room_id: roomId,
        thread_id: destThreadId,
        sender: r.sender,
        sender_type: r.sender_type,
        content: r.content,
        message_type: r.message_type,
        // getSyncDelta returns raw rows (SELECT *), so file_meta is the stored
        // JSON string. Parse it back to the object shape for the returned copy
        // (broadcast expects parsed, like getWebchatMessages); the insert below
        // re-stringifies it.
        file_meta: r.file_meta ? (JSON.parse(r.file_meta as unknown as string) as FileMeta) : null,
        created_at: base + i + 1,
        origin,
      };
      await db.run(INSERT_MESSAGE, { ...copy, file_meta: copy.file_meta ? JSON.stringify(copy.file_meta) : null });
      out.push(copy);
    }
  });
  return out;
}

// ── Per-thread engaged agents ──
// A row = agent_group_id is engaged in (room_id, thread_id): it receives every
// message in that thread and replies when addressed. Never the 'main' thread —
// the regular chat stays mention-only. See docs/webchat/thread-engaged-agents.md.

/** Engage an agent in a thread (idempotent). No-op for the 'main' thread. */
export async function engageAgent(
  roomId: string,
  threadId: string,
  agentGroupId: string,
  ts: number = Date.now(),
): Promise<void> {
  if (threadId === MAIN_THREAD) return;
  await getDb().run(
    `INSERT INTO webchat_thread_engaged (room_id, thread_id, agent_group_id, engaged_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, thread_id, agent_group_id) DO NOTHING`,
    roomId,
    threadId,
    agentGroupId,
    ts,
  );
}

/** Disengage an agent from a thread (the × on a chip). No-op if not engaged. */
export async function disengageAgent(roomId: string, threadId: string, agentGroupId: string): Promise<void> {
  await getDb().run(
    `DELETE FROM webchat_thread_engaged WHERE room_id = ? AND thread_id = ? AND agent_group_id = ?`,
    roomId,
    threadId,
    agentGroupId,
  );
}

/** Agent group ids currently engaged in a thread. Empty for 'main'/regular chat. */
export async function getEngagedAgents(roomId: string, threadId: string): Promise<string[]> {
  if (threadId === MAIN_THREAD) return [];
  const rows = (await getDb().all(
    `SELECT agent_group_id FROM webchat_thread_engaged WHERE room_id = ? AND thread_id = ? ORDER BY engaged_at`,
    roomId,
    threadId,
  )) as { agent_group_id: string }[];
  return rows.map((r) => r.agent_group_id);
}

/** True if the agent is engaged in the thread. */
export async function isAgentEngaged(roomId: string, threadId: string, agentGroupId: string): Promise<boolean> {
  if (threadId === MAIN_THREAD) return false;
  return (
    (await getDb().get(
      `SELECT 1 FROM webchat_thread_engaged WHERE room_id = ? AND thread_id = ? AND agent_group_id = ?`,
      roomId,
      threadId,
      agentGroupId,
    )) !== undefined
  );
}

/** Mark a thread read for a user (monotonic high-water mark). */
export async function markThreadRead(
  userId: string,
  roomId: string,
  threadId: string,
  ts: number = Date.now(),
): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_thread_reads (user_id, room_id, thread_id, last_read_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, room_id, thread_id)
         DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
    userId,
    roomId,
    threadId,
    ts,
  );
}

/** Thread ids in a room with unread messages for this user (newest message
 * newer than the user's per-thread marker; no marker = unread if any message). */
export async function getUnreadThreadIdsForRoom(userId: string, roomId: string): Promise<Set<string>> {
  const rows = (await getDb().all(
    `SELECT m.thread_id AS thread_id
         FROM webchat_messages m
         LEFT JOIN webchat_thread_reads r
           ON r.room_id = m.room_id AND r.thread_id = m.thread_id AND r.user_id = ?
        WHERE m.room_id = ?
        GROUP BY m.thread_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.last_read_at), 0)`,
    userId,
    roomId,
  )) as { thread_id: string }[];
  return new Set(rows.map((r) => r.thread_id));
}

// ── Push subscriptions ──

export async function deleteWebchatPushSubscriptionByEndpoint(endpoint: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_push_subscriptions WHERE endpoint = ?`, endpoint);
}

// ── Models ──
//
// LLM endpoint registry. The MVP supports two kinds:
//   - 'anthropic': pin an agent to a specific Anthropic model_id (the
//     existing OneCLI-managed credential is reused — no per-model key).
//   - 'ollama': route at a local Ollama endpoint (Ollama speaks the
//     Anthropic API natively at <endpoint>/v1/messages).
//
// `webchat_agent_models` is the assignment join. PK on agent_group_id keeps
// it 1:1. No FK to webchat_models so the delete-model handler can do
// cascade-with-confirmation in JS.

// 'openai-compatible' covers OpenRouter, LM Studio, vLLM, Llama.cpp, and any
// /v1/{models,chat/completions} endpoint. Agents consume these through the
// Anthropic-spec /v1/messages surface that LiteLLM fronts for every model it
// serves, so they run on the default Claude harness — no extra provider needed.
export type WebchatModelKind = 'anthropic' | 'ollama' | 'openai-compatible';

export interface WebchatModel {
  id: string;
  name: string;
  kind: WebchatModelKind;
  endpoint: string | null;
  model_id: string;
  credential_ref: string | null;
  created_at: number;
}

export async function listWebchatModels(): Promise<WebchatModel[]> {
  return (await getDb().all(`SELECT * FROM webchat_models ORDER BY name COLLATE NOCASE`)) as WebchatModel[];
}

export async function getWebchatModel(id: string): Promise<WebchatModel | undefined> {
  return (await getDb().get(`SELECT * FROM webchat_models WHERE id = ?`, id)) as WebchatModel | undefined;
}

export async function createWebchatModel(m: WebchatModel): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES (@id, @name, @kind, @endpoint, @model_id, @credential_ref, @created_at)`,
    m,
  );
}

export async function updateWebchatModel(
  id: string,
  patch: { name?: string; endpoint?: string | null; model_id?: string; credential_ref?: string | null },
): Promise<void> {
  const existing = await getWebchatModel(id);
  if (!existing) return;
  const next = { ...(await existing), ...patch };
  await getDb().run(
    `UPDATE webchat_models
       SET name = ?, endpoint = ?, model_id = ?, credential_ref = ?
       WHERE id = ?`,
    next.name,
    next.endpoint,
    next.model_id,
    next.credential_ref,
    id,
  );
}

export async function deleteWebchatModel(id: string): Promise<void> {
  const db = getDb();
  // Cascade in JS — caller is expected to have surfaced the impact list.
  await db.run(`DELETE FROM webchat_agent_models WHERE model_id = ?`, id);
  await db.run(`DELETE FROM webchat_models WHERE id = ?`, id);
}

export async function getAgentsAssignedToModel(modelId: string): Promise<string[]> {
  return (
    (await getDb().all(`SELECT agent_group_id FROM webchat_agent_models WHERE model_id = ?`, modelId)) as {
      agent_group_id: string;
    }[]
  ).map((r) => r.agent_group_id);
}

export interface WebchatTopology {
  rooms: { id: string; name: string }[];
  agents: { id: string; name: string; modelId: string | null; modelName: string | null }[];
  models: { id: string; name: string }[];
  edges: { room: string; agent: string }[]; // room↔agent wirings
  /**
   * MCP servers an agent can reach. They belong in the picture: a room's messages
   * flow to an agent, and that agent can hand them to a third-party tool server —
   * which is exactly the sort of reach you want to SEE rather than infer from a
   * settings drawer. `remote` means the container dials out to someone else's host.
   */
  mcpServers: { id: string; name: string; remote: boolean; host: string | null }[];
  mcpEdges: { agent: string; mcp: string }[];
}

/**
 * Assemble the room → agent → model topology from the given (already
 * access-filtered) rooms AND agents. ALL accessible agents appear as nodes —
 * including ones wired to no in-scope room (they surface as orphans in the graph
 * and as empty columns in the wiring matrix, so a brand-new agent can be wired
 * straight from the matrix). Edges are the room↔agent wirings among these rooms
 * and agents only — so nothing outside the caller's visible set leaks. Each
 * agent carries its assigned model; models are deduped. Powers GET /api/topology.
 */
export async function getWebchatTopology(
  rooms: { id: string; name: string }[],
  agents: { id: string; name: string }[],
): Promise<WebchatTopology> {
  // Resolved HERE, once. Leaving this as an array of promises made
  // `new Set(agentNodes.map(async …))` a Set of PROMISES, so `ids.has(a.id)`
  // never matched and the topology rendered with no edges at all — a graph of
  // disconnected nodes, with nothing failing to say so.
  const agentNodes = await Promise.all(
    agents.map(async (a) => {
      const m = await getAssignedModelForAgent(a.id);
      return { id: a.id, name: a.name, modelId: m?.id ?? null, modelName: m?.name ?? null };
    }),
  );
  const ids = new Set(agentNodes.map((a) => a.id));
  const edges: { room: string; agent: string }[] = [];
  for (const room of rooms) {
    for (const a of await getAgentsForWebchatRoom(room.id)) {
      if (ids.has(a.id)) edges.push({ room: room.id, agent: a.id });
    }
  }
  const modelMap = new Map<string, { id: string; name: string }>();
  for (const a of agentNodes) if (a.modelId) modelMap.set(a.modelId, { id: a.modelId, name: a.modelName ?? a.modelId });

  // MCP servers reachable from each agent. Only servers actually attached to an
  // agent in view appear — an unattached server has no reach, so it isn't a node.
  const mcpMap = new Map<string, { id: string; name: string; remote: boolean; host: string | null }>();
  const mcpEdges: { agent: string; mcp: string }[] = [];
  for (const a of agentNodes) {
    for (const srv of await getMcpServersForAgent(a.id)) {
      if (!mcpMap.has(srv.id)) {
        const remote = srv.transport !== 'stdio';
        let host: string | null = null;
        if (remote && srv.url) {
          try {
            host = new URL(srv.url).host;
          } catch {
            host = srv.url;
          }
        }
        mcpMap.set(srv.id, { id: srv.id, name: srv.name, remote, host });
      }
      mcpEdges.push({ agent: a.id, mcp: srv.id });
    }
  }

  return {
    rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
    agents: agentNodes,
    models: [...modelMap.values()],
    edges,
    mcpServers: [...mcpMap.values()],
    mcpEdges,
  };
}

export async function getAssignedModelForAgent(agentGroupId: string): Promise<WebchatModel | null> {
  const row = (await getDb().get(
    `SELECT model_id FROM webchat_agent_models WHERE agent_group_id = ?`,
    agentGroupId,
  )) as { model_id: string } | undefined;
  if (!row) return null;
  return (await getWebchatModel(row.model_id)) ?? null;
}

/**
 * Workspace DEFAULT model (webchat_settings singleton) — the ollama-kind
 * roster model every claude-family agent WITHOUT its own assignment falls
 * back to. The model analogue of the workspace default credential.
 */
export const getDefaultModelId = settingsGetter('default_model_id', decodeNullableString);
export const setDefaultModelId = settingsSetter('default_model_id', encodeNullableString);

/**
 * The model that actually powers an agent: its own assignment, else the
 * workspace default. This is what the settings.json writer and the
 * lenientOutput augmentor consume — per-agent assignment always wins,
 * mirroring member-credential > workspace-credential layering.
 */
export async function getEffectiveModelForAgent(agentGroupId: string): Promise<WebchatModel | null> {
  const assigned = await getAssignedModelForAgent(agentGroupId);
  if (assigned) return assigned;
  const defaultId = await getDefaultModelId();
  return defaultId ? ((await getWebchatModel(defaultId)) ?? null) : null;
}

export async function assignModelToAgent(agentGroupId: string, modelId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET model_id = excluded.model_id, assigned_at = excluded.assigned_at`,
    agentGroupId,
    modelId,
    Date.now(),
  );
}

export async function unassignModelFromAgent(agentGroupId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_agent_models WHERE agent_group_id = ?`, agentGroupId);
}

// ── Room state: global archive + per-user hide ──
//
// `archive` is now a GLOBAL room state — settable by owners/admins,
// visible to every user with access. The room still routes messages
// normally; archive is presentation only ("closed-to-active-work" hint).
//
// `hide` is a PER-USER sidebar preference (renamed from the previous
// "archive for user X"). Affects only that user's view; doesn't change
// anything for other users.
//
// `room_id` is `messaging_groups.platform_id` (consistent with
// webchat_room_primes etc.). Both tables intentionally have no FK
// to `messaging_groups` — cascade-on-room-delete is handled in app code
// (clearArchiveForRoom / clearHidesForRoom called from deleteWebchatRoom).

// ── Global archive (settable by owners + admins) ──

export async function archiveRoom(roomId: string, archivedBy: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_archives (room_id, archived_at, archived_by)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO NOTHING`,
    roomId,
    new Date().toISOString(),
    archivedBy,
  );
}

export async function unarchiveRoom(roomId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_room_archives WHERE room_id = ?`, roomId);
}

export async function isRoomArchived(roomId: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 FROM webchat_room_archives WHERE room_id = ?`, roomId);
  return !!row;
}

export async function getArchivedRoomIds(): Promise<Set<string>> {
  const rows = (await getDb().all(`SELECT room_id FROM webchat_room_archives`)) as { room_id: string }[];
  return new Set(rows.map((r) => r.room_id));
}

export async function clearArchiveForRoom(roomId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_room_archives WHERE room_id = ?`, roomId);
}

// ── Per-user room-flag table factory (hides / reads / pins) ──
// All three tables are keyed on (user_id, room_id) with the trusted webchat
// user_id, so a flag follows the user across devices. The factory covers the
// shared shapes — per-user un-flag, per-user room-id set, per-room cascade
// clear. Each table's divergent pieces (the hide insert's legacy archived_at
// column, the monotonic read marker + unread join, pin positions/ordering)
// stay hand-written below.

function userRoomFlagTable(table: string) {
  return {
    async removeForUser(userId: string, roomId: string): Promise<void> {
      await getDb().run(`DELETE FROM ${table} WHERE user_id = ? AND room_id = ?`, userId, roomId);
    },
    async roomIdsForUser(userId: string): Promise<Set<string>> {
      const rows = (await getDb().all(`SELECT room_id FROM ${table} WHERE user_id = ?`, userId)) as {
        room_id: string;
      }[];
      return new Set(rows.map((r) => r.room_id));
    },
    async clearForRoom(roomId: string): Promise<void> {
      await getDb().run(`DELETE FROM ${table} WHERE room_id = ?`, roomId);
    },
  };
}

const roomHides = userRoomFlagTable('webchat_user_room_hides');
const roomReads = userRoomFlagTable('webchat_room_reads');
const roomPins = userRoomFlagTable('webchat_room_pins');

// ── Per-user hide (any user, on rooms they can access) ──

export async function hideRoomForUser(userId: string, roomId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_user_room_hides (user_id, room_id, archived_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, room_id) DO NOTHING`,
    userId,
    roomId,
    new Date().toISOString(),
  );
}

export const unhideRoomForUser = roomHides.removeForUser;
export const getHiddenRoomIdsForUser = roomHides.roomIdsForUser;
export const clearHidesForRoom = roomHides.clearForRoom;

// ── Per-user read markers (unread badge persistence) ──
//
// `last_read_at` is a per-(user, room) high-water mark of the newest message
// `created_at` the user has seen. A room is unread for the user when its newest
// message is newer than the marker (or there's no marker and the room has any
// messages). The marker is server-side and keyed on the trusted webchat
// user_id, so the unread badge is shared across all of that user's devices:
// reading on one device clears it on the others (live via a `read_cleared`
// push; on reconnect via the `unread` flag in the rooms payload).

/**
 * Advance a user's read marker for a room to `ts` (defaults to now). Idempotent
 * and monotonic — never moves the marker backwards, so a late-arriving stale
 * read (e.g. a backgrounded tab catching up) can't un-read newer messages.
 */
export async function markRoomRead(userId: string, roomId: string, ts: number = Date.now()): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_reads (user_id, room_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
    userId,
    roomId,
    ts,
  );
}

/**
 * The set of room ids that have unread messages for this user: rooms whose
 * newest message is newer than the user's read marker (rooms with no marker
 * yet count as unread if they contain any message). The `idx_webchat_messages_room`
 * index makes the per-room MAX(created_at) cheap. Approval/a2a side-channel
 * rows count the same as in the live `unread` path — any new activity lights
 * the dot.
 */
export async function getUnreadRoomIdsForUser(userId: string): Promise<Set<string>> {
  const rows = (await getDb().all(
    `SELECT m.room_id AS room_id
         FROM webchat_messages m
         LEFT JOIN webchat_room_reads r
           ON r.room_id = m.room_id AND r.user_id = ?
        GROUP BY m.room_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.last_read_at), 0)`,
    userId,
  )) as { room_id: string }[];
  return new Set(rows.map((r) => r.room_id));
}

/** Drop a room's read markers — called from deleteWebchatRoom's cascade. */
export const clearReadsForRoom = roomReads.clearForRoom;

// ── Per-user room pins (sticky group at the top of the sidebar) ──
// Pins are per-(user, room), keyed on the trusted webchat user_id, so a pin
// follows the user across devices (same model as read markers/hides).

/**
 * Pin a room for a user. Idempotent — re-pinning keeps the original pinned_at.
 * A fresh pin lands at the BOTTOM of the user's pinned group (max position + 1)
 * so it doesn't disturb an order the user has arranged.
 */
export async function pinRoomForUser(userId: string, roomId: string, ts: number = Date.now()): Promise<void> {
  const next = (
    (await getDb().get(
      `SELECT COALESCE(MAX(position) + 1, 0) AS n FROM webchat_room_pins WHERE user_id = ?`,
      userId,
    )) as { n: number }
  ).n;
  await getDb().run(
    `INSERT INTO webchat_room_pins (user_id, room_id, pinned_at, position)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, room_id) DO NOTHING`,
    userId,
    roomId,
    ts,
    next,
  );
}

export const unpinRoomForUser = roomPins.removeForUser;
export const getPinnedRoomIdsForUser = roomPins.roomIdsForUser;

/** Per-user pinned room → manual sort position (lower = higher in the list). */
export async function getPinnedPositionsForUser(userId: string): Promise<Map<string, number>> {
  const rows = (await getDb().all(`SELECT room_id, position FROM webchat_room_pins WHERE user_id = ?`, userId)) as {
    room_id: string;
    position: number;
  }[];
  return new Map(rows.map((r) => [r.room_id, r.position]));
}

/**
 * Persist a user's pinned-room order. `orderedRoomIds` is the desired top-to-
 * bottom order; each row's position is set to its index. Rows the user hasn't
 * pinned are silently ignored (the UPDATE matches nothing), so a stale or
 * hostile id can't create or reorder anyone else's pins.
 */
export async function setPinnedOrderForUser(userId: string, orderedRoomIds: string[]): Promise<void> {
  const db = getDb();
  // better-sqlite3's transaction() returned a callable taking the rows; the
  // driver's takes the work itself, so the ids are closed over rather than
  // passed. Sequential await, not forEach — a forEach callback cannot await and
  // would fire every UPDATE outside the transaction it is meant to be inside.
  await db.transaction(async () => {
    for (const [i, roomId] of orderedRoomIds.entries()) {
      await db.run(`UPDATE webchat_room_pins SET position = ? WHERE user_id = ? AND room_id = ?`, i, userId, roomId);
    }
  });
}

/** Drop a room's pins — called from deleteWebchatRoom's cascade. */
export const clearPinsForRoom = roomPins.clearForRoom;

/**
 * Newest message `created_at` per room — the sort key for the "Recent" sidebar
 * order. Rooms with no messages are absent; the view falls back to the room's
 * own `created_at`. The `idx_webchat_messages_room` index makes the per-room MAX
 * cheap.
 */
export async function getRoomLastActivity(): Promise<Map<string, number>> {
  const rows = (await getDb().all(
    `SELECT room_id, MAX(created_at) AS last_at FROM webchat_messages GROUP BY room_id`,
  )) as { room_id: string; last_at: number }[];
  return new Map(rows.map((r) => [r.room_id, r.last_at]));
}

// ── User @-mention handles ──────────────────────────────────────────────────
// Per-user slug others type to @-mention them. Lowercase [a-z0-9-]; UNIQUE so a
// handle resolves to exactly one user. Defaults to a slug of the display name.

/** Slugify a display name into a candidate handle: lowercase, [a-z0-9-] only. */
export function slugifyHandle(name: string): string {
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'user';
}

export async function getWebchatUserHandle(userId: string): Promise<string | null> {
  const row = (await getDb().get(`SELECT handle FROM webchat_user_handles WHERE user_id = ?`, userId)) as
    | { handle: string }
    | undefined;
  return row?.handle ?? null;
}

/** Which user_id (if any) currently owns a handle. */
export async function userIdForHandle(handle: string): Promise<string | null> {
  const row = (await getDb().get(`SELECT user_id FROM webchat_user_handles WHERE handle = ?`, handle.toLowerCase())) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
}

/**
 * Set a user's handle. Returns { ok } or { ok:false, reason } when the handle is
 * already taken by another user (caller surfaces a 409). Validates the shape too.
 */
export async function setWebchatUserHandle(
  userId: string,
  handle: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const h = handle.toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(h)) return { ok: false, reason: 'invalid' };
  const owner = await userIdForHandle(h);
  if (owner && owner !== userId) return { ok: false, reason: 'taken' };
  await getDb().run(
    `INSERT INTO webchat_user_handles (user_id, handle, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle`,
    userId,
    h,
    Date.now(),
  );
  return { ok: true };
}

/**
 * Ensure a user has a handle, defaulting to a slug of their display name with a
 * numeric suffix on collision. Idempotent; called on WS connect so every user is
 * @-mentionable by default. Returns the effective handle.
 */
export async function ensureWebchatUserHandle(userId: string, displayName: string): Promise<string> {
  const existing = await getWebchatUserHandle(userId);
  if (existing) return existing;
  const base = slugifyHandle(displayName);
  let candidate = base;
  // Await in the CONDITION: the un-awaited promise was always !== null, so
  // this looped forever appending suffixes until the heap died.
  for (let n = 2; (await userIdForHandle(candidate)) !== null; n++) candidate = `${base}-${n}`;
  await getDb().run(
    `INSERT OR IGNORE INTO webchat_user_handles (user_id, handle, created_at) VALUES (?, ?, ?)`,
    userId,
    candidate,
    Date.now(),
  );
  // Re-read in case a concurrent connect won the INSERT for this user_id.
  return (await getWebchatUserHandle(userId)) ?? candidate;
}

/**
 * Everyone who has a handle, with their display name — the candidate pool for
 * @-mention autocomplete. The caller filters by room access; mention candidates
 * are NOT limited to currently-connected members (you can mention someone who's
 * offline — they get the badge/notification when they return).
 */
export async function getWebchatHandleUsers(): Promise<
  { userId: string; handle: string; displayName: string | null }[]
> {
  return (await getDb().all(`SELECT h.user_id AS userId, h.handle AS handle, u.display_name AS displayName
         FROM webchat_user_handles h
         LEFT JOIN users u ON u.id = h.user_id`)) as { userId: string; handle: string; displayName: string | null }[];
}

/** Resolve a set of @-handles to the user_ids that own them (for mention detection). */
export async function resolveHandlesToUserIds(handles: string[]): Promise<string[]> {
  const uniq = [...new Set(handles.map((h) => h.toLowerCase()))].filter(Boolean);
  if (uniq.length === 0) return [];
  const rows = (await getDb().all(
    `SELECT user_id FROM webchat_user_handles WHERE handle IN (${uniq.map(() => '?').join(',')})`,
    ...uniq,
  )) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/**
 * Rooms with an unread message that @-mentions this user's handle (latest such
 * message is newer than their last read marker) — for the durable mention badge
 * on load. The live `mention` WS signal is exact; this load-time query uses a
 * substring LIKE on the handle, so it's approximate (may include `@handle-2`
 * style near-matches) — acceptable for a badge. Empty when handle is blank.
 */
export async function getMentionedRoomIdsForUser(userId: string, handle: string): Promise<Set<string>> {
  const h = (handle || '').toLowerCase();
  if (!h) return new Set();
  const rows = (await getDb().all(
    `SELECT m.room_id AS room_id
         FROM webchat_messages m
         LEFT JOIN webchat_room_reads r
           ON r.room_id = m.room_id AND r.user_id = ?
        WHERE m.content LIKE '%@' || ? || '%'
        GROUP BY m.room_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.last_read_at), 0)`,
    userId,
    h,
  )) as { room_id: string }[];
  return new Set(rows.map((r) => r.room_id));
}

// ── Template sources (webchat_template_sources) ─────────────────────────────
// Where agent templates can be fetched from. Same shape and same contract as
// skill sources below: the seeded first-party row is official, everything an
// operator adds is community and stays that way across edits.
export interface WebchatTemplateSource {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  official: boolean;
}

type TemplateSourceRow = Omit<WebchatTemplateSource, 'official'> & { official: number };

export async function listTemplateSources(): Promise<WebchatTemplateSource[]> {
  return (
    (await getDb().all(
      'SELECT id, label, owner, repo, branch, official FROM webchat_template_sources ORDER BY created_at',
    )) as TemplateSourceRow[]
  ).map((r) => ({ ...r, official: !!r.official }));
}

export async function getTemplateSource(id: string): Promise<WebchatTemplateSource | undefined> {
  const r = (await getDb().get(
    'SELECT id, label, owner, repo, branch, official FROM webchat_template_sources WHERE id = ?',
    id,
  )) as TemplateSourceRow | undefined;
  return r ? { ...r, official: !!r.official } : undefined;
}

export async function upsertTemplateSource(s: Omit<WebchatTemplateSource, 'official'>): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_template_sources (id, label, owner, repo, branch, official, created_at)
       VALUES (@id, @label, @owner, @repo, @branch, 0, @created_at)
       ON CONFLICT(id) DO UPDATE SET label=@label, owner=@owner, repo=@repo, branch=@branch`,
    { ...s, created_at: Date.now() },
  );
}

/** Official rows are code-seeded and not deletable — removing one would come back on the next migrate. */
export async function deleteTemplateSource(id: string): Promise<boolean> {
  return (await getDb().run('DELETE FROM webchat_template_sources WHERE id = ? AND official = 0', id)).changes > 0;
}

// ── Skill catalog sources (webchat_skill_sources) ───────────────────────────
// The Skills tab's browsable collections. Seeded by migration 120; global
// admins manage the list from Settings.
export interface WebchatSkillSource {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  dir: string;
  official: boolean;
}

type SkillSourceRow = Omit<WebchatSkillSource, 'official'> & { official: number };
const toSource = (r: SkillSourceRow): WebchatSkillSource => ({ ...r, official: !!r.official });

export async function listSkillSources(): Promise<WebchatSkillSource[]> {
  return (
    (await getDb().all(
      'SELECT id, label, owner, repo, branch, dir, official FROM webchat_skill_sources ORDER BY created_at',
    )) as SkillSourceRow[]
  ).map(toSource);
}

// Admin-added sources are always community (official=0). The `official` flag is
// set only by the seed/migration for first-party collections and is deliberately
// NOT touched on edit, so re-saving a source can't silently promote/demote it.
export async function upsertSkillSource(s: Omit<WebchatSkillSource, 'official'>): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_skill_sources (id, label, owner, repo, branch, dir, official, created_at)
       VALUES (@id, @label, @owner, @repo, @branch, @dir, 0, @created_at)
       ON CONFLICT(id) DO UPDATE SET label=@label, owner=@owner, repo=@repo, branch=@branch, dir=@dir`,
    { ...s, created_at: Date.now() },
  );
}

export async function deleteSkillSource(id: string): Promise<boolean> {
  return (await getDb().run('DELETE FROM webchat_skill_sources WHERE id = ?', id)).changes > 0;
}

// Enable/disable a code-wired built-in source (the marketplace). A row in
// webchat_disabled_sources means "switched off" — removed from the pool.
export async function isSourceDisabled(id: string): Promise<boolean> {
  return !!(await getDb().get('SELECT 1 FROM webchat_disabled_sources WHERE id = ?', id));
}
export async function setSourceDisabled(id: string, disabled: boolean): Promise<void> {
  if (disabled) await getDb().run('INSERT OR IGNORE INTO webchat_disabled_sources (id) VALUES (?)', id);
  else await getDb().run('DELETE FROM webchat_disabled_sources WHERE id = ?', id);
}
