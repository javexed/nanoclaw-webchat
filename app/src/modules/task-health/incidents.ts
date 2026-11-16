/**
 * One alert per incident.
 *
 * Consecutive failed runs of a task that share a failure signature are one
 * incident: the first failure tells the task's owner, later ones stay quiet
 * except for a reminder once the reminder interval has passed since the last
 * alert, and the first successful run after it closes the incident with a
 * recovery notice. A failure with a DIFFERENT signature is a different
 * problem, so it starts a fresh incident (and alerts) rather than hiding
 * behind the old one. Runs that never reached the model by design (a script
 * gate said "nothing to do") neither open nor close an incident.
 *
 * However the runs fall (ok/failed flapping, a new signature each time), a
 * task raises at most one failure alert per ALERT_MIN_GAP_MS; a recovery
 * notice goes out only for an incident whose failure alert did.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { getIncident, saveIncident, type TaskIncidentRow } from './store.js';

export const DEFAULT_REMINDER_HOURS = 24;

/** Parse a reminder interval in hours; anything but a positive number falls back to the default. */
export function reminderHours(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_REMINDER_HOURS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn('Ignoring NANOCLAW_TASK_ALERT_REMINDER_HOURS: expected a positive number of hours', { value });
    return DEFAULT_REMINDER_HOURS;
  }
  return n;
}

let configured: number | undefined;
/** The operator's interval (NANOCLAW_TASK_ALERT_REMINDER_HOURS, process env over .env), read once. */
function configuredReminderHours(): number {
  configured ??= reminderHours(
    process.env.NANOCLAW_TASK_ALERT_REMINDER_HOURS ??
      readEnvFile(['NANOCLAW_TASK_ALERT_REMINDER_HOURS']).NANOCLAW_TASK_ALERT_REMINDER_HOURS,
  );
  return configured;
}

/** Least time between two failure alerts of one task, whatever the incident. */
export const ALERT_MIN_GAP_MS = 3_600_000;

/**
 * Fixed text per failure signature, for alerts that must not carry the
 * agent's own words (approver DMs). The agent's reason stays in `ncl tasks get`.
 */
export const FAILURE_TEXT: Record<string, string> = {
  'not-started': 'the agent container could not start',
  interrupted: 'the run stopped before it finished',
  script: 'the pre-task script failed',
  stalled: 'the run kept stalling and was abandoned',
  'model-error': 'the run ended with an error',
  'agent-declared': 'the agent marked the run failed',
};

export type AlertKind = 'opened' | 'reminder' | 'recovered';

export interface Alert {
  kind: AlertKind;
  seriesId: string;
  signature: string;
  reason: string | null;
  failures: number;
  openedAt: string;
}

/**
 * The text the owner sees. Plain sentences; the task id is what `ncl tasks get`
 * takes. With `fixedText` (approver DMs) the reason is the signature's fixed
 * text, never the stored reason, which may be the agent's own words.
 */
export function alertText(
  alert: Alert,
  formatTime: (iso: string) => string,
  opts: { fixedText?: boolean } = {},
): string {
  const task = `Scheduled task ${alert.seriesId}`;
  const why = opts.fixedText
    ? `: ${FAILURE_TEXT[alert.signature] ?? 'the run failed'}. Details: ncl tasks get ${alert.seriesId}`
    : alert.reason
      ? `: ${alert.reason}`
      : '.';
  switch (alert.kind) {
    case 'opened':
      return `${task} failed${why}`;
    case 'reminder':
      return `${task} is still failing — ${alert.failures} failed runs since ${formatTime(alert.openedAt)}${why}`;
    case 'recovered':
      return `${task} is working again after ${alert.failures} failed ${alert.failures === 1 ? 'run' : 'runs'}.`;
  }
}

export type RunVerdict = { outcome: 'ok' } | { outcome: 'failed'; signature: string; reason: string | null };

/**
 * Fold one run's verdict into the series' incident and return the alert to
 * send, if any. Persists the incident before returning, so an alert that then
 * fails to deliver is not retried on every pass (one notice, not a storm).
 */
export async function recordVerdict(
  seriesId: string,
  agentGroupId: string,
  verdict: RunVerdict,
  now: Date,
  hours = configuredReminderHours(),
): Promise<Alert | null> {
  const at = now.toISOString();
  const current = await getIncident(seriesId);
  const open = current?.state === 'open' ? current : undefined;

  if (verdict.outcome === 'ok') {
    if (!open) return null;
    // Only an incident its owner heard about gets a recovery notice.
    const alerted = !!open.last_alert_at && open.last_alert_at >= open.opened_at;
    await saveIncident({ ...open, state: 'closed', closed_at: at, last_alert_at: alerted ? at : open.last_alert_at });
    if (!alerted) return null;
    return {
      kind: 'recovered',
      seriesId,
      signature: open.signature,
      reason: open.reason,
      failures: open.failures,
      openedAt: open.opened_at,
    };
  }

  if (open && open.signature === verdict.signature) {
    const failures = open.failures + 1;
    const since = open.last_alert_at ? now.getTime() - Date.parse(open.last_alert_at) : Infinity;
    // An incident opened quietly (inside the gap) is announced once the gap is up.
    const announced = !!open.last_alert_at && open.last_alert_at >= open.opened_at;
    const due = since >= (announced ? Math.max(hours * 3_600_000, ALERT_MIN_GAP_MS) : ALERT_MIN_GAP_MS);
    const next: TaskIncidentRow = {
      ...open,
      failures,
      reason: verdict.reason,
      last_failure_at: at,
      last_alert_at: due ? at : open.last_alert_at,
    };
    await saveIncident(next);
    return due
      ? {
          kind: announced ? 'reminder' : 'opened',
          seriesId,
          signature: next.signature,
          reason: next.reason,
          failures,
          openedAt: next.opened_at,
        }
      : null;
  }

  // A new incident (first failure, or a new signature) alerts unless the task
  // alerted within the gap: flapping or shifting failures are not a storm.
  const quiet = !!current?.last_alert_at && now.getTime() - Date.parse(current.last_alert_at) < ALERT_MIN_GAP_MS;
  const opened: TaskIncidentRow = {
    series_id: seriesId,
    agent_group_id: agentGroupId,
    state: 'open',
    signature: verdict.signature,
    reason: verdict.reason,
    failures: 1,
    opened_at: at,
    last_failure_at: at,
    last_alert_at: quiet ? current!.last_alert_at : at,
    closed_at: null,
  };
  await saveIncident(opened);
  if (quiet) return null;
  return { kind: 'opened', seriesId, signature: opened.signature, reason: opened.reason, failures: 1, openedAt: at };
}
