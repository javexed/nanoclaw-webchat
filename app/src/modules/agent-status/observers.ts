/**
 * Status-event observers: who else sees the events agent-status forwards (the
 * webchat turn recorder). A leaf so an observer can register without loading
 * the forwarder and everything it imports.
 */
import type { AgentActivityStatus } from '../../seam/index.js';
import type { Session } from '../../types.js';

/** One status event as observers see it: raw (unredacted) text, plus when the
 *  container wrote it (ISO; null for host-generated events). */
export interface ObservedStatusEvent {
  kind: AgentActivityStatus['kind'];
  text: string | null;
  detail: string | null;
  createdAt: string | null;
}

type StatusEventObserver = (session: Session, ev: ObservedStatusEvent) => void | Promise<void>;
const statusObservers: StatusEventObserver[] = [];

/** Watch every status event agent-status forwards (and the host's 'stalled'), per session. */
export function registerStatusEventObserver(fn: StatusEventObserver): void {
  statusObservers.push(fn);
}

export async function notifyStatusObservers(session: Session, ev: ObservedStatusEvent): Promise<void> {
  for (const fn of statusObservers) {
    try {
      await fn(session, ev);
    } catch {
      // An observer must never break the feed.
    }
  }
}

type UnforwardedStartCheck = (agentGroupId: string, sessionId: string) => boolean;
let unforwardedStart: UnforwardedStartCheck = () => false;

/** The forwarder answers whether a session's feed holds a 'start' it has yet to forward. */
export function registerUnforwardedStartCheck(fn: UnforwardedStartCheck): void {
  unforwardedStart = fn;
}

/**
 * Has this session begun a turn observers have not heard about yet? Replies
 * are delivered before the same tick forwards the feed, so a short turn's
 * reply can arrive ahead of its own 'start'. Best-effort: false when unknown.
 */
export function hasUnforwardedTurnStart(agentGroupId: string, sessionId: string): boolean {
  try {
    return unforwardedStart(agentGroupId, sessionId);
  } catch {
    return false;
  }
}
