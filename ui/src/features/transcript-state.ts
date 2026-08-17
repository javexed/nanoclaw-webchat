// ── Transcript state ────────────────────────────────────────────────────────
// The message list the transcript renders, and the live thinking turns beneath
// it.
//
// This is the one surface in the conversion that could not be sliced. Every
// other island owned a container nothing else wrote to; #messages had ten
// writers across six modules, and the moment a component mounts on it Vue owns
// its children — so a partial conversion IS the two-writers bug. They moved
// together, which is why this module carries more than a bridge ref.
//
// Rows are VIEW MODELS built once at append time, not raw server messages.
// That is deliberate: appendMessage decided several things from transient state
// that is gone by the time a re-render happens — whether the sender was me,
// which reasoning log to fold onto the reply, what the a2a payload parsed to.
// Deciding again later would give a different answer.
import { ref } from 'vue';

/** Monotonic row key. Server ids are absent on the optimistic echo and on
 *  system lines, so identity cannot come from the payload. */
let seq = 0;
export const nextKey = (): number => ++seq;

export interface MsgRow {
  key: number;
  kind: 'msg' | 'system' | 'divider' | 'approval' | 'draft';
  /** Server id, once known. The optimistic echo gets one when the echo lands. */
  id?: string | null;
  /**
   * Where an optimistic row was sent. Bookkeeping, not render data — set only
   * on rows held in `state.pendingMessages`, so the history handler can carry
   * them across its wipe without dragging a message sent in one room into
   * another room's transcript.
   */
  roomId?: string | null;
  threadId?: string | null;
  cls?: string;
  isMine?: boolean;
  isAgent?: boolean;
  isA2a?: boolean;
  sender?: string;
  a2aTo?: string | null;
  a2aAccent?: string;
  senderColor?: string;
  toColor?: string;
  /** Sanitised markdown, or null when the body is plain text. */
  html?: string | null;
  text?: string | null;
  file?: any;
  caption?: string | null;
  thoughts?: string[] | null;
  ttsText?: string | null;
  timeStr?: string;
  timeTitle?: string;
  /** '✓' while in flight, '✓✓' once the server echoes it. */
  status?: string | null;
  /** Own messages always get the .msg-body row — see appendMessage's note. */
  body?: boolean;
  /** The approval/draft payloads are handed to their existing islands. */
  payload?: any;
  approvalState?: 'resolved' | 'eligible' | 'awaiting';
  note?: string;
}

/** The transcript, oldest first. Prepends (pagination) unshift. */
export const messages = ref<MsgRow[]>([]);

/** Replaces the whole list — room switch, history load, clear. */
export function setMessages(rows: MsgRow[]): void {
  messages.value = rows;
}

/**
 * Put an EXISTING row back in the list and return the reactive proxy for it.
 *
 * Only the history handler needs this, and only for optimistic rows: a message
 * sent between the join and the history reply is not in that payload, because
 * the server queried before it existed. Re-appending the original object (not a
 * copy) is what keeps the echo working — the echo upgrades the row it was
 * handed, so the caller must also repoint at the returned proxy; mutating the
 * raw object notifies nothing.
 */
export function readdRow(row: MsgRow): MsgRow {
  messages.value = [...messages.value, row];
  return messages.value[messages.value.length - 1];
}

/** Empty-state line shown instead of the list. Two callers set it. */
export const transcriptEmpty = ref<string | null>(null);

export interface ThinkingTurn {
  /** Agent name — one bubble per agent, as dataset.agent was. */
  name: string;
  startedAt: number;
  lastActivityAt: number;
  verb: string;
  detail: string | null;
  milestone: string | null;
  /** Every reasoning line this turn, for the expanded trace and the reply's
   *  Thoughts disclosure. */
  reasoningLog: string[];
  /** The fading feed window — a bounded tail of reasoningLog with per-line
   *  fade state, which is why it is not just a slice of it. */
  feed: Array<{ key: number; text: string; fading: boolean }>;
  expanded: boolean;
  elapsed: string;
  /** Owned by an active status stream, so the typing heartbeat must not clear
   *  it during a quiet stretch. Was dataset.statusLive on the bubble. */
  statusLive: boolean;
}

/** Live thinking bubbles, keyed by agent name. Rendered AFTER the message list,
 *  which is what made messages "insert before the thinking bubble" fall out for
 *  free instead of needing an anchor. */
export const thinkingTurns = ref<ThinkingTurn[]>([]);

export const turnFor = (name: string): ThinkingTurn | undefined =>
  thinkingTurns.value.find((t) => t.name === name);
