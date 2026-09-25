/**
 * Mailbox sync for a session placed on a developer's machine: we call central
 * over the relay the agent already uses for the model and for MCP.
 *
 * The agent's own code is untouched: it still reads and writes the session's
 * SQLite mailbox synchronously, from all three processes that share it. This
 * only moves rows in and out of that store.
 *
 * Runs only when central says the session is placed (NANOCLAW_MAILBOX_URL and
 * NANOCLAW_MAILBOX_TOKEN are in the spec). A local session has neither, so
 * nothing here starts and the host keeps delivering as it always has.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { getOutboundDb } from './sqlite/connection.js';
import { sqliteGetState, sqliteSetState } from './sqlite/operations.js';

const PULL_MS = Number(process.env.NANOCLAW_MAILBOX_PULL_MS || 1000);
/** How soon after a write we push. Short, because this is the reply latency. */
const PUSH_DEBOUNCE_MS = Number(process.env.NANOCLAW_MAILBOX_PUSH_MS || 150);
const BATCH = 200;
const STATE_PULLED = 'mailbox.relay.pulledSeq';
const STATE_PUSHED = 'mailbox.relay.pushedSeq';
const STATE_STATUS = 'mailbox.relay.statusSeq';
const STATE_ACKS = 'mailbox.relay.acksChanged';

const IN_COLUMNS = [
  'id',
  'seq',
  'kind',
  'timestamp',
  'status',
  'process_after',
  'recurrence',
  'series_id',
  'tries',
  'trigger',
  'platform_id',
  'channel_type',
  'thread_id',
  'content',
  'source_session_id',
  'on_wake',
] as const;
const OUT_COLUMNS = [
  'id',
  'seq',
  'in_reply_to',
  'timestamp',
  'deliver_after',
  'recurrence',
  'kind',
  'platform_id',
  'channel_type',
  'thread_id',
  'content',
] as const;

function log(msg: string): void {
  console.error(`[mailbox-sync] ${msg}`);
}

/**
 * The columns this container's schema actually has, intersected with the ones
 * central carries. A runner image is not always the same age as central: an
 * unknown column would otherwise make every insert fail, stranding the whole
 * mailbox rather than losing one field.
 */
const columnCache = new Map<string, readonly string[]>();
function columnsOf(db: { prepare: (sql: string) => { all: () => unknown[] } }, table: string, wanted: readonly string[]): readonly string[] {
  const cached = columnCache.get(table);
  if (cached) return cached;
  let present: Set<string>;
  try {
    present = new Set((db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name));
  } catch {
    present = new Set(wanted);
  }
  const cols = wanted.filter((c) => present.has(c));
  const dropped = wanted.filter((c) => !present.has(c));
  if (dropped.length) log(`this image's ${table} has no ${dropped.join(', ')}; carrying the rest`);
  columnCache.set(table, cols);
  return cols;
}

export function __resetColumnCacheForTest(): void {
  columnCache.clear();
}

