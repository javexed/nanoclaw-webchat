// ── Floor: a spatial view of what every session is doing right now ──────────
//
// The dashboard answers "how much is happening"; this answers "WHICH agent is
// wedged". Those are different questions, and the second one currently costs a
// sysadmin an `ncl sessions list`, a drift check, and a log read. A desk per
// session, coloured by state, makes it a glance.
//
// SCOPE-AWARE like the overview: a caller only ever sees desks for agent groups
// they can access, and `restricted` says which shape they got. Withholding in
// the GUI is not withholding — the response is one devtools tab away.
//
// CONTENT IS DELIBERATELY ABSENT. The per-room status frames carry redacted
// tool targets and reasoning summaries because the room's own members are
// watching. This view is install-wide, so the same text would put every room's
// activity in front of one admin. A sysadmin needs the STATE (working, idle,
// stuck) and never the content, so only `kind` crosses this boundary — no text,
// no detail, no message bodies. That is a smaller surface than the room feed,
// on purpose.
//
// Polled, not pushed. A push channel would mean an install-wide fan-out through
// the status adapter, which is on the delivery path; a read-only snapshot on a
// few seconds' interval is enough to watch a floor and cannot wedge delivery.
import { getDb } from '../../../db/connection.js';
import { isContainerRunning } from '../../../container-runner.js';
import { getLastStatusEvent } from '../../../modules/agent-status/index.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { openOutboundDb } from '../../../session-manager.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { isAnyAdmin, isOwner } from '../roles.js';

/**
 * What a desk is doing. Ordered by how much it wants attention, which is the
 * order the UI sorts by — a floor is only useful if trouble is at the front.
 */
export type DeskState =
  | 'stuck' // container alive, but its last event says otherwise (see below)
  | 'working' // container alive and streaming
  | 'idle' // container alive, nothing in flight
  | 'cold'; // no container — normal, most sessions are cold most of the time

export interface Desk {
  session_id: string;
  agent_group_id: string;
  agent_name: string;
  room_id: string | null;
  room_name: string | null;
  state: DeskState;
  /** Last status kind seen for this session, or null when it never streamed. */
  last_kind: string | null;
  /** ms since this session was last active, or null when never. */
  idle_ms: number | null;
}

export interface FloorSnapshot {
  restricted: boolean;
  desks: Desk[];
  counts: Record<DeskState, number>;
  generated_at: string;
}

/**
 * A container alive with no 'done' after its last 'start' has a turn in flight.
 * That is normal for a while and pathological after a long while, and the host
 * sweep already owns the kill decision — this only has to AGREE with it, not
 * duplicate it. 30 minutes is the sweep's own absolute ceiling; using the same
 * number means a desk turns red at the moment the sweep starts considering it,
 * rather than at some second, unrelated threshold nobody can reconcile.
 */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  last_active: string | null;
}

/**
 * Read a session's last status kind without holding the DB open.
 *
 * Best-effort in the same sense as the rest of the status module: a session
 * whose container has never opened its outbound DB simply has no feed, and a
 * cosmetic view must never throw because of that.
 */
