/**
 * Turn traces: a durable copy of each agent turn's thinking-bubble activity,
 * attached to the reply it produced, so a reply's Thoughts survive a reload,
 * another device, or a later visit. The container wipes its status feed every
 * turn; this keeps what the feed showed.
 *
 * Capture rides agent-status's observer (the same events the bubble gets, in
 * order, per session) plus deliver(), which names each stored reply. A trace
 * opens on 'start', closes on 'done' / 'stalled', and is stored once it has a
 * reply to hang from: its FIRST reply, which is where the live client folds
 * Thoughts too. A turn's 'done' can be read before its reply is delivered
 * (the runner emits it first), so a closed trace keeps accepting the session's
 * replies for LATE_LINK_MS or until the next turn starts. The reverse
 * happens too: replies are delivered before the same tick forwards the feed,
 * so a short turn's reply can arrive ahead of its own 'start'; it is held for
 * that turn rather than linked to the closed one before it. Only replies to
 * the session's own room count — the trace is that room's thinking bubble. A
 * turn that never delivers anything there — a stall with no notice — has
 * nothing to show it on and is dropped.
 *
 * Everything stored passes redactSensitiveData, the redaction the live feed
 * gets before broadcast, and is capped at TRACE_MAX_BYTES.
 *
 * Not stored for a per-member session (one running on a member's own
 * credentials): its tool inputs and outputs may hold what that member's
 * personal secrets fetched, and a stored trace is readable by everyone in the
 * room, members who join later included. The live bubble still shows it.
 */
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { registerModuleSweep } from '../../module-sweep.js';
import {
  hasUnforwardedTurnStart,
  registerStatusEventObserver,
  type ObservedStatusEvent,
} from '../../modules/agent-status/observers.js';
import { memberUserFromKey } from '../../modules/user-credentials/identity.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import type { Session } from '../../types.js';

import {
  getEffectiveModelForAgent,
  getTurnTraceDays,
  getTurnTracesEnabled,
  isApprovalInbox,
  sessionKeyToThread,
} from './db.js';
import { redactSensitiveData } from './redact.js';
import { broadcast } from './state.js';
import { endpointHost, fitTrace, TraceBuilder, type TurnTrace } from './turn-trace.js';

/** How long a closed turn still claims its session's replies. */
export const LATE_LINK_MS = 60_000;
// An open turn older than this lost its 'done' (host restart, dead container).
const OPEN_MAX_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Active {
  id: string;
  builder: TraceBuilder;
  roomId: string;
  threadId: string;
  agentGroupId: string;
  agentName: string | null;
  messageIds: string[];
  closedAt: number | null;
  stored: boolean;
  /** The last write of this trace; the next one runs after it, so writes never overlap. */
  saving: Promise<void>;
  /** A per-member session's turn: shown live, never stored. */
  personal: boolean;
}

const active = new Map<string, Active>();
/** Replies that arrived before their turn's 'start' was read, by session. */
interface HeldReply {
  messageId: string;
  failureNotice: string | null;
  roomId: string | undefined;
  at: number;
}
const held = new Map<string, HeldReply[]>();
// Sessions on another channel: their events are skipped without a lookup each time.
const elsewhere = new Set<string>();

const redact = (s: string | null): string | null => (s == null ? null : redactSensitiveData(s));

