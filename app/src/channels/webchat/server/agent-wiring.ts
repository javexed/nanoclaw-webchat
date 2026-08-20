// ── Agent ↔ room wiring ──────────────────────────────────────────────────────
// Operations on the relationship between an agent group and the room it is
// wired into, rather than on either one alone: creating the bare group, wiring
// it to a room, the folder-name derivation both depend on, pushing a control
// command into a live session, reading a group's learning config, and
// recomputing engage patterns after a wiring change.
//
// Shared rather than moved. The room routes drive all of it, but so do the
// agent-create route, the session-reset route, the agent-learning route and
// provisionWebchatAgentWithRoom — none of them in the room cluster.
// SESSION_COMMANDS and ciFolderToken travel with the single function each
// belongs to: an allowlist and a pattern fragment, private by construction.

/** Slugify an agent/room name into a safe folder + platform_id. */
import { DATA_DIR } from '../../../config.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { getDb, hasTable } from '../../../db/connection.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { createMessagingGroupAgent, getMessagingGroupByPlatform } from '../../../db/messaging-groups.js';
import { insertMessage, openInboundDb } from '../../../db/session-db.js';
import { initGroupFilesystem } from '../../../group-init.js';
import { log } from '../../../log.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../../../modules/agent-to-agent/db/agent-destinations.js';
import { projectDestinationsToActiveSessions } from '../../../modules/agent-to-agent/write-destinations.js';
import type { AgentGroup } from '../../../types.js';
import { createWebchatRoom, getPrimeAgentForWebchatRoom } from '../db.js';
import { writeAgentSettingsForAssignedModel } from '../models.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export function nameToFolder(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a new agent_groups.id that's safe to pass to OneCLI's
 * `ensureAgent({ identifier })` — that endpoint validates against
 * `[a-z][a-z0-9-]{0,49}` (must start with a letter, lowercase, ≤50
 * chars). Bare `randomUUID()` fails when the first hex char is a
 * digit (~10/16 of the time), and the failure mode is silent: the
 * host's container-runner spawns retry forever in host-sweep but
 * the user just sees the chat agent stuck "thinking" with no reply.
 *
 * Prefix with `a` so the leading char is always a letter; the rest
 * of the UUID is already `[0-9a-f-]+`. Total length 37 chars.
 */
export function newAgentGroupId(): string {
  return 'a' + randomUUID();
}

/**
 * Wire an existing agent to a webchat room. Idempotent — calling twice
 * doesn't duplicate the messaging_groups / messaging_group_agents rows.
 * The room id is the agent's `folder` by convention (so each agent has a
 * 1:1 default room with a stable, predictable id).
 *
 * Exported so the webchat lifecycle subscriber (in `index.ts`) can
 * provision rooms for agents created via the a2a `create_agent` tool.
 */
