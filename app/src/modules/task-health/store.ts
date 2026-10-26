/**
 * Central-DB state for scheduled-task failure handling: per-occurrence run
 * records (`task_runs`) and per-series incidents (`task_incidents`). Schema in
 * src/db/migrations/module-task-health.ts.
 */
import { getDb } from '../../db/connection.js';

export type RunOutcome = 'ok' | 'failed' | 'skipped';

export interface TaskRunRow {
  row_id: string;
  series_id: string;
  agent_group_id: string;
  session_id: string;
  start_failures: number;
  tries_seen: number;
  waiting_since: string | null;
  waiting_seen_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  declared_reason: string | null;
  outcome: RunOutcome | null;
  signature: string | null;
  reason: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TaskIncidentRow {
  series_id: string;
  agent_group_id: string;
  state: 'open' | 'closed';
  signature: string;
  reason: string | null;
  failures: number;
  opened_at: string;
  last_failure_at: string;
  last_alert_at: string | null;
  closed_at: string | null;
}

export interface RunKey {
  row_id: string;
  series_id: string;
  agent_group_id: string;
  session_id: string;
}

export async function getRun(rowId: string): Promise<TaskRunRow | undefined> {
  return getDb().get<TaskRunRow>('SELECT * FROM task_runs WHERE row_id = ?', rowId);
}

/** Every run record of one task session, keyed by occurrence row id. */
export async function runsForSession(sessionId: string): Promise<Map<string, TaskRunRow>> {
  const rows = await getDb().all<TaskRunRow>('SELECT * FROM task_runs WHERE session_id = ?', sessionId);
  return new Map(rows.map((r) => [r.row_id, r]));
}

/** Insert the run if new, then apply `fields`. Returns the stored row. */
export async function upsertRun(key: RunKey, fields: Partial<Omit<TaskRunRow, keyof RunKey>>): Promise<TaskRunRow> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO task_runs (row_id, series_id, agent_group_id, session_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(row_id) DO NOTHING`,
    key.row_id,
    key.series_id,
    key.agent_group_id,
    key.session_id,
    now,
  );
  const cols = Object.keys(fields) as Array<keyof typeof fields>;
  if (cols.length > 0) {
    await getDb().run(
      `UPDATE task_runs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE row_id = ?`,
      ...cols.map((c) => fields[c] ?? null),
      now,
      key.row_id,
    );
  }
  return (await getRun(key.row_id))!;
}

/** Most recent finished runs of a series, newest first. */
export async function recentRuns(seriesId: string, limit = 5): Promise<TaskRunRow[]> {
  return getDb().all<TaskRunRow>(
    `SELECT * FROM task_runs WHERE series_id = ? AND outcome IS NOT NULL ORDER BY finished_at DESC LIMIT ?`,
    seriesId,
    limit,
  );
}

/** The run currently waiting on a start retry, if any. */
export async function pendingRetry(seriesId: string): Promise<TaskRunRow | undefined> {
  return getDb().get<TaskRunRow>(
    `SELECT * FROM task_runs WHERE series_id = ? AND outcome IS NULL AND next_retry_at IS NOT NULL
      ORDER BY next_retry_at DESC LIMIT 1`,
    seriesId,
  );
}

export async function getIncident(seriesId: string): Promise<TaskIncidentRow | undefined> {
  return getDb().get<TaskIncidentRow>('SELECT * FROM task_incidents WHERE series_id = ?', seriesId);
}

export async function saveIncident(row: TaskIncidentRow): Promise<void> {
  await getDb().run(
    `INSERT INTO task_incidents
       (series_id, agent_group_id, state, signature, reason, failures, opened_at, last_failure_at, last_alert_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       agent_group_id = excluded.agent_group_id, state = excluded.state, signature = excluded.signature,
       reason = excluded.reason, failures = excluded.failures, opened_at = excluded.opened_at,
       last_failure_at = excluded.last_failure_at, last_alert_at = excluded.last_alert_at,
       closed_at = excluded.closed_at`,
    row.series_id,
    row.agent_group_id,
    row.state,
    row.signature,
    row.reason,
    row.failures,
    row.opened_at,
    row.last_failure_at,
    row.last_alert_at,
    row.closed_at,
  );
}

/** Forget a series entirely (the task was deleted). */
export async function forgetSeries(seriesId: string): Promise<void> {
  await getDb().run('DELETE FROM task_runs WHERE series_id = ?', seriesId);
  await getDb().run('DELETE FROM task_incidents WHERE series_id = ?', seriesId);
}

/** Close a series' open incident without a recovery: the task will not run again. */
export async function closeIncident(seriesId: string, at: string): Promise<void> {
  await getDb().run(
    `UPDATE task_incidents SET state = 'closed', closed_at = ? WHERE series_id = ? AND state = 'open'`,
    at,
    seriesId,
  );
}

/**
 * Drop run records older than `before` (ISO). Incidents are kept. A run that
 * never finished (its session or task went away mid-run) is dropped once it
 * has not changed since then, or it would be kept forever.
 */
export async function pruneFinishedRuns(before: string): Promise<void> {
  await getDb().run('DELETE FROM task_runs WHERE outcome IS NOT NULL AND finished_at < ?', before);
  await getDb().run('DELETE FROM task_runs WHERE outcome IS NULL AND updated_at < ?', before);
}
