import type { Migration } from './index.js';

/**
 * Scheduled-task failure handling (src/modules/task-health).
 *
 *   task_runs      — one row per task occurrence the policy has looked at:
 *                    start-failure retries, an agent-declared failure, and the
 *                    run's final classification once it ends.
 *   task_incidents — one row per task series: the current (or last) failure
 *                    incident, so consecutive failures alert once, remind on a
 *                    timer, and announce recovery.
 *
 * No foreign keys: rows outlive nothing they point at for long (finished runs
 * are pruned, and `ncl tasks delete` clears both tables for its series), and a
 * reference to agent_groups would drag these tables into every agent-delete
 * cascade for state that is purely advisory.
 */
export const moduleTaskHealth: Migration = {
  version: 226,
  name: 'task-health',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        row_id          TEXT PRIMARY KEY,
        series_id       TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        start_failures  INTEGER NOT NULL DEFAULT 0,
        tries_seen      INTEGER NOT NULL DEFAULT 0,
        waiting_since   TEXT,
        waiting_seen_at TEXT,
        next_retry_at   TEXT,
        last_error      TEXT,
        declared_reason TEXT,
        outcome         TEXT,
        signature       TEXT,
        reason          TEXT,
        finished_at     TEXT,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_series ON task_runs (series_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs (session_id, outcome);
      CREATE TABLE IF NOT EXISTS task_incidents (
        series_id       TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL,
        state           TEXT NOT NULL,
        signature       TEXT NOT NULL,
        reason          TEXT,
        failures        INTEGER NOT NULL,
        opened_at       TEXT NOT NULL,
        last_failure_at TEXT NOT NULL,
        last_alert_at   TEXT,
        closed_at       TEXT
      );
    `);
  },
};