export async function wireAgentToWebchatRoom(roomName: string, platformId: string, agentGroupId: string): Promise<void> {
  // db.createWebchatRoom is itself idempotent on (channel_type='webchat', platform_id).
  await createWebchatRoom(roomName, platformId);
  const mg = await getMessagingGroupByPlatform('webchat', platformId);
  if (!mg) throw new Error(`Webchat room provisioning failed: ${platformId}`);
  const existing = await getDb().get(`SELECT 1 FROM messaging_group_agents
       WHERE messaging_group_id = ? AND agent_group_id = ? LIMIT 1`, mg.id, agentGroupId);
  if (existing) return;
  await createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.', // always engage — webchat rooms wire to a single agent by default
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  // Mirror the unwire teardown (see `unwireAgentFromWebchatRoom` in db.ts):
  // create an `agent_destinations` row so the agent has an ACL entry it can
  // address this room with. Without this, an agent wired into a second room
  // receives inbound messages from it (via the wiring above) but has no
  // destination to reply to — its destinations list stays anchored to its
  // original room and every reply routes there, regardless of which room
  // the request came from. Idempotent on (agent_group_id, target).
  //
  // local_name uses normalizeName(platformId) — a UUID — to guarantee
  // uniqueness within the agent's namespace (PK is agent_group_id, local_name).
  // Using the room's display name would be friendlier but collides if two
  // rooms share a name; backfill (`module-agent-to-agent-destinations.ts`)
  // handles that case with -2/-3 suffixes — worth aligning in a follow-up.
  if ((await hasTable(getDb(), 'agent_destinations'))) {
    const existing = getDestinationByTarget(agentGroupId, 'channel', mg.id);
    if (!existing) {
      await createDestination({
        agent_group_id: agentGroupId,
        local_name: normalizeName(platformId),
        target_type: 'channel',
        target_id: mg.id,
        created_at: new Date().toISOString(),
      });
    }

    // Co-resident a2a destinations: any agents already wired to this room
    // should be addressable by the new agent, and vice versa. PWA "+ Add
    // agent" only creates the room wiring above; without this block, agents
    // sharing a room can't `<message to="…">` each other by name — the main
    // agent in the room sees the newcomer as inbound traffic but has no
    // local_name to address it back. The agent's typical workaround
    // (spawning its own via `create_agent`) results in a duplicate agent.
    // The `create_agent` MCP tool already creates bidirectional rows; this
    // brings the PWA "add agent to room" path to parity.
    const peers = (await getDb().all(`SELECT ag.id, ag.folder FROM messaging_group_agents mga
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
         WHERE mga.messaging_group_id = ? AND mga.agent_group_id != ?`, mg.id, agentGroupId)) as { id: string; folder: string }[];
    const newAgent = (await getDb().get(`SELECT folder FROM agent_groups WHERE id = ?`, agentGroupId)) as
      | { folder: string }
      | undefined;
    const touched = new Set<string>([agentGroupId]);
    for (const peer of peers) {
      await ensureA2aDestination(agentGroupId, peer.id, peer.folder);
      if (newAgent) await ensureA2aDestination(peer.id, agentGroupId, newAgent.folder);
      touched.add(peer.id);
    }
    // Project the new destinations into every touched agent's RUNNING sessions
    // so co-resident agents can address each other immediately — without this
    // a peer whose container is already up sees the newcomer as "unknown:agent"
    // and gets "Unknown destination" trying to reply, until its next respawn.
    for (const id of touched) await projectDestinationsToActiveSessions(id);
  }
  // Wirings changed — recompute engage patterns in case this room has a
  // prime configured. No-op when no prime is set (leaves the default '.').
  await recomputeEngagePatterns(platformId);
}

/**
 * Idempotently create an a2a destination `owner → target` named after
 * `targetFolder`. If that name collides with an existing destination on the
 * owner (typical: same-named channel destination for a room sharing the
 * agent's folder slug), fall back to `<folder>-agent`. If both are taken,
 * log + skip — the operator can add a hand-picked name via `ncl destinations
 * add` if they want one. Always skips if an a2a destination to this target
 * already exists (irrespective of name).
 */
export async function ensureA2aDestination(ownerAgentId: string, targetAgentId: string, targetFolder: string): Promise<void> {
  if ((await getDestinationByTarget(ownerAgentId, 'agent', targetAgentId))) return;
  const base = normalizeName(targetFolder);
  const candidates = [base, `${base}-agent`];
  for (const name of candidates) {
    if (!(await getDestinationByName(ownerAgentId, name))) {
      await createDestination({
        agent_group_id: ownerAgentId,
        local_name: name,
        target_type: 'agent',
        target_id: targetAgentId,
        created_at: new Date().toISOString(),
      });
      return;
    }
  }
  log.warn('Could not auto-create a2a destination — local_name collisions; operator may set one manually', {
    ownerAgentId,
    targetAgentId,
    tried: candidates,
  });
}

export async function recomputeEngagePatterns(roomId: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return;
  const wirings = (await getDb().all(`SELECT mga.id, mga.agent_group_id, ag.folder
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE mga.messaging_group_id = ?`, mg.id)) as { id: string; agent_group_id: string; folder: string }[];

  const primeAgentId = await getPrimeAgentForWebchatRoom(roomId);
  // If the configured prime isn't actually wired (stale row), treat as
  // un-configured. Caller is responsible for cleaning up the stale row.
  const validPrime = primeAgentId && wirings.some((w) => w.agent_group_id === primeAgentId);

  const UPDATE_PATTERN = `UPDATE messaging_group_agents SET engage_pattern = ? WHERE id = ?`;

  if (!validPrime) {
    // No prime — un-primed agents reply only when explicitly @-mentioned. The
    // legacy 'broadcast' fallback (every agent answers every message) has been
    // retired; a shared room stays quiet until an agent is addressed.
    for (const w of wirings) await getDb().run(UPDATE_PATTERN, `\\B@${ciFolderToken(w.folder)}\\b`, w.id);
    return;
  }

  const otherFolders = wirings.filter((w) => w.agent_group_id !== primeAgentId).map((w) => w.folder);
  for (const w of wirings) {
    let pattern: string;
    if (w.agent_group_id === primeAgentId) {
      // Lookahead is anchored to the start so it scans the whole message.
      // No other agents → prime engages on everything (back to '.').
      pattern = otherFolders.length > 0 ? `^(?!.*\\B@(${otherFolders.map(ciFolderToken).join('|')})\\b)` : '.';
    } else {
      pattern = `\\B@${ciFolderToken(w.folder)}\\b`;
    }
    await getDb().run(UPDATE_PATTERN, pattern, w.id);
  }
}

