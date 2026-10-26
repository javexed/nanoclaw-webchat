/**
 * Session retention wiring: the periodic prune and `ncl sessions prune`.
 * The rules live in src/session-retention.ts.
 *
 * The sweep rides the shared module tick but prunes at most every
 * PRUNE_EVERY_MS: the work is a full scan of the sessions table plus a disk
 * walk of each removable session, and nothing about it is urgent. VACUUM of
 * the central DB is rarer still (VACUUM_EVERY_MS), and only when a prune
 * removed something and a quarter of the file is free pages.
 */
import { renderVerbHelp } from '../../cli/help-render.js';
import { getResource, validateArgs, type CustomOperation } from '../../cli/crud.js';
import { normalizeArgs } from '../../cli/args.js';
import { lookup, register } from '../../cli/registry.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerModuleSweep } from '../../module-sweep.js';
import {
  formatBytes,
  MAX_KEEP_DAYS,
  pruneSessions,
  retentionDays,
  summarize,
  type PruneReport,
} from '../../session-retention.js';

const HOUR_MS = 60 * 60 * 1000;
export const PRUNE_EVERY_MS = 6 * HOUR_MS;
export const VACUUM_EVERY_MS = 7 * 24 * HOUR_MS;
/** The first prune waits this long after boot, clear of startup work. */
const FIRST_PRUNE_AFTER_MS = 10 * 60 * 1000;

let nextPruneAt = Date.now() + FIRST_PRUNE_AFTER_MS;
let lastVacuumAt = 0;
let running = false;

export async function retentionTick(now = Date.now()): Promise<PruneReport | null> {
  const days = retentionDays();
  if (days === 0 || running || now < nextPruneAt) return null;
  running = true;
  nextPruneAt = now + PRUNE_EVERY_MS;
  try {
    const report = await pruneSessions({ days, allowVacuum: now - lastVacuumAt >= VACUUM_EVERY_MS });
    if (report.vacuumed) lastVacuumAt = now;
    const fields = {
      removed: report.sessions.length,
      bytes: report.bytes,
      kept: report.kept,
      failed: report.errors.length,
      vacuumed: report.vacuumed,
    };
    if (report.errors.length) log.warn(`Session retention: ${summarize(report)}`, { ...fields, errors: report.errors });
    else log.info(`Session retention: ${summarize(report)}`, fields);
    return report;
  } finally {
    running = false;
  }
}

/** Test hook: make the next tick due. */
export function resetRetentionSchedule(): void {
  nextPruneAt = 0;
  lastVacuumAt = 0;
}

function formatReport(data: unknown): string {
  const r = data as PruneReport;
  const lines = [r.dryRun ? `Dry run: ${summarize(r)}` : summarize(r)];
  for (const s of r.sessions) {
    lines.push(
      [
        s.sessionId,
        s.agentGroupId,
        s.messagingGroupId ?? '-',
        s.threadId ?? '-',
        s.status,
        s.lastActivity,
        formatBytes(s.bytes),
      ].join('|'),
    );
  }
  for (const e of r.errors) lines.push(`failed: ${e.sessionId}: ${e.error}`);
  if (r.centralFreeRatio !== null) lines.push(`central DB free pages: ${Math.round(r.centralFreeRatio * 100)}%`);
  return lines.join('\n');
}

export const pruneOperation: CustomOperation = {
  access: 'open',
  hostOnly: true,
  description:
    'Remove sessions idle past the retention limit that nothing can resume.\n\n' +
    'Uses NANOCLAW_SESSION_KEEP_DAYS unless --days is given. A session goes only when its container is ' +
    'stopped, it has been idle that long, it is not the session its conversation would resume, nothing ' +
    'waits on it (mail, tasks, cards, approvals) and its webchat room is not pinned. --dry-run lists ' +
    'what would go and the bytes it holds without changing anything.',
  args: [
    { name: 'dry_run', type: 'boolean', description: 'List what would be removed; change nothing.', default: false },
    { name: 'days', type: 'number', description: 'Idle days before a session may go (overrides the setting).' },
  ],
  examples: ['ncl sessions prune --dry-run', 'ncl sessions prune --days 90'],
  handler: async (args) => {
    const days = args.days === undefined ? retentionDays() : Number(args.days);
    if (!Number.isInteger(days) || days < 0 || days > MAX_KEEP_DAYS) {
      throw new Error(`--days must be a whole number from 1 to ${MAX_KEEP_DAYS}`);
    }
    if (days === 0) {
      throw new Error('session retention is off: set NANOCLAW_SESSION_KEEP_DAYS in .env, or pass --days');
    }
    const report = await pruneSessions({ days, dryRun: args.dry_run === true });
    if (!report.dryRun) log.info(`Session retention (ncl): ${summarize(report)}`, { removed: report.sessions.length });
    return report;
  },
  formatHuman: formatReport,
};

/**
 * Add `prune` to the sessions resource. Runs at host start: the resource
 * registers when the CLI barrel loads, after the modules barrel imports this.
 */
export function registerSessionsPrune(): void {
  if (lookup('sessions-prune')) return;
  const sessions = getResource('sessions');
  if (!sessions) {
    log.warn('Session retention: no sessions resource; `ncl sessions prune` is unavailable');
    return;
  }
  sessions.customOperations = { ...sessions.customOperations, prune: pruneOperation };
  const declared = pruneOperation.args!;
  register({
    name: 'sessions-prune',
    action: 'sessions.prune',
    description: pruneOperation.description,
    access: pruneOperation.access,
    hostOnly: pruneOperation.hostOnly,
    resource: 'sessions',
    parseArgs: (raw) => {
      try {
        return validateArgs(declared, normalizeArgs(raw));
      } catch (e) {
        const usage = renderVerbHelp(sessions, 'prune');
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(usage ? `${msg}\n\n${usage}` : msg, { cause: e });
      }
    },
    handler: async (args, ctx) => pruneOperation.handler(args as Record<string, unknown>, ctx),
    formatHuman: pruneOperation.formatHuman,
  });
}

onHostStart(() => registerSessionsPrune());

registerModuleSweep('session-retention', async () => {
  await retentionTick();
});
