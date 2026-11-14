/**
 * How much of a machine NanoClaw may use. A machine
 * may run other things too — the first worker can be an existing app server —
 * so the share is worked out from what those other things use, not set by hand:
 *
 *   available = total − (current non-NanoClaw use × 1.2) − 1 GB and 0.25 CPU for the OS
 *
 * never below 0, recomputed on every health report (about every minute), so
 * stopping something on the machine frees room at once. The 20% buffer covers
 * other software growing a little; the fixed reserve keeps the operating
 * system itself running, so a dedicated worker offers nearly all of its box. An owner may set a lower cap; the smaller wins. Daily peaks are
 * still kept, to show, but no longer decide the share.
 */

/** Kept back for the operating system on every machine, whatever its size. */
export const OS_RESERVE_MB = 1024;
export const OS_RESERVE_CPUS = 0.25;
/** Room left for the other software to grow, on top of what it uses now. */
export const OTHER_BUFFER = 0.2;
export const PEAK_DAYS = 7;

/** Peak non-NanoClaw use per UTC day, 'YYYY-MM-DD' → { memMb, cpus }. */
export type Peaks = Record<string, { memMb: number; cpus: number }>;

export interface Totals {
  memMb: number;
  cpus: number;
}

/** One report's non-NanoClaw use (everything on the machine minus NanoClaw's own). */
export interface OtherUse {
  memMb: number;
  cpus: number;
}

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Fold one report into the daily peaks, keeping only the last PEAK_DAYS days. */
export function updatePeaks(peaks: Peaks, use: OtherUse, at: number): Peaks {
  const day = dayOf(at);
  const memMb = Math.max(0, use.memMb);
  const cpus = Math.max(0, use.cpus);
  const prev = peaks[day];
  const next: Peaks = {
    ...peaks,
    [day]: prev ? { memMb: Math.max(prev.memMb, memMb), cpus: Math.max(prev.cpus, cpus) } : { memMb, cpus },
  };
  const keep = Object.keys(next).sort().slice(-PEAK_DAYS);
  return Object.fromEntries(keep.map((d) => [d, next[d]!]));
}

export interface Available {
  memMb: number;
  cpus: number;
  /** Which limit applied per resource: the automatic share or the owner's cap. */
  memBy: 'auto' | 'cap';
  cpusBy: 'auto' | 'cap';
}

/** What NanoClaw may use on this machine now, given what other software uses now (null: no report yet). */
export function computeAvailable(
  totals: Totals,
  other: OtherUse | null,
  cap: { memMb: number | null; cpus: number | null } = { memMb: null, cpus: null },
): Available {
  const otherMem = Math.max(0, other?.memMb ?? 0) * (1 + OTHER_BUFFER);
  const otherCpu = Math.max(0, other?.cpus ?? 0) * (1 + OTHER_BUFFER);
  const autoMem = Math.max(0, Math.floor(totals.memMb - otherMem - OS_RESERVE_MB));
  // + 1e-9: 4 − 1.2 − 0.6 is 2.1999…, which must floor to 2.2, not 2.19.
  const autoCpu = Math.max(0, Math.floor((totals.cpus - otherCpu - OS_RESERVE_CPUS) * 100 + 1e-9) / 100);
  const memByCap = cap.memMb !== null && cap.memMb < autoMem;
  const cpuByCap = cap.cpus !== null && cap.cpus < autoCpu;
  return {
    memMb: memByCap ? Math.max(0, cap.memMb!) : autoMem,
    cpus: cpuByCap ? Math.max(0, cap.cpus!) : autoCpu,
    memBy: memByCap ? 'cap' : 'auto',
    cpusBy: cpuByCap ? 'cap' : 'auto',
  };
}
