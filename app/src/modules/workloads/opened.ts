/**
 * When people last opened a published app. The gateway's check (gateway/
 * internal.ts) reports every request it lets through; a page with forty
 * assets must not mean forty writes, so each app's time is written at most
 * once every OPENED_EVERY_MS. The expiry sweep (reconcile.ts) renews a
 * workload whose app was opened recently.
 */
import { log } from '../../log.js';
import { listRoutes, noteRouteOpened } from './routes.js';

/** At most one write per app this often. */
export const OPENED_EVERY_MS = 10 * 60_000;
/** An app opened this recently counts as used. */
export const USED_WITHIN_MS = 7 * 86_400_000;

const written = new Map<string, number>();

/**
 * Someone the gateway let in opened this app. Returns whether it was written
 * (false: written recently enough already). Never throws.
 */
export async function noteOpened(
  routeId: string,
  now = Date.now(),
  write: (id: string, at: number) => Promise<void> = noteRouteOpened,
): Promise<boolean> {
  const last = written.get(routeId);
  if (last !== undefined && now - last < OPENED_EVERY_MS) return false;
  if (written.size > 5000) written.clear();
  written.set(routeId, now);
  try {
    await write(routeId, now);
    return true;
  } catch (err) {
    written.delete(routeId);
    log.warn('Workload gateway: could not record an app as opened', { routeId, err: String(err).slice(0, 200) });
    return false;
  }
}

/** When any of the workload's published apps was last opened; null: none published, or never opened. */
export async function lastOpened(workloadId: string): Promise<number | null> {
  let at: number | null = null;
  for (const r of await listRoutes({ workloadId }))
    if (r.lastOpenedAt !== null && (at === null || r.lastOpenedAt > at)) at = r.lastOpenedAt;
  return at;
}

export function __resetOpenedForTest(): void {
  written.clear();
}