/** Watermarks live in the session's own state, so a restart resumes rather than re-sends everything. */
function readMark(key: string): number {
  try {
    return Number(sqliteGetState(key)?.value ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeMark(key: string, value: number): void {
  try {
    sqliteSetState(key, String(value));
  } catch (err) {
    log(`could not record a watermark: ${String((err as Error).message)}`);
  }
}

export interface RelaySyncConfig {
  url: string;
  token: string;
  /** The session directory as this container sees it; inbox/ and outbox/ live under it. */
  workspaceDir?: string;
  /** A writable inbound.db handle; defaults to the one under workspaceDir. */
  openInbound?: () => Database;
}

/**
 * For a placed session this syncer is the one writer of inbound.db in the
 * container. The agent's own handle is read-only because for a local session
 * the host owns the file, so the syncer opens its own.
 */
function openInboundRw(workspace: string): Database {
  const db = new Database(path.join(workspace, 'inbound.db'));
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/** `inbox/<id>/<name>` or `outbox/<id>/<name>`, and nothing that could climb out. */
function safeRel(kind: 'inbox' | 'outbox', id: unknown, name: unknown): string | null {
  const ok = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x !== '.' && x !== '..' && !/[\\/\0]/.test(x);
  return ok(id) && ok(name) ? `${kind}/${id}/${name}` : null;
}

/** The attachments central saved for an inbound row (session-manager records them as `inbox/<id>/<name>`). */
export function inboxFilesOf(row: Record<string, unknown>): string[] {
  let content: { attachments?: Array<{ localPath?: unknown }> };
  try {
    content = JSON.parse(String(row.content ?? '')) as typeof content;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const a of Array.isArray(content?.attachments) ? content.attachments : []) {
    const parts = typeof a?.localPath === 'string' ? a.localPath.split('/') : [];
    const rel = parts.length === 3 && parts[0] === 'inbox' ? safeRel('inbox', parts[1], parts[2]) : null;
    if (rel) out.push(rel);
  }
  return out;
}

/** The files an outbound row declares (send_file writes them to `outbox/<row id>/<name>`). */
export function outboxFilesOf(row: Record<string, unknown>): string[] {
  let content: { files?: unknown[] };
  try {
    content = JSON.parse(String(row.content ?? '')) as typeof content;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of Array.isArray(content?.files) ? content.files : []) {
    const rel = safeRel('outbox', row.id, f);
    if (rel) out.push(rel);
  }
  return out;
}

export function relaySyncConfig(env: NodeJS.ProcessEnv = process.env): RelaySyncConfig | null {
  const url = (env.NANOCLAW_MAILBOX_URL || '').trim();
  const token = (env.NANOCLAW_MAILBOX_TOKEN || '').trim();
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export class RelayMailboxSync {
  #timer: NodeJS.Timeout | null = null;
  #pushTimer: NodeJS.Timeout | null = null;
  #inflight: Promise<void> | null = null;
  #stopped = false;
  #pulled = 0;
  #pushed = 0;
  #status = 0;
  /** (status_changed, message_id) of the last verdict handed over — processing_ack has no sequence, and timestamps repeat. */
  #acksChanged = '';
  #acksLastId = '';
  #failures = 0;

  constructor(
    private readonly cfg: RelaySyncConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    this.#pulled = readMark(STATE_PULLED);
    this.#pushed = readMark(STATE_PUSHED);
    this.#status = readMark(STATE_STATUS);
    try {
      [this.#acksChanged = '', this.#acksLastId = ''] = String(sqliteGetState(STATE_ACKS)?.value ?? '').split('\n');
    } catch {
      this.#acksChanged = '';
    }
    log(`syncing with central over the relay (from inbound seq ${this.#pulled}, outbound seq ${this.#pushed})`);
    this.#timer = setInterval(() => void this.tick(), PULL_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  /** The agent wrote something: push it now rather than on the next tick. */
  nudge(): void {
    if (this.#stopped || this.#pushTimer) return;
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = null;
      void this.tick();
    }, PUSH_DEBOUNCE_MS);
    this.#pushTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#timer = this.#pushTimer = null;
    await this.#inflight?.catch(() => {}); // let whatever is in flight land
    await this.tick().catch(() => {}); // a final flush, then no more
    this.#stopped = true;
  }

  /**
   * One exchange with central. When one is already in flight this awaits THAT
   * one rather than returning at once: a caller that awaits a tick means "the
   * sync has happened", and the final flush in stop() would otherwise skip
   * silently and lose an answer written a moment earlier.
   */
  async tick(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    if (this.#stopped) return;
    this.#inflight = (async () => {
      try {
        await this.push();
        await this.pushStatus();
        await this.pushAcks();
        await this.pull();
        this.#failures = 0;
      } catch (err) {
        // Central being briefly unreachable is normal (the relay re-attaches);
        // say so once in a while rather than every second.
        if (this.#failures++ % 30 === 0) log(`sync failed (${this.#failures}): ${String((err as Error).message).slice(0, 200)}`);
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }

  get #workspace(): string {
    return this.cfg.workspaceDir ?? '/workspace';
  }

  /** A call to central's mailbox route; `json` is sent as the body. */
  #call(route: string, init: { method?: string; json?: unknown; bytes?: Buffer } = {}): Promise<Response> {
    const headers: Record<string, string> = { 'X-NanoClaw-Mailbox': this.cfg.token };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.bytes) {
      headers['Content-Type'] = 'application/octet-stream';
      body = new Uint8Array(init.bytes);
    }
    return this.fetchImpl(`${this.cfg.url}/mailbox/${route}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  }

  /**
   * Files a row names travel before the row does: central delivers a row the
   * moment it lands, and a file message whose file is not there yet would go
   * out without it. A file that is missing at the source is logged and
   * skipped — one lost attachment must not wedge the whole mailbox.
   */
  private async uploadFiles(rows: Array<Record<string, unknown>>): Promise<void> {
    for (const row of rows) {
      for (const rel of outboxFilesOf(row)) {
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(path.join(this.#workspace, rel));
        } catch {
          log(`${rel} is declared but not on disk; sending the message without it`);
          continue;
        }
        const res = await this.#call(`file?path=${encodeURIComponent(rel)}`, { method: 'PUT', bytes });
        if (!res.ok) throw new Error(`file upload HTTP ${res.status} for ${rel}`);
        log(`sent ${rel} (${bytes.length} bytes) to central`);
      }
    }
  }

  private async downloadFiles(rows: Array<Record<string, unknown>>): Promise<void> {
    for (const row of rows) {
      for (const rel of inboxFilesOf(row)) {
        const dest = path.join(this.#workspace, rel);
        if (fs.existsSync(dest)) continue; // a previous pull got it
        const res = await this.#call(`file?path=${encodeURIComponent(rel)}`);
        if (res.status === 404) {
          log(`central has no ${rel}; the message arrives without it`);
          continue;
        }
        if (!res.ok) throw new Error(`file download HTTP ${res.status} for ${rel}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.part`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, dest);
        log(`took ${rel} (${bytes.length} bytes) from central`);
      }
    }
  }

  /** Answers the agent wrote, handed to central. */
  private async push(): Promise<void> {
    const db = getOutboundDb();
    const cols = columnsOf(db, 'messages_out', OUT_COLUMNS);
    const rows = db
      .prepare(`SELECT ${cols.join(',')} FROM messages_out WHERE seq > ? ORDER BY seq LIMIT ?`)
      .all(this.#pushed, BATCH) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    await this.uploadFiles(rows);
    const res = await this.#call('outbound', { json: { rows } });
    if (!res.ok) throw new Error(`outbound HTTP ${res.status}`);
    this.#pushed = Number(rows[rows.length - 1].seq ?? this.#pushed);
    writeMark(STATE_PUSHED, this.#pushed);
    log(`handed ${rows.length} answer(s) to central`);
  }

  /**
   * The agent's activity (status-feed.ts writes it to status_events in this
   * outbound db). For a local session central tails the file directly; here
   * it lives on the laptop, so without this no thinking bubble ever showed —
   * not in the PWA, not in the editor.
   */
  private async pushStatus(): Promise<void> {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = getOutboundDb()
        .prepare('SELECT seq, kind, text, detail, created_at FROM status_events WHERE seq > ? ORDER BY seq LIMIT ?')
        .all(this.#status, BATCH) as Array<Record<string, unknown>>;
    } catch {
      return; // no status_events yet: the feed creates it on its first event
    }
    if (rows.length === 0) return;
    const res = await this.#call('status', { json: { rows } });
    if (!res.ok) throw new Error(`status HTTP ${res.status}`);
    this.#status = Number(rows[rows.length - 1].seq ?? this.#status);
    writeMark(STATE_STATUS, this.#status);
  }

  /**
   * Which messages the agent finished. Central decides a message is still due
   * from these (processing_ack in the outbound db); a laptop's stayed on the
   * laptop, so central kept waking a session that had nothing left to do.
   */
  private async pushAcks(): Promise<void> {
    const acks = getOutboundDb()
      .prepare(
        `SELECT message_id, status, status_changed FROM processing_ack
         WHERE status IN ('completed', 'failed', 'script-skip:error')
           AND (status_changed > ? OR (status_changed = ? AND message_id > ?))
         ORDER BY status_changed, message_id LIMIT ?`,
      )
      .all(this.#acksChanged, this.#acksChanged, this.#acksLastId, BATCH) as Array<{
      message_id: string;
      status: string;
      status_changed: string;
    }>;
    if (acks.length === 0) return;
    const res = await this.#call('acks', { json: { acks } });
    if (!res.ok) throw new Error(`acks HTTP ${res.status}`);
    this.#acksChanged = acks[acks.length - 1].status_changed;
    this.#acksLastId = acks[acks.length - 1].message_id;
    try {
      sqliteSetState(STATE_ACKS, `${this.#acksChanged}\n${this.#acksLastId}`);
    } catch (err) {
      log(`could not record the acks watermark: ${String((err as Error).message)}`);
    }
  }

  /** Messages central holds for this agent, written where its poll loop looks. */
  private async pull(): Promise<void> {
    const res = await this.#call(`inbound?after=${this.#pulled}`);
    if (!res.ok) throw new Error(`inbound HTTP ${res.status}`);
    const body = (await res.json()) as { rows?: Array<Record<string, unknown>> };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) return;
    // The agent reads an attachment the moment it sees the row: fetch first.
    await this.downloadFiles(rows);
    const db = this.cfg.openInbound?.() ?? openInboundRw(this.#workspace);
    try {
      const cols = columnsOf(db, 'messages_in', IN_COLUMNS);
      // Insert only the fields a row actually carries. Binding null for an
      // absent one overrides the column's default, and a NOT NULL column then
      // makes INSERT OR IGNORE drop the whole row in silence. Statements are
      // cached per column set, so a uniform batch prepares once.
      const stmts = new Map<string, ReturnType<typeof db.prepare>>();
      const insert = db.transaction((batch: Array<Record<string, unknown>>) => {
        for (const r of batch) {
          const present = cols.filter((c) => r[c] !== undefined && r[c] !== null);
          if (present.length === 0) continue;
          const sig = present.join(',');
          let stmt = stmts.get(sig);
          if (!stmt) {
            stmt = db.prepare(`INSERT OR IGNORE INTO messages_in (${sig}) VALUES (${present.map((c) => `$${c}`).join(',')})`);
            stmts.set(sig, stmt);
          }
          // Column values arrive as JSON from central: strings, numbers, booleans (nulls were filtered above).
          const bound: Record<string, string | number | bigint | boolean | null> = {};
          for (const c of present) bound[`$${c}`] = r[c] as string | number | boolean;
          stmt.run(bound);
        }
      });
      insert(rows);
      this.#pulled = Number(rows[rows.length - 1].seq ?? this.#pulled);
      writeMark(STATE_PULLED, this.#pulled);
      log(`took ${rows.length} message(s) from central`);
    } finally {
      db.close();
    }
  }
}

let active: RelayMailboxSync | null = null;

/** Start syncing when this session is placed on a machine; a no-op otherwise. */
export function startRelayMailboxSync(env: NodeJS.ProcessEnv = process.env): RelayMailboxSync | null {
  if (active) return active;
  const cfg = relaySyncConfig(env);
  if (!cfg) return null;
  active = new RelayMailboxSync(cfg);
  active.start();
  return active;
}

/** The agent produced output: ask for a prompt push. Safe to call when not placed. */
export function nudgeRelayMailboxSync(): void {
  active?.nudge();
}

export async function stopRelayMailboxSync(): Promise<void> {
  const a = active;
  active = null;
  await a?.stop();
}
