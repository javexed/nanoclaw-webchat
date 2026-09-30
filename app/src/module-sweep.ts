// Periodic module housekeeping on its own interval: the tasks need none of the
// host sweep's ordering guarantees. unref() so the timer never holds the
// process open.
import { getDb } from './db/connection.js';
import { log } from './log.js';

const SWEEP_INTERVAL_MS = 60_000;

function dbOpen(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

export function registerModuleSweep(name: string, fn: () => Promise<void>, intervalMs = SWEEP_INTERVAL_MS): void {
  const run = async (): Promise<void> => {
    // Setup scripts load these modules too, before any database is open (and
    // shutdown closes it): there is nothing to sweep yet, so skip quietly.
    if (!dbOpen()) return;
    try {
      await fn();
    } catch (err) {
      log.warn('Module sweep failed', { task: name, err: String(err) });
    }
  };
  const t = setInterval(() => void run(), intervalMs);
  t.unref?.();
}
