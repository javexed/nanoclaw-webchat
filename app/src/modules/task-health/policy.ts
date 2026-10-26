/**
 * The task-run failure policy, run for each task session at the top of every
 * reconcile pass — BEFORE the pass decides whether due messages need a
 * container. That ordering is the point: a run that died is still `pending`,
 * so without a verdict first the wake below would simply run it again.
 *
 * Per occurrence row:
 *
 *   - Reached the model, then did not finish (the container exited or was
 *     killed mid-run): failed, never re-run. Whatever the first attempt did —
 *     a message sent, a file written — a second attempt could do again.
 *
 *   - Never reached the model (the container could not start, or exited
 *     before its first query): retried at +5, +15 and +30 minutes, then given
 *     up for that slot. A recurring task's next slot is armed as usual.
 *
 *   - Finished: classified once — ok, failed (model error, declared failed by
 *     the agent, broken pre-task script, abandoned after stalling), or
 *     skipped (a script gate decided there was nothing to do) — and folded
 *     into the series' incident (see incidents.ts).
 *
 * "Reached the model" comes from the container's task_run_marks table
 * (container/agent-runner/src/task-run-marks.ts). An agent-runner too old to
 * write it gets no mid-run verdicts: dead claims are left to core's own retry,
 * exactly as before.
 *
 * A missed slot needs nothing here: an occurrence that came due while the host
 * was down is one pending row, it fires once on return, and the next slot is
 * computed from the cron grid relative to now — no catch-up burst.
 */
import fs from 'fs';

import type Database from 'better-sqlite3';