/**
 * Build a case-insensitive regex token for a slug folder by replacing each
 * letter with `[Aa]`-style char class. Hyphens and digits stay as-is. We do
 * this inline because the v2 router calls `new RegExp(pattern)` with no
 * flags, and there's no portable way to set the case-insensitive flag from
 * inside the pattern string (V8 does support `(?i:...)` since ECMAScript
 * 2025, but nothing else does — char classes are bulletproof).
 *
 * Example: 'alice-helper' → '[Aa][Ll][Ii][Cc][Ee]-[Hh][Ee][Ll][Pp][Ee][Rr]'
 */
export function ciFolderToken(folder: string): string {
  let out = '';
  for (const ch of folder) {
    if (/[a-zA-Z]/.test(ch)) {
      out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    } else {
      out += ch;
    }
  }
  return out;
}

// Inject an admin command (/clear or /compact) into a session's inbound.db —
// exactly what a room-typed command does, but reachable for background a2a
// sessions. The poll-loop processes these before any query, so /clear drops the
// poisoned continuation before the next turn. The host owns inbound.db (single
// writer). Bulk broadcast ("… all") loops this over every active session.
export const SESSION_COMMANDS = new Set(['/clear', '/compact']);

export function injectSessionCommand(agentGroupId: string, sessionId: string, command: string): void {
  if (!SESSION_COMMANDS.has(command)) throw new Error(`unsupported session command: ${command}`);
  const dbPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(dbPath)) throw new Error('session inbound.db not found');
  const db = openInboundDb(dbPath);
  try {
    insertMessage(db, {
      id: `${randomUUID()}:${agentGroupId}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'webchat',
      channelType: 'webchat',
      threadId: null,
      content: JSON.stringify({
        text: command,
        sender: 'operator',
        senderId: 'webchat:operator',
        senderName: 'operator',
      }),
      processAfter: null,
      recurrence: null,
      trigger: 1,
    });
  } finally {
    db.close();
  }
}

/**
 * Create a bare agent_group + on-disk filesystem. No room is created and no
 * wiring happens. Used by both POST /api/agents `withRoom: false` and the
 * room-first POST /api/rooms "create new agent inline" path.
 */
export function createBareAgentGroup(
  name: string,
  opts: { folder?: string; instructions?: string } = {},
): { group: AgentGroup } | { error: string; status: number } {
  const folder = opts.folder && /^[a-z0-9_-]+$/i.test(opts.folder) ? opts.folder : nameToFolder(name);
  if (!folder) return { error: 'Could not derive folder from name', status: 400 };
  const group: AgentGroup = {
    id: newAgentGroupId(),
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
    status: 'active',
  };
  try {
    createAgentGroup(group);
  } catch (err) {
    return { error: `Could not create agent group: ${(err as Error).message}`, status: 409 };
  }
  initGroupFilesystem(group, { instructions: opts.instructions });
  // Materialize the model env NOW: a group born AFTER the workspace default
  // model was set would otherwise have no settings.json until some later
  // model change — its first container would fall through to api.anthropic.com
  // (surfaced as a OneCLI 401 in the wizard's Ollama flow, where the default
  // is set one step before the first agent is created).
  try {
    writeAgentSettingsForAssignedModel(group.id);
  } catch (err) {
    log.warn('Webchat: settings.json write for new agent group failed', { agentGroupId: group.id, err });
  }
  return { group };
}

export async function parseAgentLearning(agentGroupId: string): Promise<{
  autoTrigger?: boolean;
  autoKeep?: boolean;
  cooldownMinutes?: number;
  /** Roster model id or a raw Claude model id — consumed container-side (PR #353). */
  reviewModel?: string;
  /** true = replay the full turn to the review; absent = digest (default). */
  replayReview?: boolean;
  /** Who pays for /learn: 'auto' (default) | 'require' | 'off'. */
  chargeInvoker?: 'off' | 'auto' | 'require';
}> {
  try {
    const raw = (await getContainerConfig(agentGroupId))?.learning;
    return raw ? (JSON.parse(raw) as ReturnType<typeof parseAgentLearning>) : {};
  } catch {
    return {};
  }
}
