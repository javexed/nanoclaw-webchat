/**
 * `ncl tasks` additions, layered onto the core resource without editing it:
 *
 *   tasks fail   — a task run declares itself failed, with a reason. The run is
 *                  logged as failed and counts toward the task's incident.
 *   tasks get    — gains a `health` block: incident, last classified run, and
 *                  a pending start retry.
 *   tasks cancel — also closes the series' open incident.
 *   tasks delete — also forgets the series' health records.
 *
 * Installed at host start, after the CLI barrel has registered the `tasks`
 * resource and before the socket server accepts a connection. Idempotent.
 */
import fs from 'fs';

import { normalizeArgs } from '../../cli/args.js';
import { getResource, validateArgs, type CustomOperation } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { register } from '../../cli/registry.js';
import { getSession, isTaskThread } from '../../db/sessions.js';
import { openInboundDb, openOutboundDb, outboundDbPath } from '../../session-db-access.js';
import { appendRunLog } from '../scheduling/run-log.js';
import { START_RETRY_DELAYS_MIN } from './policy.js';
import { closeIncident, forgetSeries, getIncident, pendingRetry, recentRuns, upsertRun } from './store.js';

const REASON_MAX = 300;

/** The occurrence row a task session is running right now, if any. */
function inFlightTaskRow(agentGroupId: string, sessionId: string): { id: string; seriesId: string } | null {
  if (!fs.existsSync(outboundDbPath(agentGroupId, sessionId))) return null;
  const out = openOutboundDb(agentGroupId, sessionId);
  let claimed: string[];
  try {
    claimed = (
      out.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
        message_id: string;
      }>
    ).map((r) => r.message_id);
  } finally {
    out.close();
  }
  if (claimed.length === 0) return null;
  const inbound = openInboundDb(agentGroupId, sessionId);
  try {
    const find = inbound.prepare("SELECT id, series_id FROM messages_in WHERE id = ? AND kind = 'task'");
    for (const id of claimed) {
      const row = find.get(id) as { id: string; series_id: string | null } | undefined;
      if (row) return { id: row.id, seriesId: row.series_id ?? row.id };
    }
    return null;
  } finally {
    inbound.close();
  }
}

export async function declareRunFailed(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ series_id: string; row_id: string; failed: true }> {
  const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
  if (!reason) throw new Error('--reason is required');
  if (ctx.caller !== 'agent') throw new Error('only a running task can mark its own run failed');
  const session = await getSession(ctx.sessionId);
  if (!session || !isTaskThread(session.thread_id)) {
    throw new Error('not inside a task run — `ncl tasks fail` marks the current task run failed');
  }
  const row = inFlightTaskRow(session.agent_group_id, session.id);
  if (!row) throw new Error('no task run is in progress in this session');
  await upsertRun(
    { row_id: row.id, series_id: row.seriesId, agent_group_id: session.agent_group_id, session_id: session.id },
    { declared_reason: reason },
  );
  await appendRunLog(session.agent_group_id, row.seriesId, `run marked failed by the agent: ${reason}`);
  return { series_id: row.seriesId, row_id: row.id, failed: true };
}

/** Task statuses after which the series never runs again (a finished one-shot, or cancelled). */
const ENDED = new Set(['completed', 'failed', 'cancelled']);

/**
 * The `health` block `ncl tasks get` carries. A task that has ended closes
 * its open incident: nothing will run to recover it, so it is not "failing",
 * and its last run says how it ended.
 */
export async function seriesHealth(seriesId: string, taskStatus?: unknown) {
  const ended = typeof taskStatus === 'string' && ENDED.has(taskStatus);
  if (ended) await closeIncident(seriesId, new Date().toISOString());
  const incident = await getIncident(seriesId);
  const [last] = await recentRuns(seriesId, 1);
  const retry = await pendingRetry(seriesId);
  const failing = incident?.state === 'open';
  return {
    state: failing ? 'failing' : ended && last?.outcome === 'failed' ? 'failed' : last ? 'ok' : 'unknown',
    incident: incident
      ? {
          state: incident.state,
          signature: incident.signature,
          reason: incident.reason,
          failures: incident.failures,
          opened_at: incident.opened_at,
          last_failure_at: incident.last_failure_at,
          last_alert_at: incident.last_alert_at,
          closed_at: incident.closed_at,
        }
      : null,
    last_run: last
      ? {
          row_id: last.row_id,
          outcome: last.outcome,
          signature: last.signature,
          reason: last.reason,
          at: last.finished_at,
        }
      : null,
    start_retry: retry
      ? {
          row_id: retry.row_id,
          attempt: retry.start_failures,
          of: START_RETRY_DELAYS_MIN.length,
          next_at: retry.next_retry_at,
          reason: retry.last_error,
        }
      : null,
  };
}

const FAIL_OP: CustomOperation = {
  access: 'open',
  description:
    "Mark the current task run failed, with a reason. Use it when the run cannot do what the task asks (a source is down, access is missing, the result is wrong). The run is logged as failed and the task's owner is alerted once per incident, so you need not message them about it. Only from inside a task run.",
  args: [
    {
      name: 'reason',
      type: 'string',
      description: 'One line: what failed. Shown to the task owner and written to the run log.',
      required: true,
    },
  ],
  examples: [`ncl tasks fail --reason "sales API returned 503 for every region"`],
  handler: async (args, ctx) => declareRunFailed(args, ctx),
};

let installed = false;

/** Layer the additions onto the registered `tasks` resource. Safe to call twice. */
export function installTaskHealthCli(): void {
  if (installed) return;
  const tasks = getResource('tasks');
  const ops = tasks?.customOperations;
  if (!tasks || !ops?.get || !ops.delete) return;
  installed = true;

  // get: same output, plus `health`. Rebinds the operation's handler — the
  // registered command calls op.handler at dispatch time, so no core line moves.
  const coreGet = ops.get.handler;
  ops.get.handler = async (args, ctx) => {
    const out = (await coreGet(args, ctx)) as Record<string, unknown>;
    const seriesId = typeof out.series_id === 'string' ? out.series_id : undefined;
    return seriesId ? { ...out, health: await seriesHealth(seriesId, out.status) } : out;
  };

  // cancel: a cancelled task never runs again, so its incident closes.
  const coreCancel = ops.cancel?.handler;
  if (ops.cancel && coreCancel) {
    ops.cancel.handler = async (args, ctx) => {
      const out = (await coreCancel(args, ctx)) as { series_id?: string };
      if (out.series_id) await closeIncident(out.series_id, new Date().toISOString());
      return out;
    };
  }

  const coreDelete = ops.delete.handler;
  ops.delete.handler = async (args, ctx) => {
    const out = (await coreDelete(args, ctx)) as { series_id?: string };
    if (out.series_id) await forgetSeries(out.series_id);
    return out;
  };

  ops.fail = FAIL_OP;
  register({
    name: 'tasks-fail',
    action: 'tasks.fail',
    description: FAIL_OP.description,
    access: FAIL_OP.access,
    resource: 'tasks',
    parseArgs: (raw) => validateArgs(FAIL_OP.args!, normalizeArgs(raw)),
    handler: async (args, ctx) => FAIL_OP.handler(args as Record<string, unknown>, ctx),
  });
}