import { isContainerRunning } from '../../container-runner.js';
import { isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { parseTaskContent } from '../scheduling/task-content.js';
import { appendRunLog } from '../scheduling/run-log.js';
import { inboundDbPath, openInboundDb, openOutboundDb, outboundDbPath } from '../../session-db-access.js';
import type { Session } from '../../types.js';
import { recordVerdict, type Alert, type RunVerdict } from './incidents.js';
import { sendAlert } from './notify.js';
import { runsForSession, upsertRun, type RunKey, type TaskRunRow } from './store.js';

/** Minutes to wait before each retry of a run that never reached the model. */
export const START_RETRY_DELAYS_MIN = [5, 15, 30];

/** How long a due run may sit unclaimed with no container before it counts as failing to start. */
export const START_GRACE_MS = 3 * 60_000;

/** A gap in observation longer than this (host down) restarts the start-grace clock. */
const OBSERVATION_GAP_MS = 5 * 60_000;

const REASON_MAX = 300;

export const REASON = {
  notStarted: 'the agent container could not start',
  diedBeforeQuery: 'the agent container exited before the run started',
  interrupted: 'the run stopped before it finished (the agent container exited)',
  script: 'the pre-task script failed (error, timeout, or no JSON verdict)',
  stalled: 'the run kept stalling and was abandoned',
  modelError: 'the run ended with an error',
} as const;

export interface PolicyDeps {
  now: () => number;
  isRunning: (sessionId: string) => boolean;
  appendLog: (agentGroupId: string, seriesId: string, line: string) => Promise<void>;
  notify: (alert: Alert, agentGroupId: string, originSessionId: string | null) => Promise<boolean>;
}

const defaultDeps: PolicyDeps = {
  now: () => Date.now(),
  isRunning: (id) => isContainerRunning(id),
  appendLog: async (group, series, line) => {
    try {
      await appendRunLog(group, series, line);
    } catch (err) {
      log.warn('Could not append task-health note to run log', { group, series, err: String(err) });
    }
  },
  notify: sendAlert,
};

interface InboundTaskRow {
  id: string;
  series_id: string | null;
  status: string;
  process_after: string | null;
  tries: number;
  content: string;
  seq: number;
}

interface Mark {
  reached_at: string | null;
  outcome: string | null;
  reason: string | null;
}

/** Parse a stored timestamp; zone-less SQLite stamps are UTC. */
export function parseStamp(s: string | null): number {
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

function clip(s: string | null | undefined): string | null {
  if (!s) return null;
  const one = s.replace(/\s+/g, ' ').trim();
  return one ? one.slice(0, REASON_MAX) : null;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function readOutbound(
  agentGroupId: string,
  sessionId: string,
): { acks: Map<string, string>; marks: Map<string, Mark> | null } {
  const acks = new Map<string, string>();
  const path = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(path)) return { acks, marks: null };
  const db = openOutboundDb(agentGroupId, sessionId);
  try {
    if (tableExists(db, 'processing_ack')) {
      for (const r of db.prepare('SELECT message_id, status FROM processing_ack').all() as Array<{
        message_id: string;
        status: string;
      }>)
        acks.set(r.message_id, r.status);
    }
    if (!tableExists(db, 'task_run_marks')) return { acks, marks: null };
    const marks = new Map<string, Mark>();
    for (const r of db.prepare('SELECT message_id, reached_at, outcome, reason FROM task_run_marks').all() as Array<
      Mark & { message_id: string }
    >)
      marks.set(r.message_id, r);
    return { acks, marks };
  } finally {
    db.close();
  }
}

/**
 * Final verdict for a finished occurrence. `marksKnown` is false only for a
 * session whose agent-runner never created task_run_marks (it predates them):
 * then a completed run cannot be told from a script-gated one, and counts ok.
 */
function verdictForFinished(
  row: InboundTaskRow,
  run: TaskRunRow,
  ack: string | undefined,
  mark: Mark | undefined,
  marksKnown: boolean,
): RunVerdict | { outcome: 'skipped' } {
  if (row.status === 'failed') {
    if (ack === 'script-skip:error') return { outcome: 'failed', signature: 'script', reason: REASON.script };
    return { outcome: 'failed', signature: 'stalled', reason: REASON.stalled };
  }
  if (run.declared_reason) return { outcome: 'failed', signature: 'agent-declared', reason: run.declared_reason };
  if (mark?.outcome === 'error') {
    return { outcome: 'failed', signature: 'model-error', reason: clip(mark.reason) ?? REASON.modelError };
  }
  if (mark?.reached_at || !marksKnown) return { outcome: 'ok' };
  // Completed without ever reaching the model: a script gate's "nothing to do".
  return { outcome: 'skipped' };
}

/** The row's status once core applies its ack (mirrors core's applyProcessingAcks). */
function effectiveStatus(status: string, ack: string | undefined): string {
  if (status !== 'pending' || !ack || ack === 'processing') return status;
  return ack === 'script-skip:error' ? 'failed' : 'completed';
}

export async function applyTaskRunPolicy(session: Session, deps: PolicyDeps = defaultDeps): Promise<void> {
  if (!isTaskThread(session.thread_id)) return;
  const agentGroupId = session.agent_group_id;
  if (!fs.existsSync(inboundDbPath(agentGroupId, session.id))) return;
  try {
    await runPolicy(session, deps);
  } catch (err) {
    log.warn('Task-run policy failed', { sessionId: session.id, err: String(err) });
  }
}

async function runPolicy(session: Session, deps: PolicyDeps): Promise<void> {
  const agentGroupId = session.agent_group_id;
  const now = deps.now();
  const nowIso = new Date(now).toISOString();
  const running = deps.isRunning(session.id);
  const { acks, marks } = readOutbound(agentGroupId, session.id);
  const runs = await runsForSession(session.id);

  const inbound = openInboundDb(agentGroupId, session.id);
  const logLines: Array<[string, string]> = [];
  const decided = new Set<string>();
  const verdicts: Array<{ row: InboundTaskRow; verdict: RunVerdict }> = [];
  try {
    const pending = inbound
      .prepare(
        `SELECT id, series_id, status, process_after, tries, content, seq FROM messages_in
          WHERE kind = 'task' AND status = 'pending' ORDER BY seq`,
      )
      .all() as InboundTaskRow[];

    const keyOf = (row: InboundTaskRow): RunKey => ({
      row_id: row.id,
      series_id: row.series_id ?? row.id,
      agent_group_id: agentGroupId,
      session_id: session.id,
    });
    const setPending = inbound.prepare(
      "UPDATE messages_in SET process_after = ?, tries = tries + 1 WHERE id = ? AND status = 'pending'",
    );
    const setFailed = inbound.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ? AND status = 'pending'");

    for (const row of pending) {
      const key = keyOf(row);
      let run = runs.get(row.id) ?? (await upsertRun(key, {}));
      const ack = acks.get(row.id);
      if (ack && ack !== 'processing') continue; // finished; core applies the ack this pass
      if (ack === 'processing' && running) {
        if (run.waiting_since) run = await upsertRun(key, { waiting_since: null, waiting_seen_at: null });
        continue; // in progress
      }
      const mark = marks?.get(row.id);

      // Reached the model and did not finish: fail it, never re-run it.
      if (mark?.reached_at) {
        setFailed.run(row.id);
        decided.add(row.id);
        await upsertRun(key, {
          outcome: 'failed',
          signature: 'interrupted',
          reason: REASON.interrupted,
          finished_at: nowIso,
          next_retry_at: null,
        });
        verdicts.push({ row, verdict: { outcome: 'failed', signature: 'interrupted', reason: REASON.interrupted } });
        logLines.push([key.series_id, `run failed: ${REASON.interrupted}; not retried, since it had already started`]);
        continue;
      }

      const dueAt = parseStamp(row.process_after);
      const scheduledLater = Number.isFinite(dueAt) && dueAt > now;
      let startFailure: string | null = null;
      if (!running && marks) {
        // A dead claim, or core's own reset (tries bumped) that we have not
        // accounted for: the container died holding the row, before a query.
        if ((ack === 'processing' && !scheduledLater) || row.tries > run.tries_seen) {
          startFailure = REASON.diedBeforeQuery;
        }
      }
      if (!startFailure && scheduledLater) continue;
      if (!startFailure && !running && !ack && Number.isFinite(dueAt)) {
        // Due, unclaimed, no container: the wake is failing. Give the sweep
        // START_GRACE_MS of attempts before calling it a failed start.
        const seen = parseStamp(run.waiting_seen_at);
        if (!run.waiting_since || !Number.isFinite(seen) || now - seen > OBSERVATION_GAP_MS) {
          await upsertRun(key, { waiting_since: nowIso, waiting_seen_at: nowIso });
          continue;
        }
        if (now - parseStamp(run.waiting_since) < START_GRACE_MS) {
          await upsertRun(key, { waiting_seen_at: nowIso });
          continue;
        }
        startFailure = REASON.notStarted;
      }
      if (!startFailure) {
        if (run.waiting_since) await upsertRun(key, { waiting_since: null, waiting_seen_at: null });
        continue;
      }

      const attempt = run.start_failures + 1;
      if (attempt <= START_RETRY_DELAYS_MIN.length) {
        const delayMin = START_RETRY_DELAYS_MIN[attempt - 1]!;
        const nextAt = new Date(now + delayMin * 60_000).toISOString();
        setPending.run(nextAt, row.id);
        await upsertRun(key, {
          start_failures: attempt,
          tries_seen: row.tries + 1,
          next_retry_at: nextAt,
          last_error: startFailure,
          waiting_since: null,
          waiting_seen_at: null,
        });
        logLines.push([
          key.series_id,
          `run did not start (${startFailure}); retry ${attempt} of ${START_RETRY_DELAYS_MIN.length} in ${delayMin} min`,
        ]);
      } else {
        setFailed.run(row.id);
        decided.add(row.id);
        const reason = `${startFailure}; gave up after ${START_RETRY_DELAYS_MIN.length} retries`;
        await upsertRun(key, {
          start_failures: attempt,
          last_error: startFailure,
          next_retry_at: null,
          outcome: 'failed',
          signature: 'not-started',
          reason,
          finished_at: nowIso,
        });
        verdicts.push({ row, verdict: { outcome: 'failed', signature: 'not-started', reason } });
        logLines.push([key.series_id, `run failed: ${reason}`]);
      }
    }

    // Finished runs the policy has followed, not yet classified. A terminal
    // ack counts as finished even before core applies it to the row later in
    // this pass: a one-shot task's session closes in that same pass, and no
    // later pass would ever see it.
    const tracked = await runsForSession(session.id);
    const open = [...tracked.values()].filter((r) => r.outcome === null && !decided.has(r.row_id));
    if (open.length > 0) {
      const byId = inbound.prepare(
        `SELECT id, series_id, status, process_after, tries, content, seq FROM messages_in
          WHERE id = ? AND kind = 'task'`,
      );
      const finished = open
        .map((r) => ({ run: r, row: byId.get(r.row_id) as InboundTaskRow | undefined }))
        .filter((x): x is { run: TaskRunRow; row: InboundTaskRow } => !!x.row)
        .map(({ run, row }) => ({ run, row: { ...row, status: effectiveStatus(row.status, acks.get(row.id)) } }))
        .filter((x) => x.row.status === 'completed' || x.row.status === 'failed')
        .sort((a, b) => a.row.seq - b.row.seq);
      for (const { run, row } of finished) {
        const verdict = verdictForFinished(row, run, acks.get(row.id), marks?.get(row.id), marks !== null);
        await upsertRun(keyOf(row), {
          outcome: verdict.outcome,
          signature: verdict.outcome === 'failed' ? verdict.signature : null,
          reason: verdict.outcome === 'failed' ? verdict.reason : null,
          finished_at: nowIso,
          next_retry_at: null,
        });
        if (verdict.outcome !== 'skipped') verdicts.push({ row, verdict });
      }
      // Rows deleted out from under a record (cancel + delete) are dropped from tracking.
    }
  } finally {
    inbound.close();
  }

  for (const [series, line] of logLines) await deps.appendLog(agentGroupId, series, line);

  for (const { row, verdict } of verdicts.sort((a, b) => a.row.seq - b.row.seq)) {
    const seriesId = row.series_id ?? row.id;
    const alert = await recordVerdict(seriesId, agentGroupId, verdict, new Date(now));
    if (!alert) continue;
    const origin = parseTaskContent(row.content).originSessionId;
    const sent = await deps.notify(alert, agentGroupId, origin);
    const what =
      alert.kind === 'opened'
        ? 'failure alert'
        : alert.kind === 'reminder'
          ? 'still-failing reminder'
          : 'recovery notice';
    await deps.appendLog(
      agentGroupId,
      seriesId,
      sent ? `${what} sent to the task owner` : `${what} could not be delivered`,
    );
  }
}