function eventTime(ev: ObservedStatusEvent): number {
  const t = ev.createdAt ? Date.parse(ev.createdAt) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

async function openTrace(session: Session, at: number): Promise<Active | null> {
  if (elsewhere.has(session.id) || !(await getTurnTracesEnabled())) return null;
  const mg = await (session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined);
  if (!mg || mg.channel_type !== 'webchat' || !mg.platform_id || isApprovalInbox(mg.platform_id)) {
    if (mg) elsewhere.add(session.id);
    return null;
  }
  const roomId = mg.platform_id;
  const agent = await getAgentGroup(session.agent_group_id);
  const cfg = await getContainerConfig(session.agent_group_id);
  const model = await getEffectiveModelForAgent(session.agent_group_id);
  const a: Active = {
    id: randomUUID(),
    builder: new TraceBuilder(
      {
        agent: agent?.name ?? null,
        harness: resolveProviderName(session.agent_provider, cfg?.provider),
        model: model?.model_id ?? cfg?.model ?? null,
        host: endpointHost(model?.endpoint),
      },
      at,
    ),
    roomId,
    threadId: await sessionKeyToThread(session.thread_id, roomId),
    agentGroupId: session.agent_group_id,
    agentName: agent?.name ?? null,
    messageIds: [],
    closedAt: null,
    stored: false,
    saving: Promise.resolve(),
    personal: memberUserFromKey(session.thread_id) !== null,
  };
  active.set(session.id, a);
  for (const r of held.get(session.id) ?? []) link(a, r.messageId, r.failureNotice, r.roomId, r.at);
  held.delete(session.id);
  // The live bubble's harness · model · host line; status frames don't carry it.
  const meta = a.builder.build();
  await broadcast(roomId, {
    type: 'turn_meta',
    room_id: roomId,
    agent_name: a.agentName,
    harness: meta.harness,
    model: meta.model,
    host: meta.host,
  });
  return a;
}

/** Feed one status event into the session's trace. */
export async function recordStatusEvent(session: Session, ev: ObservedStatusEvent): Promise<void> {
  const at = eventTime(ev);
  let a = active.get(session.id);
  if (ev.kind === 'start') {
    // A start inside an open turn (a side query, a follow-up sub-turn) continues it.
    if (a && a.closedAt === null) return;
    active.delete(session.id);
    if (!(await openTrace(session, at))) held.delete(session.id);
    return;
  }
  if (!a || a.closedAt !== null) {
    if (ev.kind === 'done' || ev.kind === 'stalled') return;
    // Activity with no open turn: the host first saw this session mid-turn.
    a = (await openTrace(session, at)) ?? undefined;
    if (!a) return;
  }
  if (ev.kind === 'done' || ev.kind === 'stalled') {
    a.builder.end(ev.kind, at);
    a.closedAt = Date.now();
    await store(a);
    return;
  }
  a.builder.add({ kind: ev.kind, text: redact(ev.text), detail: redact(ev.detail), at });
}

/** The notice text when a delivery is the runner's failure notice (agent-runner formatter.ts FAILURE_NOTICE_FIELD), else null. */
export function failureNoticeText(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as { failureNotice?: unknown; text?: unknown };
  if (c.failureNotice !== true) return null;
  return typeof c.text === 'string' ? c.text : '';
}

/** Add a reply to a trace — when it went to the trace's own room. */
function link(
  a: Active,
  messageId: string,
  failureNotice: string | null,
  roomId: string | undefined,
  at: number,
): void {
  if (roomId !== undefined && roomId !== a.roomId) return;
  if (!a.messageIds.includes(messageId)) a.messageIds.push(messageId);
  if (failureNotice !== null) a.builder.error(redactSensitiveData(failureNotice), at);
}

/**
 * A reply this session's agent delivered to `roomId` (undefined: the
 * session's own room). `failureNotice` is the notice text when the reply is
 * the runner's failure notice for the turn.
 */
export async function recordTurnMessage(
  sessionId: string | undefined,
  messageId: string,
  failureNotice: string | null,
  roomId?: string,
): Promise<void> {
  if (!sessionId) return;
  const a = active.get(sessionId);
  if (!a) return;
  if (a.closedAt !== null && Date.now() - a.closedAt > LATE_LINK_MS) {
    active.delete(sessionId);
    return;
  }
  if (a.closedAt !== null && hasUnforwardedTurnStart(a.agentGroupId, sessionId)) {
    // The next turn has started but its 'start' is not read yet: the reply is that turn's.
    const list = held.get(sessionId) ?? [];
    list.push({ messageId, failureNotice, roomId, at: Date.now() });
    held.set(sessionId, list);
    return;
  }
  link(a, messageId, failureNotice, roomId, Date.now());
  if (a.closedAt !== null) await store(a);
}

/** Write the trace; writes of one trace run one after another, each from its state then. */
function store(a: Active): Promise<void> {
  a.saving = a.saving.then(() => write(a));
  return a.saving;
}

async function write(a: Active): Promise<void> {
  if (a.messageIds.length === 0) return; // nothing to show it on yet
  if (a.personal) return;
  const trace: TurnTrace = a.builder.build();
  const json = fitTrace(trace);
  const size = Buffer.byteLength(json, 'utf8');
  const anchor = a.messageIds[0]!;
  try {
    if (!a.stored) {
      await getDb().run(
        `INSERT INTO webchat_turn_traces
           (id, room_id, thread_id, message_id, message_ids, agent_group_id, agent_name, started_at, ended_at,
            outcome, provider, model, endpoint_host, trace_json, size)
         VALUES (@id, @room_id, @thread_id, @message_id, @message_ids, @agent_group_id, @agent_name, @started_at,
            @ended_at, @outcome, @provider, @model, @endpoint_host, @trace_json, @size)
         ON CONFLICT (id) DO UPDATE SET
            message_ids = excluded.message_ids, ended_at = excluded.ended_at, outcome = excluded.outcome,
            trace_json = excluded.trace_json, size = excluded.size`,
        {
          id: a.id,
          room_id: a.roomId,
          thread_id: a.threadId,
          message_id: anchor,
          message_ids: JSON.stringify(a.messageIds),
          agent_group_id: a.agentGroupId,
          agent_name: a.agentName,
          started_at: trace.startedAt,
          ended_at: trace.endedAt,
          outcome: trace.outcome,
          provider: trace.harness,
          model: trace.model,
          endpoint_host: trace.host,
          trace_json: json,
          size,
        },
      );
      a.stored = true;
      // Live clients learn the reply now has a stored trace (history carries has_trace).
      await broadcast(a.roomId, { type: 'trace', room_id: a.roomId, thread_id: a.threadId, message_id: anchor });
    } else {
      await getDb().run(
        `UPDATE webchat_turn_traces
            SET message_ids = @message_ids, ended_at = @ended_at, outcome = @outcome, trace_json = @trace_json, size = @size
          WHERE id = @id`,
        {
          id: a.id,
          message_ids: JSON.stringify(a.messageIds),
          ended_at: trace.endedAt,
          outcome: trace.outcome,
          trace_json: json,
          size,
        },
      );
    }
  } catch (err) {
    log.warn('Turn trace not stored', { roomId: a.roomId, err: String(err) });
  }
}

export interface StoredTurnTrace {
  id: string;
  room_id: string;
  thread_id: string;
  message_id: string;
  message_ids: string[];
  trace: TurnTrace;
}

/** The trace a message belongs to: the turn it anchors, else one that lists it. */
export async function getTraceForMessage(roomId: string, messageId: string): Promise<StoredTurnTrace | null> {
  const db = getDb();
  type Row = {
    id: string;
    room_id: string;
    thread_id: string;
    message_id: string;
    message_ids: string;
    trace_json: string;
  };
  let row = (await db.get(
    `SELECT id, room_id, thread_id, message_id, message_ids, trace_json FROM webchat_turn_traces
      WHERE message_id = ? AND room_id = ?`,
    messageId,
    roomId,
  )) as Row | undefined;
  // Ids are UUIDs, so the quoted LIKE cannot match a substring of another id.
  row ??= (await db.get(
    `SELECT id, room_id, thread_id, message_id, message_ids, trace_json FROM webchat_turn_traces
      WHERE room_id = ? AND message_ids LIKE ? LIMIT 1`,
    roomId,
    `%"${messageId}"%`,
  )) as Row | undefined;
  if (!row) return null;
  return {
    id: row.id,
    room_id: row.room_id,
    thread_id: row.thread_id,
    message_id: row.message_id,
    message_ids: JSON.parse(row.message_ids) as string[],
    trace: JSON.parse(row.trace_json) as TurnTrace,
  };
}

/** The room a stored message belongs to, or null when there is no such message. */
export async function getMessageRoomId(messageId: string): Promise<string | null> {
  const row = (await getDb().get(`SELECT room_id FROM webchat_messages WHERE id = ?`, messageId)) as
    | { room_id: string }
    | undefined;
  return row?.room_id ?? null;
}

/** Mark the messages that anchor a stored trace (`has_trace: true`), for history payloads. */
export async function withTraceFlags<T extends { id: string }>(messages: T[]): Promise<(T & { has_trace?: true })[]> {
  if (messages.length === 0) return messages;
  let anchors: Set<string>;
  try {
    // Only an anchor in the trace's own room: getTraceForMessage looks there, so a
    // flag on a message elsewhere would offer Thoughts that never load.
    const rows = (await getDb().all(
      `SELECT t.message_id FROM webchat_turn_traces t
         JOIN webchat_messages m ON m.id = t.message_id AND m.room_id = t.room_id
        WHERE t.message_id IN (${messages.map(() => '?').join(',')})`,
      ...messages.map((m) => m.id),
    )) as { message_id: string }[];
    anchors = new Set(rows.map((r) => r.message_id));
  } catch {
    return messages; // table absent (not migrated yet) — no traces to flag
  }
  if (anchors.size === 0) return messages;
  return messages.map((m) => (anchors.has(m.id) ? { ...m, has_trace: true as const } : m));
}

/** Drop traces past the retention setting (0 = keep forever). Returns rows removed. */
export async function pruneTurnTraces(now = Date.now()): Promise<number> {
  const days = await getTurnTraceDays();
  if (days === 0) return 0;
  if (!(await hasTable(getDb(), 'webchat_turn_traces'))) return 0;
  const res = (await getDb().run(`DELETE FROM webchat_turn_traces WHERE started_at < ?`, now - days * DAY_MS)) as
    | { changes?: number }
    | undefined;
  return res?.changes ?? 0;
}

/** Forget in-memory turns whose late-link window or open lifetime is over. */
export function pruneActiveTraces(now = Date.now()): void {
  elsewhere.clear();
  for (const [sessionId, a] of active) {
    const stale = a.closedAt !== null ? now - a.closedAt > LATE_LINK_MS : now - a.builder.startedAt > OPEN_MAX_MS;
    if (stale) active.delete(sessionId);
  }
  for (const [sessionId, list] of held) {
    if (list.every((r) => now - r.at > LATE_LINK_MS)) held.delete(sessionId);
  }
}

/** Test seam: drop every in-memory turn. */
export function resetActiveTraces(): void {
  active.clear();
  held.clear();
  elsewhere.clear();
}

registerStatusEventObserver(recordStatusEvent);
registerModuleSweep(
  'webchat-turn-traces',
  async () => {
    pruneActiveTraces();
    await pruneTurnTraces();
  },
  60 * 60 * 1000,
);
