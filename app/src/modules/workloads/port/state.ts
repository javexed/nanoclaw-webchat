/**
 * Which app holds which port: `data/workload-gateway/ports.json` (0600). A
 * port is given when an app's address is first asked for (the card shows
 * it), kept while the app is published, and given back when it is
 * unpublished, or after a week when no app took it up (a card nobody
 * approved).
 */
import fs from 'fs';
import path from 'path';

import { gatewayDir } from '../gateway/keys.js';

export interface PortState {
  /** app name → its port and when it was given. */
  apps: Record<string, { port: number; at: number }>;
}

const file = (): string => path.join(gatewayDir(), 'ports.json');

export function loadPorts(): PortState {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8')) as PortState;
    if (j && typeof j.apps === 'object' && j.apps) return { apps: j.apps };
  } catch {
    // none yet, or unreadable: start empty
  }
  return { apps: {} };
}

export function savePorts(s: PortState): void {
  fs.mkdirSync(gatewayDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** The app's port when it still may use it, else the lowest usable port no other app holds. Pure. */
export function pickPort(s: PortState, app: string, usable: number[]): number | null {
  const mine = s.apps[app]?.port;
  if (mine !== undefined && usable.includes(mine)) return mine;
  const taken = new Set(
    Object.entries(s.apps)
      .filter(([a]) => a !== app)
      .map(([, v]) => v.port),
  );
  return usable.find((p) => !taken.has(p)) ?? null;
}
