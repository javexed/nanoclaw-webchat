/**
 * Restart an agent group's containers once none of them is mid-turn.
 *
 * Follow-up messages are acked as they are pushed into a live query, so a kill
 * mid-turn loses them along with the turn's reply. A change that only has to
 * reach the next spawn (a kept or edited skill) waits for the turn instead; a
 * group still busy after MAX_WAIT_MS is restarted anyway, and one whose
 * containers all exit meanwhile needs no restart — the next spawn sees it.
 */
import fs from 'fs';

import { restartAgentGroupContainers } from './container-restart.js';
import { isContainerRunning } from './container-runner.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { openOutboundDb } from './session-db-access.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';

const POLL_MS = 5_000;
const MAX_WAIT_MS = 30 * 60 * 1000;
// A follow-up queued behind a finished turn leaves no claim and a closed status
// feed until its answer starts; recent provider activity covers that gap.
const QUIET_MS = 30_000;

/** Groups with a deferred restart queued, and the reasons it carries. */
const deferred = new Map<string, Set<string>>();

/**
 * Is a turn in progress? Open processing claims (a batch being answered), a
 * status feed whose last event is not 'done' (a pushed follow-up), or provider
 * activity within QUIET_MS.
 */
export function sessionInTurn(s: { claims: number; lastStatusKind: string | null; heartbeatAgeMs: number }): boolean {
  if (s.claims > 0) return true;
  if (s.lastStatusKind !== null && s.lastStatusKind !== 'done') return true;
  return s.heartbeatAgeMs < QUIET_MS;
}

function lastStatusKind(agentGroupId: string, sessionId: string): string | null {
  let db: ReturnType<typeof openOutboundDb> | undefined;
  try {
    db = openOutboundDb(agentGroupId, sessionId);
    const row = db.prepare('SELECT kind FROM status_events ORDER BY seq DESC LIMIT 1').get() as
      | { kind: string }
      | undefined;
    return row?.kind ?? null;
  } catch {
    return null; // no feed table yet: nothing to say
  } finally {
    db?.close();
  }
}

function heartbeatAgeMs(agentGroupId: string, sessionId: string): number {
  try {
    return Date.now() - fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** Running containers of the group, and how many of them are mid-turn. */
async function load(agentGroupId: string): Promise<{ running: number; busy: number }> {
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );
  let busy = 0;
  for (const s of sessions) {
    const claims =
      (await withExistingMailboxSession(agentGroupId, s.id, (mailbox) => mailbox.getProcessingClaims().length)) ?? 0;
    const inTurn = sessionInTurn({
      claims,
      lastStatusKind: lastStatusKind(agentGroupId, s.id),
      heartbeatAgeMs: heartbeatAgeMs(agentGroupId, s.id),
    });
    if (inTurn) busy++;
  }
  return { running: sessions.length, busy };
}

/**
 * Same contract as `restartAgentGroupContainers` — resolves to the number of
 * running containers that are (or will be) restarted — but a group with a turn
 * in progress is restarted when that turn ends rather than now.
 */
export async function restartAgentGroupContainersWhenIdle(agentGroupId: string, reason: string): Promise<number> {
  const queued = deferred.get(agentGroupId);
  let state: { running: number; busy: number };
  try {
    state = await load(agentGroupId);
  } catch (err) {
    log.warn('Turn check failed; restarting now', { agentGroupId, reason, err });
    return restartAgentGroupContainers(agentGroupId, reason);
  }
  if (queued) {
    queued.add(reason);
    return state.running;
  }
  if (state.busy === 0) return restartAgentGroupContainers(agentGroupId, reason);

  deferred.set(agentGroupId, new Set([reason]));
  log.info('Deferring agent group restart until the current turn ends', { agentGroupId, reason, busy: state.busy });
  const since = Date.now();
  const tick = (): void => {
    void (async () => {
      let now: { running: number; busy: number } | null = null;
      try {
        now = await load(agentGroupId);
      } catch (err) {
        log.warn('Turn check failed; restarting now', { agentGroupId, err });
      }
      if (now && now.busy > 0 && Date.now() - since < MAX_WAIT_MS) {
        setTimeout(tick, POLL_MS).unref?.();
        return;
      }
      const reasons = [...(deferred.get(agentGroupId) ?? [reason])].join('; ');
      deferred.delete(agentGroupId);
      if (now && now.running === 0) return;
      await restartAgentGroupContainers(agentGroupId, reasons);
    })().catch((err: unknown) => {
      deferred.delete(agentGroupId);
      log.error('Deferred agent group restart failed', { agentGroupId, err });
    });
  };
  setTimeout(tick, POLL_MS).unref?.();
  return state.running;
}

/**
 * An approved model switch an agent asked for (`ncl groups config update
 * --model`): the group restarts on the new model once its turn ends, rather
 * than mid-turn. A kill mid-turn loses the reply, and the message that asked
 * for the switch is re-delivered to the fresh container — which may ask again.
 * Resolves to the note for the caller, or null when the model is unchanged
 * and nothing restarts.
 */
export async function restartForModelSwitch(
  agentGroupId: string,
  before: string | null | undefined,
  after: string | null | undefined,
): Promise<string | null> {
  if ((before ?? '') === (after ?? '')) return null;
  await restartAgentGroupContainersWhenIdle(agentGroupId, 'model switched via ncl');
  return 'switching to the new model once the current turn ends; no `ncl groups restart` needed';
}

/** Test seam: is a restart queued for this group? */
export function _hasDeferredRestartForTesting(agentGroupId: string): boolean {
  return deferred.has(agentGroupId);
}

/** Test seam: forget queued restarts (their timers are the caller's to clear). */
export function _resetDeferredRestartsForTesting(): void {
  deferred.clear();
}
