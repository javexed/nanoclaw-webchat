// Periodic module housekeeping, fork-owned.
//
// Modules used to register a task on the host sweep's tick (a seam hook in
// host-sweep.ts). That hook was one of the fork's insertions into an upstream
// file; the tasks don't need the sweep's ordering guarantees (they run after
// core duties only for tidiness, never for correctness), so they run on their
// own interval here instead and the upstream file stays untouched.
//
// unref() so a pending timer never holds the process open; stopAllModuleSweeps
// is for test teardown and shutdown, mirroring the host sweep's stop path.
import { log } from './log.js';

const SWEEP_INTERVAL_MS = 60_000;
const timers = new Set<ReturnType<typeof setInterval>>();

export function registerModuleSweep(name: string, fn: () => Promise<void>, intervalMs = SWEEP_INTERVAL_MS): void {
  const run = async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.warn('Module sweep failed', { task: name, err: String(err) });
    }
  };
  const t = setInterval(() => void run(), intervalMs);
  t.unref?.();
  timers.add(t);
}

export function stopAllModuleSweeps(): void {
  for (const t of timers) clearInterval(t);
  timers.clear();
}
