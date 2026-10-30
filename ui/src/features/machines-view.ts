// Admin → Scaling → Machines: how a machine row reads. Pure, so it is tested
// without a DOM (machines-view.test.ts); MachinesPanel.vue renders it.

export interface MachineRow {
  id: string;
  name: string;
  role: string;
  state: 'ready' | 'draining' | 'revoked';
  healthy: boolean;
  facts: { cpus: number; memTotalMb: number; os?: string };
  health: {
    cpus: number;
    memTotalMb: number;
    memUsedMb: number;
    cpuUsed: number;
    diskTotalGb: number;
    diskFreeGb: number;
  } | null;
  lastReport: number | null;
  cap: { memMb: number | null; cpus: number | null };
  available: { memMb: number; cpus: number; memBy: 'auto' | 'cap'; cpusBy: 'auto' | 'cap' };
}

/** The one status word a row shows. */
export function statusOf(m: MachineRow): 'revoked' | 'draining' | 'offline' | 'ready' {
  if (m.state === 'revoked') return 'revoked';
  if (!m.healthy) return 'offline';
  return m.state === 'draining' ? 'draining' : 'ready';
}

const gb = (mb: number): string => `${Math.round((mb / 1024) * 10) / 10} GB`;

/** "2.1/16 GB · 0.4/4 CPU · 40 GB free" from the last report, or the join facts. */
export function usageLine(m: MachineRow): string {
  const h = m.health;
  if (!h) return `${gb(m.facts.memTotalMb)} · ${m.facts.cpus} CPU`;
  return `${gb(h.memUsedMb)}/${gb(h.memTotalMb).replace(' GB', '')} GB · ${h.cpuUsed}/${h.cpus} CPU · ${h.diskFreeGb} GB free`;
}

/** What NanoClaw may use: "12.4 GB, 2.6 CPU", with "(cap)" where the owner's cap applies. */
export function availableLine(m: MachineRow): string {
  const a = m.available;
  const mem = `${gb(a.memMb)}${a.memBy === 'cap' ? ' (cap)' : ''}`;
  const cpu = `${a.cpus} CPU${a.cpusBy === 'cap' ? ' (cap)' : ''}`;
  return `${mem}, ${cpu}`;
}

/** "just now", "5 min ago", "3 h ago", "never". */
export function ago(at: number | null, now = Date.now()): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** The cap form's values from a row: GB and CPUs as text, empty for none. */
export function capForm(m: MachineRow): { memGb: string; cpus: string } {
  return {
    memGb: m.cap.memMb === null ? '' : String(Math.round((m.cap.memMb / 1024) * 10) / 10),
    cpus: m.cap.cpus === null ? '' : String(m.cap.cpus),
  };
}
