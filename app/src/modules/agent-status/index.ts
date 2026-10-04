/**
 * Agent activity status forwarding — default module.
 *
 * The agent-runner records fine-grained activity for the current turn (tool in
 * use, progress milestones, reasoning summaries) into an append-only
 * `status_events` table in the session's outbound.db. This module tails that
 * table on the delivery poll and forwards each new row to the channel adapter
 * via `sendStatus`, so a rich client (webchat) can render a live "thinking"
 * bubble. It is purely cosmetic: it never touches routing, delivery, or
 * lifecycle, and any failure is swallowed.
 *
 * Channels with no status surface simply don't implement `sendStatus`, so the
 * forward is a no-op for them. Redaction of the forwarded text is the channel's
 * responsibility (webchat scrubs before broadcasting to clients).
 * Self-registers on the delivery/lifecycle seams at import (modules barrel).
 */
import type { Session } from '../../types.js';
import type { AgentActivityStatus } from '../../seam/index.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { openOutboundDb } from '../../session-db-access.js';
import type Database from 'better-sqlite3';
import { isContainerRunning } from '../../container-runner.js';
import { registerContainerExitObserver } from '../../seam/index.js';
import { onDeliveryAdapterReady } from '../../delivery.js';
import { registerSessionDeliveryObserver } from '../../seam/index.js';
import { notifyStatusObservers, registerUnforwardedStartCheck } from './observers.js';

interface StatusAdapter {
  sendStatus?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    status: AgentActivityStatus,
    instance?: string,
  ): Promise<void>;
}

let adapter: StatusAdapter | null = null;

/**
 * Per-session high-water mark: the seq of the last status event we've already
 * forwarded. On first sight of a session we seed it with the current MAX so a
 * host restart doesn't replay a turn's backlog — only genuinely new activity
 * (including all activity in subsequent turns, since seq is monotonic) flows.
 */
const watermarks = new Map<string, number>();

/**
 * Sessions with a turn currently in progress (a 'start' was forwarded, no
 * 'done' yet). Lets notifySessionStopped tell a mid-turn death (warn the room)
 * from a clean idle exit after a completed turn (stay silent).
 */
const turnActive = new Set<string>();

/**
 * Sessions whose orphaned bubble we've already cleared via reconcileStaleBubble.
 * Prevents re-emitting a synthetic 'done' every poll; re-armed when a fresh
 * 'start' reopens the turn (or the last event becomes 'done').
 */
const cleared = new Set<string>();

/**
 * Clear a stuck "thinking" bubble. If a session's latest status event isn't
 * 'done' yet its container is no longer running, the turn ended without closing
 * the bubble — common after a host restart (which wipes the in-memory turn
 * tracking) or an ungraceful container death. Emit a one-time synthetic 'done'
 * so the client clears that agent's bubble. Best-effort and idempotent.
 */
async function reconcileStaleBubble(
  session: Session,
  outDb: ReturnType<typeof openOutboundDb>,
  agentName: string | null,
  mg: { channel_type: string; platform_id: string; instance?: string },
): Promise<void> {
  const last = getLastStatusEvent(outDb);
  if (!last || last.kind === 'done') {
    cleared.delete(session.id); // healthy / no open turn — allow a future reconcile
    return;
  }
  if (cleared.has(session.id)) return; // already cleared this orphan
  if (isContainerRunning(session.id)) return; // genuine in-flight turn — real bubble
  cleared.add(session.id);
  turnActive.delete(session.id);
  if (!adapter?.sendStatus) return;
  try {
    await adapter.sendStatus(
      mg.channel_type,
      mg.platform_id,
      null,
      { kind: 'done', text: null, detail: null, agentName },
      mg.instance,
    );
  } catch {
    // Cosmetic — ignore.
  }
}

/** Bind to the delivery adapter. Called once by src/delivery.ts. */
export function setStatusAdapter(a: StatusAdapter): void {
  adapter = a;
}

// 'start' rides the container's status feed; 'stalled' is host-generated (see
// notifySessionStopped) and never appears in the feed.
const VALID_KINDS = new Set<AgentActivityStatus['kind']>(['start', 'tool', 'progress', 'reasoning', 'done']);

/**
 * Read and forward any new status events for a session. Best-effort: opens the
 * outbound DB read-only, reads past the watermark, and pushes each row to the
 * adapter. Swallows everything — a cosmetic feed must never break delivery.
 */
