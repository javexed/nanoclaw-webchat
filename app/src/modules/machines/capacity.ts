/**
 * How much of a machine NanoClaw may use. A machine
 * may run other things too — the first worker can be an existing app server —
 * so the share is worked out from what those other things use, not set by hand:
 *
 *   available = total − peak non-NanoClaw use over the last 7 days − 15% of total
 *
 * never below 0, recomputed on every health report. Until 7 days of reports
 * exist, the peak so far is used. An owner may set a lower cap; the smaller wins.
 */

export const HEADROOM = 0.15;
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

/** What NanoClaw may use on this machine now. */
export function computeAvailable(
  totals: Totals,
  peaks: Peaks,
  cap: { memMb: number | null; cpus: number | null } = { memMb: null, cpus: null },
): Available {
  const days = Object.values(peaks);
  const peakMem = days.reduce((m, d) => Math.max(m, d.memMb), 0);
  const peakCpu = days.reduce((m, d) => Math.max(m, d.cpus), 0);
  const autoMem = Math.max(0, Math.floor(totals.memMb - peakMem - HEADROOM * totals.memMb));
  const autoCpu = Math.max(0, Math.floor((totals.cpus - peakCpu - HEADROOM * totals.cpus) * 100) / 100);
  const memByCap = cap.memMb !== null && cap.memMb < autoMem;
  const cpuByCap = cap.cpus !== null && cap.cpus < autoCpu;
  return {
    memMb: memByCap ? Math.max(0, cap.memMb!) : autoMem,
    cpus: cpuByCap ? Math.max(0, cap.cpus!) : autoCpu,
    memBy: memByCap ? 'cap' : 'auto',
    cpusBy: cpuByCap ? 'cap' : 'auto',
  };
}
