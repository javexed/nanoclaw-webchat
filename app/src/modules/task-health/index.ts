/**
 * Scheduled-task failure handling — the vocabulary core's scheduler lacks:
 * which runs failed and why, which are worth retrying, and when the task's
 * owner should hear about it.
 *
 *   policy.ts    — per task session, at the top of each reconcile pass:
 *                  retry runs that never reached the model (+5/+15/+30 min,
 *                  then give up the slot), fail runs that died after reaching
 *                  it, classify finished runs.
 *   incidents.ts — one alert per incident, a reminder at most every N hours,
 *                  a recovery notice.
 *   notify.ts    — the alert's destination: the chat the task came from, else
 *                  the agent group's approvers.
 *   cli.ts       — `ncl tasks fail`, and `health` on `ncl tasks get`.
 *
 * The container half is container/agent-runner/src/task-run-marks.ts.
 */
import { onHostStart } from '../../host-lifecycle.js';
import { registerModuleSweep } from '../../module-sweep.js';
import { installTaskHealthCli } from './cli.js';
import { pruneFinishedRuns } from './store.js';

export { applyTaskRunPolicy } from './policy.js';

/** Finished run records are kept this long; incidents are kept until the task is deleted. */
const RUN_RECORD_DAYS = 30;

onHostStart(() => {
  installTaskHealthCli();
});

registerModuleSweep(
  'task-health-prune',
  () => pruneFinishedRuns(new Date(Date.now() - RUN_RECORD_DAYS * 86_400_000).toISOString()),
  60 * 60_000,
);
