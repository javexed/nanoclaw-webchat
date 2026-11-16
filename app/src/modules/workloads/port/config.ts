/**
 * The tailnet ports route's settings (docs/webchat/workloads.md, "Tailnet
 * ports route"). Off unless NANOCLAW_WORKLOAD_PORTS names the ports to hand
 * out, e.g. `9001-9010`. Pure: tested on its own.
 */
import { workloadSetting, type WorkloadEnvKey } from '../settings.js';

/** What Admin → Publishing writes when the owner switches the route on. */
export const DEFAULT_PORTS = '9001-9010';
/** One app per port: more than this is not a personal install's need, and each is a serve entry. */
export const MAX_PORTS = 50;

export type PortSettings =
  { on: false } | { on: true; ok: true; ports: number[]; range: string } | { on: true; ok: false; reason: string };

const BAD = 'NANOCLAW_WORKLOAD_PORTS must be one port or a range of ports from 1024 to 65535, e.g. 9001-9010';

/** `9001-9010` or `9001`: the ports, in order. Null when it is not one of those. */
export function parsePorts(v: string): number[] | null {
  const m = /^(\d{4,5})(?:\s*-\s*(\d{4,5}))?$/.exec(v.trim());
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (lo < 1024 || hi > 65535 || hi < lo || hi - lo + 1 > MAX_PORTS) return null;
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

export function portSettings(get: (k: WorkloadEnvKey) => string | undefined = workloadSetting): PortSettings {
  const raw = get('NANOCLAW_WORKLOAD_PORTS');
  if (!raw) return { on: false };
  const ports = parsePorts(raw);
  if (!ports) return { on: true, ok: false, reason: `${BAD} (at most ${MAX_PORTS})` };
  const range = ports.length === 1 ? String(ports[0]) : `${ports[0]}-${ports[ports.length - 1]}`;
  return { on: true, ok: true, ports, range };
}