export async function forwardSessionStatus(session: Session): Promise<void> {
  if (!adapter?.sendStatus) return;

  const mg = await (session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined);
  if (!mg || !mg.platform_id) return;

  // Attribute every frame to its agent so a multi-agent room renders one bubble
  // per agent (the webchat keys bubbles by name).
  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? null;

  let outDb;
  try {
    outDb = openOutboundDb(session.agent_group_id, session.id);
  } catch {
    return; // DB not created yet
  }

  try {
    const seen = watermarks.get(session.id);
    if (seen === undefined) {
      // First sight — seed the watermark and forward nothing (skip backlog).
      watermarks.set(session.id, getMaxStatusEventSeq(outDb));
    } else {
      const events = getStatusEventsSince(outDb, seen);
      if (events.length > 0) {
        // Advance the watermark before awaiting any send so a slow/failed send
        // can't cause the same row to be re-forwarded on the next tick.
        watermarks.set(session.id, events[events.length - 1]!.seq);

        for (const ev of events) {
          const kind = ev.kind as AgentActivityStatus['kind'];
          if (!VALID_KINDS.has(kind)) continue;
          // Track turn boundaries so a mid-turn container death can be told from
          // a clean idle exit (see notifySessionStopped).
          if (kind === 'start') {
            turnActive.add(session.id);
            cleared.delete(session.id); // a fresh turn re-arms reconcile
          } else if (kind === 'done') turnActive.delete(session.id);
          try {
            await adapter.sendStatus(
              mg.channel_type,
              mg.platform_id,
              null,
              { kind, text: ev.text, detail: ev.detail, agentName },
              mg.instance,
            );
          } catch {
            // Per-event best-effort.
          }
          await notifyStatusObservers(session, {
            kind,
            text: ev.text,
            detail: ev.detail,
            createdAt: ev.created_at ?? null,
          });
        }
      }
    }

    // Every tick, so it also recovers bubbles orphaned across a restart.
    await reconcileStaleBubble(session, outDb, agentName, mg);
  } catch {
    // Cosmetic — ignore.
  } finally {
    try {
      outDb.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Called by the host when a session's container exits (normal, crash, or
 * ceiling-kill). If a turn was in progress (we forwarded 'start' but never
 * 'done'), the agent died mid-turn — tell the room with a 'stalled' notice so
 * the bubble clears with an explanation instead of vanishing silently. A clean
 * idle exit after a completed turn is a no-op. Best-effort and idempotent.
 */
export async function notifySessionStopped(session: Session): Promise<void> {
  if (!turnActive.has(session.id)) return; // clean exit, or already handled
  turnActive.delete(session.id);
  await notifyStatusObservers(session, { kind: 'stalled', text: null, detail: null, createdAt: null });
  if (!adapter?.sendStatus) return;

  const mg = await (session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined);
  if (!mg || !mg.platform_id) return;

  try {
    await adapter.sendStatus(
      mg.channel_type,
      mg.platform_id,
      null,
      {
        kind: 'stalled',
        text: 'The agent stopped responding. You may want to resend your message.',
        detail: null,
        agentName: (await getAgentGroup(session.agent_group_id))?.name ?? null,
      },
      mg.instance,
    );
  } catch {
    // Best-effort.
  }
}

/** Forget a session's tracking when it's torn down so the maps can't leak. */
export function stopSessionStatus(sessionId: string): void {
  watermarks.delete(sessionId);
  turnActive.delete(sessionId);
  cleared.delete(sessionId);
}

// ── Seam registrations (at import; core call-sites are inert without them) ──
onDeliveryAdapterReady((a) => setStatusAdapter(a));
registerSessionDeliveryObserver(forwardSessionStatus);
registerContainerExitObserver((session) => notifySessionStopped(session));
registerUnforwardedStartCheck(hasUnforwardedStart);

/** Whether the session's feed holds a 'start' past what has been forwarded. */
export function hasUnforwardedStart(agentGroupId: string, sessionId: string): boolean {
  const seen = watermarks.get(sessionId);
  if (seen === undefined) return false;
  let outDb: ReturnType<typeof openOutboundDb> | undefined;
  try {
    outDb = openOutboundDb(agentGroupId, sessionId);
    return (
      outDb.prepare("SELECT 1 FROM status_events WHERE seq > ? AND kind = 'start' LIMIT 1").get(seen) !== undefined
    );
  } catch {
    return false;
  } finally {
    try {
      outDb?.close();
    } catch {
      // ignore
    }
  }
}

// ── status_events readers ────────────────────────────────────────────────────
// The table is created container-side on first write (status-feed.ts). All
// readers tolerate its absence — such a session simply has no feed.
export interface StatusEvent {
  seq: number;
  kind: string;
  text: string | null;
  detail: string | null;
  created_at?: string;
}

/**
 * Read status_events rows past `sinceSeq` (the host's per-session watermark)
 * for the webchat "thinking" activity feed. Returns [] when the table is
 * absent (older session DB) or nothing new has been written since. Read-only;
 * purely cosmetic — never affects routing or lifecycle.
 */
export function getStatusEventsSince(outDb: Database.Database, sinceSeq: number): StatusEvent[] {
  try {
    return outDb
      .prepare('SELECT seq, kind, text, detail, created_at FROM status_events WHERE seq > ? ORDER BY seq ASC')
      .all(sinceSeq) as StatusEvent[];
  } catch {
    // Table not present on older session DBs — nothing to forward.
    return [];
  }
}

/** The latest status event's seq + kind, or undefined when the table is
 *  empty/absent. Used to detect an orphaned "thinking" bubble: a turn whose
 *  last event isn't 'done' but whose container is gone (see agent-status). */
export function getLastStatusEvent(outDb: Database.Database): { seq: number; kind: string } | undefined {
  try {
    return outDb.prepare('SELECT seq, kind FROM status_events ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; kind: string }
      | undefined;
  } catch {
    return undefined;
  }
}

/** Current max status_events seq, or 0 when the table is empty/absent. Used to
 *  initialize the host watermark so a restart doesn't replay a turn's backlog. */
export function getMaxStatusEventSeq(outDb: Database.Database): number {
  try {
    const row = outDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM status_events').get() as { m: number };
    return row.m;
  } catch {
    return 0;
  }
}
