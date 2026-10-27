/**
 * What the tailnet route remembers between runs, in one 0600 file under
 * DATA_DIR: which sidecar serves which published app, at which edge address,
 * as which tailnet device; and devices still to be removed from the tailnet
 * (an unpublish while the Tailscale API could not be reached).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../config.js';

export interface SidecarRecord {
  /** The app route's id (routes.ts). */
  routeId: string;
  app: string;
  /** Its fixed address on the edge network. */
  address: string;
  /** The tailnet device (stable node id), once it logged in. */
  nodeId: string | null;
}

export interface TailnetState {
  sidecars: Record<string, SidecarRecord>;
  /** Node ids of devices to remove from the tailnet. */
  pendingDeletes: string[];
}

export const tailnetDir = (): string => path.join(DATA_DIR, 'workload-tailnet');
const file = (): string => path.join(tailnetDir(), 'state.json');

const empty = (): TailnetState => ({ sidecars: {}, pendingDeletes: [] });

export function loadState(): TailnetState {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<TailnetState>;
    return {
      sidecars: raw.sidecars && typeof raw.sidecars === 'object' ? raw.sidecars : {},
      pendingDeletes: Array.isArray(raw.pendingDeletes) ? raw.pendingDeletes.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return empty();
  }
}

export function saveState(s: TailnetState): void {
  fs.mkdirSync(tailnetDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** The lowest free host address on the edge network, or null when all are taken. */
export function freeAddress(s: TailnetState, prefix: string, first: number, last: number): string | null {
  const used = new Set(Object.values(s.sidecars).map((r) => r.address));
  for (let i = first; i <= last; i++) if (!used.has(`${prefix}.${i}`)) return `${prefix}.${i}`;
  return null;
}
