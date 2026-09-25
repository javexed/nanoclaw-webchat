/**
 * What central must remember about sessions placed on developer machines
 * across its own restarts.
 *
 * A laptop's container outlives a central deploy. Everything central held
 * about it lived in memory, so every restart stranded it: the container's
 * mailbox token was no longer honoured, the relay had no target for it (the
 * agent's calls were refused once a second), a machine away lost its hold,
 * and a stop queued for that machine was forgotten. This keeps the few facts
 * needed to pick such a session back up — never a credential for anything but
 * that one session's mailbox, which only central's loopback relay hop reaches.
 *
 * A small JSON file beside central's database, written atomically, readable by
 * this user only. One install, one writer.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { SessionKey } from '../../drivers/types.js';
import { log } from '../../log.js';

export interface PlacedRecord {
  key: SessionKey;
  fingerprint: string;
  /** The session's mailbox token, as its container's environment carries it. */
  token: string;
  /** The container's name on that machine, once realized. */
  name?: string;
  /** When the machine became unavailable; absent while it is reachable. */
  suspendedSince?: number;
}

interface StoreFile {
  v: 1;
  sessions: Record<string, PlacedRecord>;
  /** fingerprint → container name → reason: stops issued while that machine was away. */
  pendingStops: Record<string, Record<string, string>>;
}

export const placedKeyId = (k: SessionKey): string => `${k.installSlug} ${k.agentGroupId} ${k.sessionId}`;

export class RunnerSessionStore {
  #data: StoreFile = { v: 1, sessions: {}, pendingStops: {} };

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreFile>;
      if (raw && raw.v === 1) {
        this.#data = { v: 1, sessions: raw.sessions ?? {}, pendingStops: raw.pendingStops ?? {} };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Runner session store unreadable — starting empty', { file, err: String((err as Error).message) });
      }
    }
  }

  get(key: SessionKey): PlacedRecord | undefined {
    return this.#data.sessions[placedKeyId(key)];
  }
  byToken(token: string): PlacedRecord | undefined {
    return Object.values(this.#data.sessions).find((r) => r.token === token);
  }
  byFingerprint(fingerprint: string): PlacedRecord[] {
    return Object.values(this.#data.sessions).filter((r) => r.fingerprint === fingerprint);
  }
  all(): PlacedRecord[] {
    return Object.values(this.#data.sessions);
  }
  put(rec: PlacedRecord): void {
    this.#data.sessions[placedKeyId(rec.key)] = rec;
    this.#save();
  }
  update(key: SessionKey, patch: Partial<Pick<PlacedRecord, 'suspendedSince' | 'fingerprint' | 'name'>>): void {
    const rec = this.get(key);
    if (!rec) return;
    const next: PlacedRecord = { ...rec, ...patch };
    if (patch.suspendedSince === undefined && 'suspendedSince' in patch) delete next.suspendedSince;
    this.#data.sessions[placedKeyId(key)] = next;
    this.#save();
  }
  delete(key: SessionKey): void {
    if (!this.#data.sessions[placedKeyId(key)]) return;
    delete this.#data.sessions[placedKeyId(key)];
    this.#save();
  }

  stops(fingerprint: string): Record<string, string> {
    return { ...(this.#data.pendingStops[fingerprint] ?? {}) };
  }
  allStops(): Record<string, Record<string, string>> {
    return JSON.parse(JSON.stringify(this.#data.pendingStops)) as Record<string, Record<string, string>>;
  }
  setStop(fingerprint: string, name: string, reason: string): void {
    (this.#data.pendingStops[fingerprint] ??= {})[name] = reason;
    this.#save();
  }
  clearStop(fingerprint: string, name: string): void {
    const m = this.#data.pendingStops[fingerprint];
    if (!m || !(name in m)) return;
    delete m[name];
    if (Object.keys(m).length === 0) delete this.#data.pendingStops[fingerprint];
    this.#save();
  }

  #save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Memory still holds the truth for this process; only a restart would lose it.
      log.warn('Runner session store write failed', { file: this.file, err: String((err as Error).message) });
    }
  }
}

let store: RunnerSessionStore | null = null;

/** The install's store (data/runner-sessions.json). */
export function runnerSessionStore(): RunnerSessionStore {
  // Under the test runner nothing is written unless a test asks for a file.
  store ??= new RunnerSessionStore(process.env.VITEST ? null : path.join(DATA_DIR, 'runner-sessions.json'));
  return store;
}

/** Tests: an in-memory (null) or file-backed store, or null to reset. */
export function __setRunnerSessionStoreForTest(s: RunnerSessionStore | null): void {
  store = s;
}