function lastKindFor(agentGroupId: string, sessionId: string): string | null {
  try {
    const db = openOutboundDb(agentGroupId, sessionId);
    return getLastStatusEvent(db)?.kind ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session's room label and click-through id.
 *
 * Split out to be testable: the original bug was passing a messaging-group ROW
 * id where a PLATFORM id was expected. Both are strings, so no type catches it
 * and the only symptom was every desk reading "no room" — worth pinning.
 */
export function roomFor(mg: { channel_type?: string; platform_id?: string | null; name?: string | null } | undefined): {
  roomId: string | null;
  roomName: string | null;
} {
  if (!mg) return { roomId: null, roomName: null };
  return {
    // Only webchat platform ids mean anything to the room click-through.
    roomId: mg.channel_type === 'webchat' ? (mg.platform_id ?? null) : null,
    roomName: mg.name ?? mg.platform_id ?? null,
  };
}

export function deskState(running: boolean, lastKind: string | null, idleMs: number | null): DeskState {
  if (!running) return 'cold';
  // 'stalled' is host-generated and means the container went away mid-turn; if
  // we still see a process, that disagreement is itself the alarm.
  if (lastKind === 'stalled') return 'stuck';
  const midTurn = lastKind !== null && lastKind !== 'done';
  if (midTurn && idleMs !== null && idleMs > STUCK_AFTER_MS) return 'stuck';
  if (midTurn) return 'working';
  return 'idle';
}

/**
 * Build the floor for one caller.
 *
 * Desks are ordered trouble-first (stuck, working, idle, cold) and then by how
 * long they have been quiet, so a 40-desk floor still puts the one that needs a
 * human at the top-left. A 6-desk floor reads the same way; the layout is the
 * client's problem, the ordering is not.
 */
export async function buildFloor(userId: string): Promise<FloorSnapshot> {
  const db = getDb();
  const privileged = (await isOwner(userId)) || (await isAnyAdmin(userId));

  const rows = (await db.all(`SELECT id, agent_group_id, messaging_group_id, last_active
         FROM sessions
        ORDER BY last_active DESC`)) as SessionRow[];

  const now = Date.now();
  const desks: Desk[] = [];

  for (const row of rows) {
    // Scope first: never do per-session work for a group the caller cannot see.
    if (!(await canAccessAgentGroup(userId, row.agent_group_id)).allowed) continue;

    // getWebchatRoom() keys on PLATFORM id, not the messaging-group row id that
    // sessions carry — passing the latter missed every time and painted the
    // whole floor "no room". Resolve the group itself, then expose its
    // platform_id only for webchat (that is the id the room click-through
    // understands); a session wired to slack or telegram still shows its name.
    const mg = row.messaging_group_id ? await getMessagingGroup(row.messaging_group_id) : undefined;
    const { roomId, roomName } = roomFor(mg);
    const running = isContainerRunning(row.id);
    // Only pay the DB open for sessions that could be doing something. A cold
    // session's last kind is not interesting and there may be hundreds of them.
    const lastKind = running ? lastKindFor(row.agent_group_id, row.id) : null;
    const lastActive = row.last_active ? Date.parse(row.last_active) : NaN;
    const idleMs = Number.isNaN(lastActive) ? null : Math.max(0, now - lastActive);

    desks.push({
      session_id: row.id,
      agent_group_id: row.agent_group_id,
      agent_name: await agentNameFor(db, row.agent_group_id),
      room_id: roomId,
      room_name: roomName,
      state: deskState(running, lastKind, idleMs),
      last_kind: lastKind,
      idle_ms: idleMs,
    });
  }

  const sorted = sortDesks(desks);

  const counts: Record<DeskState, number> = { stuck: 0, working: 0, idle: 0, cold: 0 };
  for (const d of sorted) counts[d.state]++;

  return { restricted: !privileged, desks: sorted, counts, generated_at: new Date().toISOString() };
}

/** Agent group display name, falling back to the id so a desk is never blank. */
async function agentNameFor(db: ReturnType<typeof getDb>, agentGroupId: string): Promise<string> {
  try {
    const row = (await db.get('SELECT name FROM agent_groups WHERE id = ?', agentGroupId)) as
      | { name?: string }
      | undefined;
    return row?.name || agentGroupId;
  } catch {
    return agentGroupId;
  }
}

/**
 * Trouble first, then longest-quiet first.
 *
 * The ordering is the feature on a 40-desk floor: whatever the client does with
 * layout, the desk that needs a human is the first one it places. Returns a new
 * array — callers pass snapshots around and an in-place sort surprises them.
 */
export function sortDesks(desks: Desk[]): Desk[] {
  const ORDER: Record<DeskState, number> = { stuck: 0, working: 1, idle: 2, cold: 3 };
  return [...desks].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.idle_ms ?? 0) - (a.idle_ms ?? 0));
}
