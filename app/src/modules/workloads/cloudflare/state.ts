/**
 * What the Cloudflare route remembers between runs, in one 0600 file under
 * DATA_DIR: this install's tunnel, the catch-all Access application, each
 * published app's Access application (and its audience), DNS record and
 * policy, and things still to be deleted in Cloudflare (an unpublish while
 * the API could not be reached). The connector token lives beside it in its
 * own 0600 file (connector.ts), never in here.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../config.js';

export interface AppRecord {
  /** The app route's id (routes.ts). */
  routeId: string;
  app: string;
  hostname: string;
  accessAppId: string | null;
  /** The Access application's audience: the only `aud` this app's tokens are accepted with. */
  aud: string | null;
  dnsRecordId: string | null;
  /** A hash of the application last written, so a membership change is noticed. */
  policyHash: string | null;
  /** When it was last written (re-written hourly, so a change made in the dashboard does not stay). */
  syncedAt: number;
}

export interface PendingDelete {
  kind: 'access' | 'dns';
  id: string;
  accountId: string;
  zoneId: string;
}

export interface CloudflareState {
  tunnelId: string | null;
  /** The account the tunnel and applications are in (a changed setting starts over). */
  accountId: string | null;
  /** The zone the DNS records are in. */
  zoneId: string | null;
  catchAllAppId: string | null;
  catchAllDomain: string | null;
  apps: Record<string, AppRecord>;
  /** The hostnames the tunnel's ingress routes now, and a hash of the whole ingress last set. */
  ingressHosts: string[];
  ingressHash: string | null;
  pendingDeletes: PendingDelete[];
}

export const cloudflareDir = (): string => path.join(DATA_DIR, 'workload-cloudflare');
const file = (): string => path.join(cloudflareDir(), 'state.json');

const empty = (): CloudflareState => ({
  tunnelId: null,
  accountId: null,
  zoneId: null,
  catchAllAppId: null,
  catchAllDomain: null,
  apps: {},
  ingressHosts: [],
  ingressHash: null,
  pendingDeletes: [],
});

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function loadState(): CloudflareState {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<CloudflareState>;
    return {
      tunnelId: str(raw.tunnelId),
      accountId: str(raw.accountId),
      zoneId: str(raw.zoneId),
      catchAllAppId: str(raw.catchAllAppId),
      catchAllDomain: str(raw.catchAllDomain),
      apps: raw.apps && typeof raw.apps === 'object' ? raw.apps : {},
      ingressHosts: Array.isArray(raw.ingressHosts) ? raw.ingressHosts.filter((h) => typeof h === 'string') : [],
      ingressHash: str(raw.ingressHash),
      pendingDeletes: Array.isArray(raw.pendingDeletes)
        ? raw.pendingDeletes.filter(
            (p): p is PendingDelete =>
              !!p &&
              (p.kind === 'access' || p.kind === 'dns') &&
              typeof p.id === 'string' &&
              typeof p.accountId === 'string' &&
              typeof p.zoneId === 'string',
          )
        : [],
    };
  } catch {
    return empty();
  }
}

export function saveState(s: CloudflareState): void {
  fs.mkdirSync(cloudflareDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** Change the state file in one read-modify-write. */
export function updateState(fn: (s: CloudflareState) => void): CloudflareState {
  const s = loadState();
  fn(s);
  saveState(s);
  return s;
}
